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

/**
 * admin-actions
 *
 * Every account-status decision runs here with the service role, AFTER the
 * caller's administrative permission has been verified server-side. The browser
 * can never write account_status, verification_status or admin_permissions.
 */

type Decision = "APPROVE" | "REJECT" | "SUSPEND" | "BLOCK" | "UNBLOCK" | "REQUEST_MORE_INFO";

const PERMISSION_FOR: Record<Decision, string> = {
  APPROVE: "USER_APPROVE",
  REJECT: "USER_REJECT",
  SUSPEND: "USER_SUSPEND",
  BLOCK: "USER_BLOCK",
  UNBLOCK: "USER_UNBLOCK",
  REQUEST_MORE_INFO: "DOCUMENT_REVIEW",
};

const REASON_REQUIRED: Decision[] = ["REJECT", "SUSPEND", "BLOCK", "REQUEST_MORE_INFO"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuth(req);
    const admin = createAdminClient();
    const body = (await req.json()) as {
      action?: string;
      user_id?: string;
      decision?: Decision;
      reason?: string | null;
    };

    if (body.action !== "set_account_status") throw new AppError("INVALID_ACTION", 400);

    const decision = body.decision;
    const targetId = body.user_id;
    const reason = (body.reason ?? "").trim();

    if (!decision || !(decision in PERMISSION_FOR)) throw new AppError("INVALID_ACTION", 400);
    if (!targetId) throw new AppError("RESOURCE_NOT_AUTHORIZED", 400);
    if (REASON_REQUIRED.includes(decision) && !reason) throw new AppError("REASON_REQUIRED", 400);

    // 1. authentication 2. role 3. account status 4. required permission
    const actor = await authorize(admin, user.id, {
      roles: ["ADMIN"],
      requireApproved: true,
      permission: PERMISSION_FOR[decision],
    });

    // Admins cannot act on their own account status.
    if (targetId === user.id) throw new AppError("RESOURCE_NOT_AUTHORIZED", 403);

    // The SECURITY DEFINER rpc performs the status change, history record,
    // notification and role-specific verification sync in one transaction.
    const { data, error } = await admin.rpc("admin_set_account_status", {
      p_user_id: targetId,
      p_action: decision,
      p_reason: reason || null,
    });

    if (error) {
      // Surface our structured codes verbatim; hide anything else.
      const known = [
        "ADMIN_PERMISSION_REQUIRED",
        "REASON_REQUIRED",
        "RESOURCE_NOT_AUTHORIZED",
        "INVALID_ACTION",
      ].find((code) => error.message.includes(code));
      throw new AppError(known ?? "INTERNAL_ERROR", known ? 403 : 500);
    }

    // Blocking must also end any live session the user holds.
    let sessionsRevoked = false;
    if (decision === "BLOCK") {
      const { error: signOutError } = await admin.auth.admin.signOut(targetId, "global");
      if (signOutError) {
        console.error("Could not revoke sessions for blocked user", signOutError.message);
      } else {
        sessionsRevoked = true;
      }
    }

    await writeAudit(admin, {
      actorId: user.id,
      actorRole: actor.role,
      action: `ADMIN_${decision}`,
      entityType: "profile",
      entityId: targetId,
      metadata: { reason: reason || null, sessions_revoked: sessionsRevoked },
      sessionInfo: req.headers.get("user-agent") ?? null,
    });

    return json({ ok: true, profile: data, sessions_revoked: sessionsRevoked });
  } catch (err) {
    return errorResponse(err);
  }
});
