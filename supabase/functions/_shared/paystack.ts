import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Shared Paystack helpers for the MoMo payment functions.
 *
 * Secrets live only in the Edge Function environment:
 *  - PAYSTACK_SECRET_KEY          (test or live key — the prefix decides)
 *  - PAYSTACK_SECRET_KEY_TEST     (optional dedicated test key)
 *  - PAYSTACK_MODE                (optional: "test" | "live", default "test")
 *  - PAYSTACK_WEBHOOK_SECRET      (optional; Paystack signs webhooks with the
 *                                  secret key, so this falls back to it)
 *
 * Nothing here is ever importable from frontend code.
 */

export const PAYSTACK_BASE = "https://api.paystack.co";

/** Canonical networks stored in the DB, mapped to Paystack API codes. */
export const MOMO_NETWORKS = {
  MTN: { chargeProvider: "mtn", bankCode: "MTN" },
  TELECEL: { chargeProvider: "vod", bankCode: "VOD" },
  AIRTEL_TIGO: { chargeProvider: "atl", bankCode: "ATL" },
} as const;

export type MomoNetwork = keyof typeof MOMO_NETWORKS;

export function isMomoNetwork(value: unknown): value is MomoNetwork {
  return typeof value === "string" && (value in MOMO_NETWORKS || value === "mtn" || value === "vod" || value === "atl");
}

/** Maps any accepted client value onto the canonical DB value. */
export function canonicalNetwork(value: string): MomoNetwork {
  const upper = value.toUpperCase();
  if (upper in MOMO_NETWORKS) return upper as MomoNetwork;
  const map: Record<string, MomoNetwork> = { mtn: "MTN", vod: "TELECEL", atl: "AIRTEL_TIGO" };
  return map[value.toLowerCase()] ?? "MTN";
}

/** Which key to use: PAYSTACK_MODE selects test/live; falls back sensibly. */
export function paystackSecretKey(): { key: string; mode: "test" | "live" } | null {
  const mode = (Deno.env.get("PAYSTACK_MODE") ?? "").toLowerCase() === "live" ? "live" : "test";
  const testKey = Deno.env.get("PAYSTACK_SECRET_KEY_TEST") ?? null;
  const genericKey = Deno.env.get("PAYSTACK_SECRET_KEY") ?? null;

  if (mode === "live") {
    // A live key must be an sk_live_ key; never silently charge against test.
    if (genericKey?.startsWith("sk_live_")) return { key: genericKey, mode: "live" };
    return null;
  }
  if (testKey?.startsWith("sk_test_")) return { key: testKey, mode: "test" };
  if (genericKey?.startsWith("sk_test_")) return { key: genericKey, mode: "test" };
  // A live key without PAYSTACK_MODE=live is not used automatically.
  return null;
}

/** Key used to verify webhook signatures. */
export function webhookSigningKey(): string | null {
  return Deno.env.get("PAYSTACK_WEBHOOK_SECRET") ?? paystackSecretKey()?.key ?? null;
}

export interface PaystackResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
}

/** Authenticated Paystack API call. Never logs the key or full payload. */
export async function paystackFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<PaystackResult<T>> {
  const secret = paystackSecretKey();
  if (!secret) return { ok: false, status: 503, message: "PAYSTACK_NOT_CONFIGURED" };

  try {
    const response = await fetch(`${PAYSTACK_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${secret.key}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const parsed = (await response.json().catch(() => null)) as
      | { status?: boolean; message?: string; data?: T & { message?: string } }
      | null;

    if (!response.ok || !parsed?.status) {
      return {
        ok: false,
        status: response.status,
        // Paystack's top-level message can be a generic "Charge attempted"
        // even when the charge itself was declined — prefer the specific
        // data.message (e.g. test-mode phone declination reasons).
        message: parsed?.data?.message ?? parsed?.message ?? `Paystack request failed (${response.status})`,
      };
    }
    return { ok: true, status: response.status, data: parsed.data };
  } catch (err) {
    console.error("Paystack network failure", path, err instanceof Error ? err.message : err);
    return { ok: false, status: 0, message: "NETWORK_ERROR" };
  }
}

/** Normalises Ghana mobile numbers to 0XXXXXXXXX; null when invalid. */
export function normalizeGhanaPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[^\d]/g, "");
  let local = digits;
  if (local.startsWith("00233")) local = `0${local.slice(5)}`;
  else if (local.startsWith("233")) local = `0${local.slice(3)}`;
  else if (/^[235]\d{9}$/.test(local)) local = `0${local}`;
  return /^0[235]\d{8}$/.test(local) ? local : null;
}

/**
 * Server-side 10% / 90% split in integer minor units (pesewas). The
 * commission is floored so the recipient amount never exceeds the received
 * funds, and the two always add up to the transaction amount.
 */
export function calculateSplit(amountPesewas: number): { commissionPesewas: number; netPesewas: number } {
  const amount = Math.floor(Number(amountPesewas));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("INVALID_AMOUNT");
  const commissionPesewas = Math.floor(amount / 10); // 10.00% = 1000 basis points
  return { commissionPesewas, netPesewas: amount - commissionPesewas };
}

/** Existing schema: payment_transactions row shape. */
export interface MomoTransactionRow {
  id: string;
  reference: string;
  request_key: string;
  payer_id: string;
  recipient_user_id: string | null;
  trip_id: string | null;
  shipment_id: string | null;
  purpose: string;
  description: string | null;
  email: string;
  full_name: string;
  phone: string;
  momo_provider: string;
  currency: string;
  amount_pesewas: number;
  status: string;
  provider_transaction_id: string | null;
  provider_status: string | null;
  gateway_response: string | null;
  failure_reason: string | null;
  paid_at: string | null;
  metadata: Record<string, unknown>;
  payout_status: string;
  created_at: string;
}

const TXN_COLUMNS =
  "id, reference, request_key, payer_id, recipient_user_id, trip_id, shipment_id, purpose, description, email, full_name, phone, momo_provider, currency, amount_pesewas, status, provider_transaction_id, provider_status, gateway_response, failure_reason, paid_at, metadata, payout_status, created_at";

export async function getTransaction(
  admin: SupabaseClient,
  by: { reference?: string },
): Promise<MomoTransactionRow | null> {
  if (!by.reference) return null;
  const { data } = await admin
    .from("payment_transactions")
    .select(TXN_COLUMNS)
    .eq("reference", by.reference)
    .limit(1)
    .maybeSingle();
  return (data as MomoTransactionRow | null) ?? null;
}

/** Appends a payment_status_history row (audit trail for every transition). */
export async function recordStatusChange(
  admin: SupabaseClient,
  entry: {
    transactionId?: string | null;
    entity?: "TRANSACTION" | "PAYOUT";
    entityId?: string | null;
    fromStatus?: string | null;
    toStatus: string;
    note?: string | null;
    source?: string;
    changedBy?: string | null;
  },
): Promise<void> {
  await admin.from("payment_status_history").insert({
    transaction_id: entry.transactionId ?? null,
    entity: entry.entity ?? "TRANSACTION",
    entity_id: entry.entityId ?? null,
    old_status: entry.fromStatus ?? null,
    new_status: entry.toStatus,
    note: entry.note ?? null,
    source: entry.source ?? "SYSTEM",
    changed_by: entry.changedBy ?? null,
  });
}

export interface PaystackChargeData {
  status?: string;
  reference?: string;
  display_text?: string;
  gateway_response?: string;
  amount?: number;
  currency?: string;
  id?: number | string;
}

/**
 * Marks a transaction SUCCESS after authoritative confirmation, records the
 * 10% commission + 90% net split, creates the payout obligation (idempotent)
 * and mirrors the paid state onto the legacy escrow payment row. Safe to
 * call repeatedly for the same transaction.
 */
export async function settleChargeSuccess(
  admin: SupabaseClient,
  txn: MomoTransactionRow,
  paystackData: PaystackChargeData | null,
  source: "webhook" | "verify",
): Promise<void> {
  if (txn.status === "SUCCESS") return; // idempotent
  if (!["PENDING", "PROCESSING", "FAILED"].includes(txn.status)) return;

  // Recompute the split from the AUTHORITATIVE amount — never from the client.
  const providerAmount = Number(paystackData?.amount ?? txn.amount_pesewas);
  if (Number.isFinite(providerAmount) && providerAmount !== txn.amount_pesewas) {
    console.error(
      `Amount mismatch on ${txn.reference}: stored=${txn.amount_pesewas} provider=${providerAmount}`,
    );
    if (providerAmount < txn.amount_pesewas) {
      await admin
        .from("payment_transactions")
        .update({
          status: "FAILED",
          failure_reason: "Amount verification failed against provider",
          updated_at: new Date().toISOString(),
        })
        .eq("id", txn.id);
      await recordStatusChange(admin, {
        transactionId: txn.id,
        fromStatus: txn.status,
        toStatus: "FAILED",
        note: "Amount mismatch against provider",
        source: source.toUpperCase(),
      });
      return;
    }
  }

  const { commissionPesewas, netPesewas } = calculateSplit(txn.amount_pesewas);
  const now = new Date().toISOString();

  const { error: updateError } = await admin
    .from("payment_transactions")
    .update({
      status: "SUCCESS",
      payout_status: "PENDING",
      paid_at: now,
      provider_status: paystackData?.status ?? "success",
      gateway_response: paystackData?.gateway_response ?? txn.gateway_response,
      failure_reason: null,
      metadata: {
        ...(txn.metadata ?? {}),
        confirmed_by: source,
      },
      updated_at: now,
    })
    .eq("id", txn.id)
    .in("status", ["PENDING", "PROCESSING", "FAILED"]);

  if (updateError) {
    console.error(`Failed to settle ${txn.reference}: ${updateError.message}`);
    return;
  }

  await recordStatusChange(admin, {
    transactionId: txn.id,
    fromStatus: txn.status,
    toStatus: "SUCCESS",
    note: `Confirmed via ${source}`,
    source: source.toUpperCase(),
  });

  // Platform commission record (idempotent per transaction).
  await admin.from("platform_commissions").upsert(
    {
      transaction_id: txn.id,
      commission_pesewas: commissionPesewas,
      net_amount_pesewas: netPesewas,
      rate_bp: 1000,
    },
    { onConflict: "transaction_id", ignoreDuplicates: true },
  );

  // Recipient payout obligation (idempotent per transaction).
  if (txn.recipient_user_id) {
    const { data: recipient } = await admin
      .from("payment_recipients")
      .select("id, user_id, full_name, phone, momo_provider, recipient_code")
      .eq("user_id", txn.recipient_user_id)
      .maybeSingle();

    if (recipient?.recipient_code) {
      const { error: payoutError } = await admin.from("payout_records").upsert(
        {
          transaction_id: txn.id,
          recipient_user_id: recipient.user_id,
          recipient_record_id: recipient.id,
          amount_pesewas: netPesewas,
          currency: txn.currency,
          status: "PENDING",
          recipient_name: recipient.full_name,
          recipient_phone: recipient.phone,
          recipient_network: recipient.momo_provider,
          recipient_code_snapshot: recipient.recipient_code,
        },
        { onConflict: "transaction_id", ignoreDuplicates: true },
      );
      if (payoutError) console.error(`Payout record failed for ${txn.reference}: ${payoutError.message}`);
    } else {
      console.error(`No verified recipient for ${txn.reference} — payout obligation not created`);
    }
  }

  // Mirror onto the legacy escrow row so the existing trip flow stays correct.
  // metadata.payment_id targets payments.id; the trip-only fallback must match
  // on trip_id — never pair one column with the other's value.
  const legacyMetadata = (txn.metadata ?? {}) as { payment_id?: string };
  const legacyPaymentId = legacyMetadata.payment_id ?? null;
  const legacyTripId = txn.trip_id ?? null;
  if (legacyPaymentId || legacyTripId) {
    const { data: payment } = await admin
      .from("payments")
      .select("id, trip_id, status")
      .eq(legacyPaymentId ? "id" : "trip_id", (legacyPaymentId ?? legacyTripId) as string)
      .maybeSingle();
    if (payment && ["PENDING", "AUTHORIZED", "FAILED"].includes(payment.status)) {
      await admin
        .from("payments")
        .update({ status: "HELD", paid_at: now, failure_reason: null, updated_at: now })
        .eq("id", payment.id);
    }
  }
}

/** Marks a charge failed/cancelled (idempotent). */
export async function markChargeFailed(
  admin: SupabaseClient,
  txn: MomoTransactionRow,
  reason: string,
  nextStatus: "FAILED" | "CANCELLED" = "FAILED",
): Promise<void> {
  if (["SUCCESS", "REFUNDED"].includes(txn.status)) return;
  if (txn.status === nextStatus) return;
  await admin
    .from("payment_transactions")
    .update({
      status: nextStatus,
      failure_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", txn.id)
    .in("status", ["PENDING", "PROCESSING"]);
  await recordStatusChange(admin, {
    transactionId: txn.id,
    fromStatus: txn.status,
    toStatus: nextStatus,
    note: reason,
  });
}
