import {
  AppError,
  authorize,
  corsHeaders,
  createAdminClient,
  errorResponse,
  json,
  requireAuth,
  writeAudit,
} from "../_shared/auth.ts";
import {
  calculateSplit,
  getTransaction,
  isMomoNetwork,
  markChargeFailed,
  MOMO_NETWORKS,
  canonicalNetwork,
  normalizeGhanaPhone,
  paystackFetch,
  paystackSecretKey,
  recordStatusChange,
  settleChargeSuccess,
  type MomoTransactionRow,
  type PaystackChargeData,
} from "../_shared/paystack.ts";

/**
 * payments-api
 *
 * All payment state transitions happen here with the service role. The client
 * has no INSERT/UPDATE policy on payments, payment_transactions or payouts,
 * so this function is the only path that can move money-related state.
 *
 * Legacy escrow actions (initialize / request_release / request_payout /
 * admin_release) are unchanged. Mobile Money actions:
 *   save_recipient    – register/verify a MoMo payout recipient (Paystack)
 *   get_recipient     – own payout details
 *   initiate_momo     – idempotent MoMo charge against a trip payment
 *   momo_status       – lightweight polling endpoint
 *   verify_momo       – authoritative Paystack verification
 *   process_payout    – admin-initiated transfer of the 90% settlement
 *   admin_momo_stats  – server-side aggregates for the admin dashboard
 *
 * The Paystack secret key is read from the server-side environment only and
 * is never returned to, or embedded in, the client bundle.
 */

const TXN_VIEW = "reference, status, payout_status, amount_pesewas, momo_provider, gateway_response, failure_reason, paid_at";

function momoClientView(txn: MomoTransactionRow | null) {
  if (!txn) return null;
  return {
    reference: txn.reference,
    status: txn.status,
    payout_status: txn.payout_status,
    amount_pesewas: txn.amount_pesewas,
    momo_provider: txn.momo_provider,
    gateway_response: txn.gateway_response,
    failure_reason: txn.failure_reason,
    paid_at: txn.paid_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuth(req);
    const admin = createAdminClient();
    const body = (await req.json()) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    // ------------------------------------------------------------------
    // Endpoints that do not require an approved marketplace account.
    // ------------------------------------------------------------------
    if (action === "save_recipient" || action === "get_recipient") {
      const profile = await authorize(admin, user.id, { requireApproved: true });

      if (action === "get_recipient") {
        const { data: row } = await admin
          .from("payment_recipients")
          .select("full_name, phone, momo_provider, verification_status, is_active")
          .eq("user_id", user.id)
          .maybeSingle();
        return json({ recipient: row ?? null });
      }

      const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
      const phone = normalizeGhanaPhone(body.phone);
      const network = isMomoNetwork(body.momo_network) ? canonicalNetwork(body.momo_network) : null;
      if (!fullName || fullName.length > 120) throw new AppError("INVALID_ACTION", 400);
      if (!phone) throw new AppError("INVALID_PHONE", 400);
      if (!network) throw new AppError("INVALID_MOMO_NETWORK", 400);

      let recipientCode: string | null = null;
      let verification = "PENDING";
      let providerConfigured = false;

      if (paystackSecretKey()) {
        providerConfigured = true;
        const result = await paystackFetch<{ recipient_code?: string }>("/transferrecipient", {
          method: "POST",
          body: {
            type: "mobile_money",
            name: fullName,
            account_number: phone,
            bank_code: MOMO_NETWORKS[network].bankCode,
            currency: "GHS",
          },
        });
        if (result.ok && result.data?.recipient_code) {
          recipientCode = result.data.recipient_code;
          verification = "VERIFIED";
        } else if (result.status !== 503) {
          // Paystack rejected the payout details (invalid MoMo number etc).
          throw new AppError(result.message ?? "RECIPIENT_CREATION_FAILED", 502);
        }
      }

      const row = {
        user_id: user.id,
        full_name: fullName,
        phone,
        momo_provider: network,
        recipient_code: recipientCode,
        verification_status: verification,
        is_active: true,
      };

      const { data: existing } = await admin
        .from("payment_recipients")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      const { error: saveError } = existing
        ? await admin.from("payment_recipients").update(row).eq("id", existing.id)
        : await admin.from("payment_recipients").insert(row);

      if (saveError) {
        if (saveError.message.includes("PAYOUT_DETAILS_LOCKED")) throw new AppError("PAYOUT_DETAILS_LOCKED", 409);
        console.error("Failed to save payment recipient", saveError.message);
        throw new AppError("RECIPIENT_CREATION_FAILED", 500);
      }

      await writeAudit(admin, {
        actorId: user.id,
        actorRole: profile.role,
        action: verification === "VERIFIED" ? "PAYOUT_RECIPIENT_VERIFIED" : "PAYOUT_RECIPIENT_SAVED",
        entityType: "payment_recipient",
        entityId: user.id,
        metadata: { momo_provider: network, provider_configured: providerConfigured },
      });

      return json({ ok: true, verification_status: verification, provider_configured: providerConfigured });
    }

    // ------------------------------------------------------------------
    // Approved-account actions.
    // ------------------------------------------------------------------
    const profile = await authorize(admin, user.id, { requireApproved: true });

    switch (action) {
      // ---------------------------------------------------------------
      case "initiate_momo": {
        const paymentId = typeof body.payment_id === "string" ? body.payment_id : "";
        if (!paymentId) throw new AppError("RESOURCE_NOT_AUTHORIZED", 400);

        const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
        const phone = normalizeGhanaPhone(body.phone);
        const network = isMomoNetwork(body.momo_network) ? canonicalNetwork(body.momo_network) : null;
        if (!fullName) throw new AppError("INVALID_ACTION", 400);
        if (!phone) throw new AppError("INVALID_PHONE", 400);
        if (!network) throw new AppError("INVALID_MOMO_NETWORK", 400);

        const email =
          (typeof body.email === "string" && body.email.includes("@") ? body.email.trim() : null) ??
          profile.email ??
          user.email ??
          null;
        if (!email) throw new AppError("EMAIL_REQUIRED", 400);

        // request_key is a uuid column — coerce anything else to a fresh uuid
        // so a malformed client value cannot break the idempotency insert.
        const requestKeyIsUuid =
          typeof body.request_key === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_key);
        const requestKey = requestKeyIsUuid ? (body.request_key as string) : crypto.randomUUID();

        // Amounts and payee come from the database — never from the client.
        const { data: payment } = await admin
          .from("payments")
          .select("id, trip_id, shipment_id, payer_id, amount_ghs, status")
          .eq("id", paymentId)
          .maybeSingle();
        if (!payment || payment.payer_id !== user.id) throw new AppError("RESOURCE_NOT_AUTHORIZED", 403);
        if (!["PENDING", "FAILED"].includes(payment.status)) throw new AppError("INVALID_STATUS_TRANSITION", 409);

        // Idempotency: the same request key returns the same transaction.
        const { data: byKey } = await admin
          .from("payment_transactions")
          .select("reference")
          .eq("request_key", requestKey)
          .maybeSingle();
        if (byKey) {
          const existing = await getTransaction(admin, { reference: byKey.reference });
          return json({ ...momoClientView(existing), provider_configured: Boolean(paystackSecretKey()) });
        }

        // Duplicate guard: one live or settled charge per payment. Including
        // SUCCESS keeps a paid payment from being charged again even if the
        // escrow mirror on the legacy row has not run yet.
        if (payment.trip_id) {
          const { data: active } = await admin
            .from("payment_transactions")
            .select("reference")
            .eq("trip_id", payment.trip_id)
            .in("status", ["PENDING", "PROCESSING", "SUCCESS"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (active) {
            const existing = await getTransaction(admin, { reference: active.reference });
            return json({ ...momoClientView(existing), provider_configured: Boolean(paystackSecretKey()) });
          }
        }

        // Resolve the payout recipient (the trip's truck owner) server-side.
        let recipientUserId: string | null = null;
        if (payment.trip_id) {
          const { data: trip } = await admin
            .from("trip_assignments")
            .select("truck_id")
            .eq("id", payment.trip_id)
            .maybeSingle();
          if (trip?.truck_id) {
            const { data: truck } = await admin
              .from("trucks")
              .select("owner_id")
              .eq("id", trip.truck_id)
              .maybeSingle();
            recipientUserId = truck?.owner_id ?? null;
          }
        }

        let recipientCode: string | null = null;
        if (recipientUserId) {
          const { data: rec } = await admin
            .from("payment_recipients")
            .select("recipient_code, verification_status")
            .eq("user_id", recipientUserId)
            .maybeSingle();
          if (rec?.verification_status === "VERIFIED" && rec.recipient_code) recipientCode = rec.recipient_code;
        }
        if (!recipientCode) throw new AppError("RECIPIENT_REQUIRED", 409);

        const amountPesewas = Math.round(Number(payment.amount_ghs) * 100);
        if (!Number.isFinite(amountPesewas) || amountPesewas <= 0) throw new AppError("INVALID_AMOUNT", 400);

        const reference = `PBTX-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const { data: txn, error: insertError } = await admin
          .from("payment_transactions")
          .insert({
            reference,
            request_key: requestKey,
            payer_id: user.id,
            recipient_user_id: recipientUserId,
            trip_id: payment.trip_id,
            shipment_id: payment.shipment_id,
            purpose: "TRANSPORT_FEE",
            email,
            full_name: fullName,
            phone,
            momo_provider: network,
            currency: "GHS",
            amount_pesewas: amountPesewas,
            status: "PENDING",
            metadata: { payment_id: payment.id },
          })
          .select("id, reference, status, payout_status, amount_pesewas, momo_provider, gateway_response, failure_reason, paid_at")
          .single();
        if (insertError || !txn) {
          console.error("Failed to create payment transaction", insertError?.message);
          throw new AppError("PAYMENT_PROVIDER_ERROR", 500);
        }

        if (!paystackSecretKey()) {
          await writeAudit(admin, {
            actorId: user.id,
            actorRole: profile.role,
            action: "PAYMENT_MOMO_UNCONFIGURED",
            entityType: "payment",
            entityId: payment.id,
            tripId: payment.trip_id,
            metadata: { reference },
          });
          return json({ ...momoClientView(txn as MomoTransactionRow), provider_configured: false });
        }

        const charge = await paystackFetch<PaystackChargeData>("/charge", {
          method: "POST",
          body: {
            email,
            amount: amountPesewas,
            currency: "GHS",
            reference,
            mobile_money: { phone, provider: MOMO_NETWORKS[network].chargeProvider },
            metadata: { reference, payment_id: payment.id, trip_id: payment.trip_id },
          },
        });

        if (!charge.ok) {
          const reason = charge.message ?? "Provider error";
          await admin
            .from("payment_transactions")
            .update({ status: "FAILED", failure_reason: reason, updated_at: nowIso() })
            .eq("id", (txn as { id: string }).id);
          await recordStatusChange(admin, {
            transactionId: (txn as { id: string }).id,
            fromStatus: "PENDING",
            toStatus: "FAILED",
            note: reason,
            source: "API",
          });
          await writeAudit(admin, {
            actorId: user.id,
            actorRole: profile.role,
            action: "PAYMENT_MOMO_INIT_FAILED",
            entityType: "payment",
            entityId: payment.id,
            tripId: payment.trip_id,
            metadata: { reference, reason },
          });
          throw new AppError(reason, 502);
        }

        const d = charge.data ?? {};
        await admin
          .from("payment_transactions")
          .update({
            provider_status: d.status ?? null,
            provider_transaction_id: d.id !== undefined ? String(d.id) : null,
            gateway_response: d.display_text ?? d.gateway_response ?? null,
            updated_at: nowIso(),
          })
          .eq("id", (txn as { id: string }).id);

        if (d.status === "success") {
          const fresh = await getTransaction(admin, { reference });
          if (fresh) await settleChargeSuccess(admin, fresh, d, "verify");
        } else if (d.status === "failed") {
          const fresh = await getTransaction(admin, { reference });
          if (fresh) await markChargeFailed(admin, fresh, d.gateway_response ?? "Payment failed at provider");
        } else {
          await admin
            .from("payment_transactions")
            .update({ status: "PROCESSING", updated_at: nowIso() })
            .eq("id", (txn as { id: string }).id);
        }

        await writeAudit(admin, {
          actorId: user.id,
          actorRole: profile.role,
          action: "PAYMENT_MOMO_INITIALIZED",
          entityType: "payment",
          entityId: payment.id,
          tripId: payment.trip_id,
          metadata: { reference, charge_status: d.status ?? null },
        });

        const final = await getTransaction(admin, { reference });
        return json({
          ...momoClientView(final),
          display_text: d.display_text ?? null,
          provider_configured: true,
        });
      }

      // ---------------------------------------------------------------
      case "momo_status": {
        const reference = typeof body.reference === "string" ? body.reference : "";
        const txn = await getTransaction(admin, { reference });
        if (!txn || (txn.payer_id !== user.id && profile.role !== "ADMIN")) {
          throw new AppError("RESOURCE_NOT_AUTHORIZED", 404);
        }
        return json(momoClientView(txn));
      }

      // ---------------------------------------------------------------
      case "verify_momo": {
        const reference = typeof body.reference === "string" ? body.reference : "";
        const txn = await getTransaction(admin, { reference });
        if (!txn || (txn.payer_id !== user.id && profile.role !== "ADMIN")) {
          throw new AppError("RESOURCE_NOT_AUTHORIZED", 404);
        }
        if (!["PENDING", "PROCESSING", "FAILED"].includes(txn.status)) {
          return json(momoClientView(txn));
        }
        if (!paystackSecretKey()) {
          return json({ ...momoClientView(txn), provider_configured: false });
        }

        // Authoritative check against Paystack — never trust client claims.
        const verify = await paystackFetch<PaystackChargeData>(
          `/charge/verify/${encodeURIComponent(txn.reference)}`,
        );
        if (!verify.ok) {
          if (verify.status === 503 || verify.status === 0) {
            return json({ ...momoClientView(txn), verify_error: "PROVIDER_UNREACHABLE" });
          }
          throw new AppError(verify.message ?? "VERIFY_FAILED", 502);
        }

        const d = verify.data ?? {};
        if (d.status === "success") {
          await settleChargeSuccess(admin, txn, d, "verify");
        } else if (["failed", "abandoned", "reverse", "reversed"].includes(d.status ?? "")) {
          await markChargeFailed(admin, txn, d.gateway_response ?? "Payment not completed");
        }

        const final = await getTransaction(admin, { reference: txn.reference });
        return json(momoClientView(final));
      }

      // ---------------------------------------------------------------
      case "process_payout": {
        await authorize(admin, user.id, { permission: "PAYMENT_MANAGE" });
        const payoutId = typeof body.payout_id === "string" ? body.payout_id : "";
        if (!payoutId) throw new AppError("RESOURCE_NOT_AUTHORIZED", 400);

        const { data: payout } = await admin
          .from("payout_records")
          .select("id, transaction_id, amount_pesewas, currency, status, attempts, recipient_code_snapshot")
          .eq("id", payoutId)
          .maybeSingle();
        if (!payout) throw new AppError("RESOURCE_NOT_AUTHORIZED", 404);
        if (!["PENDING", "FAILED"].includes(payout.status)) throw new AppError("INVALID_STATUS_TRANSITION", 409);
        if (!paystackSecretKey()) throw new AppError("PAYMENT_PROVIDER_ERROR", 503);

        const transferReference = `PBTR-${payout.transaction_id.slice(0, 8)}-${Date.now()}`;
        const transfer = await paystackFetch<{ transfer_code?: string; reference?: string; status?: string }>(
          "/transfer",
          {
            method: "POST",
            body: {
              source: "balance",
              amount: payout.amount_pesewas,
              recipient: payout.recipient_code_snapshot,
              reference: transferReference,
              reason: `PortBackhaul settlement ${payout.transaction_id.slice(0, 8)}`,
              currency: payout.currency,
            },
          },
        );

        if (!transfer.ok) {
          const reason = transfer.message ?? "Transfer failed";
          await admin
            .from("payout_records")
            .update({
              status: "FAILED",
              failure_reason: reason,
              attempts: payout.attempts + 1,
              updated_at: nowIso(),
            })
            .eq("id", payout.id);
          await admin
            .from("payment_transactions")
            .update({ payout_status: "FAILED", updated_at: nowIso() })
            .eq("id", payout.transaction_id);
          await recordStatusChange(admin, {
            transactionId: payout.transaction_id,
            entity: "PAYOUT",
            entityId: payout.id,
            fromStatus: payout.status,
            toStatus: "FAILED",
            note: reason,
            source: "ADMIN",
            changedBy: user.id,
          });
          await writeAudit(admin, {
            actorId: user.id,
            actorRole: "ADMIN",
            action: "PAYOUT_TRANSFER_FAILED",
            entityType: "payout",
            entityId: payout.id,
            metadata: { reason },
          });
          throw new AppError(reason, 502);
        }

        await admin
          .from("payout_records")
          .update({
            status: "PROCESSING",
            provider_transfer_code: transfer.data?.transfer_code ?? null,
            provider_reference: transfer.data?.reference ?? transferReference,
            attempts: payout.attempts + 1,
            failure_reason: null,
            updated_at: nowIso(),
          })
          .eq("id", payout.id);
        await admin
          .from("payment_transactions")
          .update({ payout_status: "PROCESSING", updated_at: nowIso() })
          .eq("id", payout.transaction_id);
        await recordStatusChange(admin, {
          transactionId: payout.transaction_id,
          entity: "PAYOUT",
          entityId: payout.id,
          fromStatus: payout.status,
          toStatus: "PROCESSING",
          note: "Paystack transfer initiated",
          source: "ADMIN",
          changedBy: user.id,
        });
        await writeAudit(admin, {
          actorId: user.id,
          actorRole: "ADMIN",
          action: "PAYOUT_TRANSFER_INITIATED",
          entityType: "payout",
          entityId: payout.id,
          metadata: { transfer_reference: transferReference },
        });

        return json({ ok: true, status: "PROCESSING" });
      }

      // ---------------------------------------------------------------
      case "admin_momo_stats": {
        await authorize(admin, user.id, { permission: "ADMIN_VIEW" });

        const { data: txns } = await admin
          .from("payment_transactions")
          .select("status, payout_status, amount_pesewas")
          .limit(20000);
        const rows = txns ?? [];
        const successRows = rows.filter((r) => r.status === "SUCCESS");

        const { data: commissions } = await admin
          .from("platform_commissions")
          .select("commission_pesewas, net_amount_pesewas")
          .limit(20000);
        const commissionRows = commissions ?? [];

        const { data: payouts } = await admin
          .from("payout_records")
          .select("status, amount_pesewas")
          .limit(20000);
        const payoutRows = payouts ?? [];

        return json({
          total_transactions: rows.length,
          successful_payments: successRows.length,
          failed_payments: rows.filter((r) => r.status === "FAILED").length,
          pending_payments: rows.filter((r) => ["PENDING", "PROCESSING"].includes(r.status)).length,
          refunded_payments: rows.filter((r) => r.status === "REFUNDED").length,
          total_volume_pesewas: successRows.reduce((s, r) => s + Number(r.amount_pesewas), 0),
          total_commission_pesewas: commissionRows.reduce((s, r) => s + Number(r.commission_pesewas), 0),
          total_recipient_payouts_pesewas: commissionRows.reduce((s, r) => s + Number(r.net_amount_pesewas), 0),
          pending_payouts: payoutRows.filter((r) => ["PENDING", "PROCESSING"].includes(r.status)).length,
          pending_payouts_pesewas: payoutRows
            .filter((r) => ["PENDING", "PROCESSING"].includes(r.status))
            .reduce((s, r) => s + Number(r.amount_pesewas), 0),
          failed_payouts: payoutRows.filter((r) => r.status === "FAILED").length,
          paid_payouts: payoutRows.filter((r) => r.status === "PAID").length,
        });
      }

      // ---------------------------------------------------------------
      // Legacy escrow actions — unchanged behaviour.
      // ---------------------------------------------------------------
      case "initialize": {
        if (!body.payment_id && !body.trip_id) throw new AppError("RESOURCE_NOT_AUTHORIZED", 400);
        const legacySecret = Deno.env.get("PAYSTACK_SECRET_KEY");

        const { data: payment } = await admin
          .from("payments")
          .select("id, trip_id, payer_id, amount_ghs, status, provider_reference")
          .eq(body.payment_id ? "id" : "trip_id", (body.payment_id ?? body.trip_id) as string)
          .maybeSingle();

        if (!payment) throw new AppError("RESOURCE_NOT_AUTHORIZED", 404);
        if (payment.payer_id !== user.id) throw new AppError("RESOURCE_NOT_AUTHORIZED", 403);
        if (!["PENDING", "FAILED"].includes(payment.status)) {
          throw new AppError("INVALID_STATUS_TRANSITION", 409);
        }

        const reference = `PB-${payment.id.slice(0, 8)}-${Date.now()}`;

        if (!legacySecret) {
          await admin
            .from("payments")
            .update({ provider_reference: reference, updated_at: nowIso() })
            .eq("id", payment.id);
          await writeAudit(admin, {
            actorId: user.id,
            actorRole: profile.role,
            action: "PAYMENT_INITIALIZE_UNCONFIGURED",
            entityType: "payment",
            entityId: payment.id,
            tripId: payment.trip_id,
            metadata: { reference },
          });
          return json({ authorization_url: null, reference, simulated: false, provider_configured: false });
        }

        const response = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${legacySecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: profile.email ?? user.email,
            amount: Math.round(Number(payment.amount_ghs) * 100),
            currency: "GHS",
            reference,
            callback_url: typeof body.callback_url === "string" ? body.callback_url : undefined,
            metadata: { payment_id: payment.id, trip_id: payment.trip_id },
          }),
        });

        const result = (await response.json()) as {
          status?: boolean;
          message?: string;
          data?: { authorization_url?: string };
        };

        if (!response.ok || !result.status) {
          console.error("Paystack initialize failed", result.message);
          await admin
            .from("payments")
            .update({ status: "FAILED", failure_reason: result.message ?? "Provider error" })
            .eq("id", payment.id);
          throw new AppError("PAYMENT_PROVIDER_ERROR", 502);
        }

        await admin
          .from("payments")
          .update({
            provider_reference: reference,
            status: "AUTHORIZED",
            authorized_at: nowIso(),
            updated_at: nowIso(),
          })
          .eq("id", payment.id);

        await writeAudit(admin, {
          actorId: user.id,
          actorRole: profile.role,
          action: "PAYMENT_INITIALIZED",
          entityType: "payment",
          entityId: payment.id,
          tripId: payment.trip_id,
          metadata: { reference },
        });

        return json({
          authorization_url: result.data?.authorization_url ?? null,
          reference,
          simulated: false,
          provider_configured: true,
        });
      }

      case "request_release": {
        const paymentId = typeof body.payment_id === "string" ? body.payment_id : "";
        if (!paymentId) throw new AppError("RESOURCE_NOT_AUTHORIZED", 400);

        const { data: payment } = await admin
          .from("payments")
          .select("id, trip_id, payer_id, status")
          .eq("id", paymentId)
          .maybeSingle();

        if (!payment) throw new AppError("RESOURCE_NOT_AUTHORIZED", 404);
        if (payment.payer_id !== user.id) throw new AppError("RESOURCE_NOT_AUTHORIZED", 403);
        if (!["PAID", "HELD"].includes(payment.status)) throw new AppError("INVALID_STATUS_TRANSITION", 409);

        await admin
          .from("payments")
          .update({ status: "RELEASE_REQUESTED", updated_at: nowIso() })
          .eq("id", payment.id);

        await writeAudit(admin, {
          actorId: user.id,
          actorRole: profile.role,
          action: "PAYMENT_RELEASE_REQUESTED",
          entityType: "payment",
          entityId: payment.id,
          tripId: payment.trip_id,
        });

        return json({ ok: true });
      }

      case "request_payout": {
        const legacyPayoutId = typeof body.payout_id === "string" ? body.payout_id : "";
        if (!legacyPayoutId) throw new AppError("RESOURCE_NOT_AUTHORIZED", 400);

        const { data: payout } = await admin
          .from("payouts")
          .select("id, trip_id, recipient_id, status")
          .eq("id", legacyPayoutId)
          .maybeSingle();

        if (!payout) throw new AppError("RESOURCE_NOT_AUTHORIZED", 404);
        if (payout.recipient_id !== user.id) throw new AppError("RESOURCE_NOT_AUTHORIZED", 403);
        if (payout.status !== "PENDING") throw new AppError("INVALID_STATUS_TRANSITION", 409);

        await admin
          .from("payouts")
          .update({ status: "REQUESTED", requested_at: nowIso(), updated_at: nowIso() })
          .eq("id", payout.id);

        await writeAudit(admin, {
          actorId: user.id,
          actorRole: profile.role,
          action: "PAYOUT_REQUESTED",
          entityType: "payout",
          entityId: payout.id,
          tripId: payout.trip_id,
        });

        return json({ ok: true });
      }

      case "admin_release": {
        await authorize(admin, user.id, { roles: ["ADMIN"], permission: "PAYMENT_MANAGE" });
        const paymentId = typeof body.payment_id === "string" ? body.payment_id : "";
        if (!paymentId) throw new AppError("RESOURCE_NOT_AUTHORIZED", 400);

        const { data: payment } = await admin
          .from("payments")
          .select("id, trip_id, status")
          .eq("id", paymentId)
          .maybeSingle();

        if (!payment) throw new AppError("RESOURCE_NOT_AUTHORIZED", 404);
        if (!["HELD", "RELEASE_REQUESTED"].includes(payment.status)) {
          throw new AppError("INVALID_STATUS_TRANSITION", 409);
        }

        await admin
          .from("payments")
          .update({ status: "RELEASED", released_at: nowIso(), updated_at: nowIso() })
          .eq("id", payment.id);

        await admin
          .from("payouts")
          .update({ status: "APPROVED", updated_at: nowIso() })
          .eq("payment_id", payment.id)
          .in("status", ["PENDING", "REQUESTED"]);

        await writeAudit(admin, {
          actorId: user.id,
          actorRole: "ADMIN",
          action: "PAYMENT_RELEASED",
          entityType: "payment",
          entityId: payment.id,
          tripId: payment.trip_id,
        });

        return json({ ok: true });
      }

      default:
        throw new AppError("INVALID_ACTION", 400);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
