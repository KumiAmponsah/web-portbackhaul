import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "node:crypto";
import {
  getTransaction,
  markChargeFailed,
  settleChargeSuccess,
  webhookSigningKey,
  type PaystackChargeData,
} from "../_shared/paystack.ts";

/**
 * paystack-webhook
 *
 * Public endpoint called by Paystack. It is NOT protected by a user JWT —
 * authenticity is established solely by verifying the `x-paystack-signature`
 * HMAC-SHA512 header against the raw request body, keyed with
 * PAYSTACK_WEBHOOK_SECRET (falling back to the Paystack secret key, which is
 * what Paystack itself uses to sign). These exist only as server-side secrets.
 *
 * Guarantees:
 *  - requests without a valid signature are rejected with 401
 *  - processing is idempotent: the provider event id is recorded in
 *    payment_webhook_events (unique on provider+event_id) AND the legacy
 *    payment_events table, so a replayed webhook is a no-op
 *  - payments are only advanced after signature validation and, for charges,
 *    a corroborating verify call when the provider is reachable
 *  - duplicate events can never create duplicate payouts (payout_records has
 *    a unique constraint per transaction and settlement is idempotent)
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-paystack-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PaystackEvent {
  event: string;
  data: {
    id?: number | string;
    reference?: string;
    // Refund events (refund.processed / refund.failed) carry the charge
    // reference under transaction_reference instead of reference.
    transaction_reference?: string;
    transfer_code?: string;
    status?: string;
    amount?: number;
    currency?: string;
    gateway_response?: string;
    metadata?: Record<string, unknown>;
  };
}

/** Constant-time comparison to avoid leaking signature information by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function nowIso(): string {
  return new Date().toISOString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const signingKey = webhookSigningKey();
  if (!signingKey) {
    console.error("No Paystack signing key configured — rejecting webhook");
    return jsonResponse({ error: "Provider not configured" }, 503);
  }

  // The signature covers the RAW body — read it as text before parsing.
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature") ?? "";

  const expected = createHmac("sha512", signingKey).update(rawBody).digest("hex");

  if (!signature || !timingSafeEqual(signature, expected)) {
    console.error("Rejected Paystack webhook with invalid signature");
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return jsonResponse({ error: "Invalid payload" }, 400);
  }

  const supabase = admin();
  const reference = event.data?.reference ?? event.data?.transaction_reference ?? null;
  const providerEventId = String(event.data?.id ?? `${event.event}:${reference ?? ""}`);

  // ---- idempotency gate (new ledger) -------------------------------------
  const { data: existingEvent } = await supabase
    .from("payment_webhook_events")
    .select("id, processed_at")
    .eq("provider", "PAYSTACK")
    .eq("provider_event_id", providerEventId)
    .maybeSingle();

  if (existingEvent?.processed_at) {
    // Already fully processed — acknowledge without repeating any state change.
    return jsonResponse({ received: true, duplicate: true });
  }

  if (!existingEvent) {
    const { error: insertError } = await supabase.from("payment_webhook_events").insert({
      provider: "PAYSTACK",
      provider_event_id: providerEventId,
      event_type: event.event,
      reference,
      payload: event as unknown as Record<string, unknown>,
    });
    // A concurrent duplicate insert is fine — we still process once because
    // settlement itself is idempotent.
    if (insertError && !insertError.message.includes("duplicate key")) {
      console.error("Failed to record webhook event", insertError.message);
    }
  }

  try {
    // ---- Mobile Money transaction handling (payment_transactions) -------
    if (event.event === "charge.success" || event.event === "charge.failed") {
      const txn = reference ? await getTransaction(supabase, { reference }) : null;
      if (txn) {
        // Corroborate the signed event with an authoritative verify call when
        // the provider is reachable; fall back to the signed event payload.
        const verify = await supabaseVerify(supabase, txn.reference);
        const confirmed: PaystackChargeData | null = verify ?? (event.data as PaystackChargeData);

        if (event.event === "charge.success") {
          if (confirmed?.status === "success") {
            await settleChargeSuccess(supabase, txn, confirmed, "webhook");
          } else {
            await markChargeFailed(supabase, txn, "Charge not confirmed by provider");
          }
        } else {
          await markChargeFailed(
            supabase,
            txn,
            event.data?.gateway_response ?? "Payment failed at provider",
          );
        }
      } else if (reference) {
        console.error(`No MoMo transaction matches Paystack reference ${reference}`);
      }
    }

    if (event.event === "refund.processed" && reference) {
      const txn = await getTransaction(supabase, { reference });
      if (txn && txn.status === "SUCCESS") {
        await supabase
          .from("payment_transactions")
          .update({ status: "REFUNDED", payout_status: "REVERSED", refunded_at: nowIso(), updated_at: nowIso() })
          .eq("id", txn.id)
          .in("status", ["SUCCESS"]);
        await supabase.from("payment_status_history").insert({
          transaction_id: txn.id,
          entity: "TRANSACTION",
          old_status: "SUCCESS",
          new_status: "REFUNDED",
          note: "Provider confirmed refund",
          source: "WEBHOOK",
        });
        const { data: payout } = await supabase
          .from("payout_records")
          .select("id, status")
          .eq("transaction_id", txn.id)
          .maybeSingle();
        if (payout && payout.status !== "REVERSED") {
          await supabase
            .from("payout_records")
            .update({ status: "REVERSED", updated_at: nowIso() })
            .eq("id", payout.id);
          await supabase.from("payment_status_history").insert({
            transaction_id: txn.id,
            entity: "PAYOUT",
            entity_id: payout.id,
            old_status: payout.status,
            new_status: "REVERSED",
            note: "Refund processed by provider",
            source: "WEBHOOK",
          });
        }
      }
    }

    // ---- Transfer (payout) lifecycle ------------------------------------
    if (["transfer.success", "transfer.failed", "transfer.reversed"].includes(event.event)) {
      const transferCode = event.data?.transfer_code ?? null;
      const transferRef = event.data?.reference ?? null;
      let query = supabase.from("payout_records").select("id, transaction_id, status").limit(1);
      if (transferCode) query = query.eq("provider_transfer_code", transferCode);
      else if (transferRef) query = query.eq("provider_reference", transferRef);
      else query = query.eq("id", "00000000-0000-0000-0000-000000000000");
      const { data: payout } = await query.maybeSingle();

      if (payout) {
        const nextStatus =
          event.event === "transfer.success" ? "PAID" : event.event === "transfer.failed" ? "FAILED" : "REVERSED";
        const reason =
          nextStatus === "FAILED"
            ? (event.data?.gateway_response ?? "Transfer failed at provider")
            : `Transfer ${nextStatus.toLowerCase()} at provider`;

        await supabase
          .from("payout_records")
          .update({
            status: nextStatus,
            failure_reason: nextStatus === "FAILED" ? reason : null,
            processed_at: nextStatus === "FAILED" ? null : nowIso(),
            updated_at: nowIso(),
          })
          .eq("id", payout.id)
          .in("status", ["PENDING", "PROCESSING"]);

        await supabase
          .from("payment_transactions")
          .update({ payout_status: nextStatus, updated_at: nowIso() })
          .eq("id", payout.transaction_id)
          .in("payout_status", ["PENDING", "PROCESSING"]);

        await supabase.from("payment_status_history").insert({
          transaction_id: payout.transaction_id,
          entity: "PAYOUT",
          entity_id: payout.id,
          old_status: payout.status,
          new_status: nextStatus,
          note: reason,
          source: "WEBHOOK",
        });
      } else {
        console.error(`No payout record matches transfer ${transferCode ?? transferRef ?? "?"}`);
      }
    }

    // ---- Legacy escrow handling (payments table) — unchanged ------------
    let paymentId: string | null = null;
    let tripId: string | null = null;

    if (reference) {
      const { data: payment } = await supabase
        .from("payments")
        .select("id, trip_id, status, amount_ghs")
        .eq("provider_reference", reference)
        .maybeSingle();

      if (payment) {
        paymentId = payment.id;
        tripId = payment.trip_id;

        if (event.event === "charge.success" && event.data.status === "success") {
          if (["PENDING", "AUTHORIZED", "FAILED"].includes(payment.status)) {
            const { error: updateError } = await supabase
              .from("payments")
              .update({
                status: "HELD", // held until delivery conditions are satisfied
                paid_at: nowIso(),
                failure_reason: null,
                updated_at: nowIso(),
              })
              .eq("id", payment.id);
            if (updateError) console.error("Failed to mark payment paid", updateError.message);
          }
        } else if (
          event.event === "charge.failed" ||
          (event.data.status && ["failed", "abandoned", "reversed"].includes(event.data.status))
        ) {
          await supabase
            .from("payments")
            .update({
              status: "FAILED",
              failure_reason: event.data.gateway_response ?? "Payment failed at provider",
              updated_at: nowIso(),
            })
            .eq("id", payment.id);
        } else if (event.event === "refund.processed") {
          await supabase
            .from("payments")
            .update({ status: "REFUNDED", updated_at: nowIso() })
            .eq("id", payment.id);
        }
      }
    }

    // ---- legacy event ledger (unique constraint enforces idempotency) ---
    const { error: eventError } = await supabase.from("payment_events").insert({
      payment_id: paymentId,
      provider: "PAYSTACK",
      provider_event_id: providerEventId,
      event_type: event.event,
      payload: event as unknown as Record<string, unknown>,
    });
    if (eventError && !eventError.message.includes("duplicate key")) {
      console.error("Failed to record payment event", eventError.message);
    }

    await supabase.from("audit_logs").insert({
      actor_id: null,
      actor_role: "system",
      action: `PAYMENT_WEBHOOK_${event.event.toUpperCase().replace(/\./g, "_")}`,
      entity_type: "payment",
      entity_id: paymentId,
      trip_id: tripId,
      metadata: { reference, status: event.data?.status ?? null },
    });

    // Mark the new-ledger row processed (retries before this point reprocess).
    await supabase
      .from("payment_webhook_events")
      .update({ processed_at: nowIso() })
      .eq("provider", "PAYSTACK")
      .eq("provider_event_id", providerEventId);

    return jsonResponse({ received: true });
  } catch (err) {
    // Do NOT mark processed — Paystack will retry and settlement is idempotent.
    console.error("Webhook processing failed", err instanceof Error ? err.message : err);
    return jsonResponse({ error: "Processing failed" }, 500);
  }
});

/**
 * Best-effort authoritative verification of a charge against Paystack.
 * Returns null when the provider cannot be reached — the signed event payload
 * is then used as-is (signature was already validated).
 */
async function supabaseVerify(_supabase: unknown, _reference: string): Promise<PaystackChargeData | null> {
  const { paystackSecretKey, paystackFetch } = await import("../_shared/paystack.ts");
  if (!paystackSecretKey()) return null;
  const result = await paystackFetch<PaystackChargeData>(`/charge/verify/${encodeURIComponent(_reference)}`);
  if (!result.ok || !result.data) return null;
  return result.data;
}
