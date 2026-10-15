// Admin-only diagnostics + one-time cleanup (same pattern as auth-diagnose).
// Test mode only. Never logs or returns the secret key.
//
// Actions:
//  (default)       — probe test MoMo numbers / source values (diagnostics)
//  cleanup_duplicate — refund the accidental duplicate TEST charge, mark it
//                      REFUNDED, remove its payout/commission records, and
//                      repair the escrow mirror on the legacy payments row.
import {
  authorize,
  corsHeaders,
  createAdminClient,
  errorResponse,
  json,
  requireAuth,
} from "../_shared/auth.ts";
import { PAYSTACK_BASE, paystackSecretKey } from "../_shared/paystack.ts";

const PROBE_TXN_ID = "f6e67994-6591-4423-84ee-447bfd152c00";
const SUCCESS_TXN_REF = "PBTX-1789836330850-8ABCD969"; // first, legitimate charge
const DUPLICATE_TXN_REF = "PBTX-1789836377927-693D48A0"; // accidental re-charge
const LEGACY_PAYMENT_ID = "6d5842b1-8110-400a-a62f-579b7551e226";
const PROBE_NOTE = "paystack-debug source probe";

const CANDIDATE_SOURCES = [
  "SYSTEM",
  "WEBHOOK",
  "VERIFY",
  "ADMIN",
  "API",
  "PAYOUT",
  "MANUAL",
  "REFUND",
] as const;

const CANDIDATE_PHONES = ["0551234987", "0240000000", "0200000000", "0270000000"] as const;

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 400);
  }
}

async function probeSources(admin: ReturnType<typeof createAdminClient>) {
  const sourceProbes: { source: string; ok: boolean; error?: string }[] = [];
  const insertedIds: string[] = [];
  for (const source of CANDIDATE_SOURCES) {
    const { data, error } = await admin
      .from("payment_status_history")
      .insert({
        transaction_id: PROBE_TXN_ID,
        entity: "TRANSACTION",
        old_status: "FAILED",
        new_status: "FAILED",
        note: PROBE_NOTE,
        source,
        changed_by: null,
      })
      .select("id");
    if (error) {
      sourceProbes.push({ source, ok: false, error: `${error.code}: ${error.message}` });
    } else {
      for (const row of data ?? []) insertedIds.push((row as { id: string }).id);
      sourceProbes.push({ source, ok: true });
    }
  }
  if (insertedIds.length > 0) {
    await admin.from("payment_status_history").delete().in("id", insertedIds);
  }
  return sourceProbes;
}

async function cleanupDuplicate(
  admin: ReturnType<typeof createAdminClient>,
  headers: Record<string, string>,
) {
  const result: Record<string, unknown> = {};

  // 1) Refund the duplicate charge at Paystack (test mode).
  const refundResp = await fetch(`${PAYSTACK_BASE}/refund`, {
    method: "POST",
    headers,
    body: JSON.stringify({ transaction: DUPLICATE_TXN_REF }),
  });
  result.refund = { http_status: refundResp.status, body: tryParse(await refundResp.text()) };

  // 2) Mark the duplicate REFUNDED locally (service role, audit-safe).
  const { data: dupTxn } = await admin
    .from("payment_transactions")
    .select("id, status")
    .eq("reference", DUPLICATE_TXN_REF)
    .maybeSingle();
  if (dupTxn) {
    const dupId = (dupTxn as { id: string }).id;
    const oldStatus = (dupTxn as { status: string }).status;
    const { error: updError } = await admin
      .from("payment_transactions")
      .update({
        status: "REFUNDED",
        payout_status: "NONE",
        failure_reason: "Duplicate TEST charge refunded and cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", dupId);
    result.duplicate_update = updError ? { error: updError.message } : "ok";

    // 3) Remove the duplicate's payout obligation and commission record.
    const { error: payoutDelError } = await admin
      .from("payout_records")
      .delete()
      .eq("transaction_id", dupId);
    const { error: commDelError } = await admin
      .from("platform_commissions")
      .delete()
      .eq("transaction_id", dupId);
    result.duplicate_records_deleted = {
      payout: payoutDelError ? payoutDelError.message : "ok",
      commission: commDelError ? commDelError.message : "ok",
    };

    // 4) History row for the refund transition.
    const { error: histError } = await admin.from("payment_status_history").insert({
      transaction_id: dupId,
      entity: "TRANSACTION",
      old_status: oldStatus,
      new_status: "REFUNDED",
      note: "Duplicate TEST charge refunded (cleanup)",
      source: "ADMIN",
      changed_by: null,
    });
    result.duplicate_history = histError ? histError.message : "ok";
  } else {
    result.duplicate_update = "transaction not found";
  }

  // 5) Repair the escrow mirror the broken settleChargeSuccess never wrote.
  const { data: okTxn } = await admin
    .from("payment_transactions")
    .select("id, paid_at")
    .eq("reference", SUCCESS_TXN_REF)
    .maybeSingle();
  if (okTxn) {
    const { error: mirrorError } = await admin
      .from("payments")
      .update({
        status: "HELD",
        paid_at: (okTxn as { paid_at: string | null }).paid_at,
        failure_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", LEGACY_PAYMENT_ID);
    result.escrow_mirror = mirrorError ? mirrorError.message : "ok";
  } else {
    result.escrow_mirror = "success transaction not found";
  }

  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const user = await requireAuth(req);
    const admin = createAdminClient();
    await authorize(admin, user.id, { permission: "PAYMENT_MANAGE" });

    const secret = paystackSecretKey();
    if (!secret || secret.mode !== "test") {
      return json({ error: "DEBUG_REQUIRES_TEST_MODE", configured: Boolean(secret) }, 400);
    }

    const headers = {
      Authorization: `Bearer ${secret.key}`,
      "Content-Type": "application/json",
    };

    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action === "cleanup_duplicate") {
      return json({ cleanup: await cleanupDuplicate(admin, headers) });
    }

    // Default: probe candidate test phone numbers and source values.
    const phoneProbes = await Promise.all(
      CANDIDATE_PHONES.map(async (phone) => {
        const reference = `DBG${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const resp = await fetch(`${PAYSTACK_BASE}/charge`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            email: "debug@demo.portbackhaul.app",
            amount: 10000,
            currency: "GHS",
            reference,
            mobile_money: { phone, provider: "mtn" },
            metadata: { debug: true },
          }),
        });
        const parsed = tryParse(await resp.text()) as
          | { status?: boolean; message?: string; data?: { status?: string; message?: string } }
          | null;
        return {
          phone,
          http_status: resp.status,
          top_message: parsed?.message ?? null,
          data_status: parsed?.data?.status ?? null,
          data_message: parsed?.data?.message ?? null,
        };
      }),
    );
    const sourceProbes = await probeSources(admin);

    return json({ phone_probes: phoneProbes, source_probes: sourceProbes });
  } catch (err) {
    return errorResponse(err);
  }
});
