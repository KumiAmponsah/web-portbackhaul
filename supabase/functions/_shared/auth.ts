import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export class AuthError extends Error {
  readonly __tag = "AuthError";
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export class AppError extends Error {
  readonly __tag = "AppError";
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = "AppError";
    this.status = status;
  }
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

/** Verifies the caller's Supabase JWT. Throws AuthError when absent or invalid. */
export async function requireAuth(req: Request): Promise<AuthedUser> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) throw new AuthError();

  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new AuthError();
  return { id: data.user.id, email: data.user.email ?? null };
}

/** Service-role client. Bypasses RLS — use only after authorization checks. */
export function createAdminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/** RLS-scoped client acting as the caller. */
export function createUserClient(req: Request): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
}

export interface ProfileRow {
  id: string;
  role: string;
  account_status: string;
  verification_status: string;
  full_name: string | null;
  email: string | null;
}

/**
 * Centralised server-side authorization. Verifies authentication, role,
 * account status and (optionally) an administrative permission before any
 * protected operation runs.
 */
export async function authorize(
  admin: SupabaseClient,
  userId: string,
  options: { roles?: string[]; requireApproved?: boolean; permission?: string } = {},
): Promise<ProfileRow> {
  const { data: profile, error } = await admin
    .from("profiles")
    .select("id, role, account_status, verification_status, full_name, email")
    .eq("id", userId)
    .maybeSingle();

  if (error || !profile) throw new AppError("ROLE_NOT_AUTHORIZED", 403);

  if (options.requireApproved !== false) {
    if (profile.account_status === "PENDING") throw new AppError("ACCOUNT_PENDING", 403);
    if (profile.account_status === "REJECTED") throw new AppError("ACCOUNT_REJECTED", 403);
    if (profile.account_status === "SUSPENDED") throw new AppError("ACCOUNT_SUSPENDED", 403);
    if (profile.account_status === "BLOCKED") throw new AppError("ACCOUNT_BLOCKED", 403);
  }

  if (options.roles && !options.roles.includes(profile.role)) {
    throw new AppError("ROLE_NOT_AUTHORIZED", 403);
  }

  if (options.permission) {
    if (profile.role !== "ADMIN") throw new AppError("ADMIN_PERMISSION_REQUIRED", 403);
    const { data: permission } = await admin
      .from("admin_permissions")
      .select("id")
      .eq("admin_user_id", userId)
      .eq("permission", options.permission)
      .maybeSingle();
    if (!permission) throw new AppError("ADMIN_PERMISSION_REQUIRED", 403);
  }

  return profile as ProfileRow;
}

/** Writes an audit record with the service role so it cannot be tampered with. */
export async function writeAudit(
  admin: SupabaseClient,
  entry: {
    actorId: string | null;
    actorRole?: string | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    tripId?: string | null;
    metadata?: Record<string, unknown>;
    sessionInfo?: string | null;
  },
): Promise<void> {
  const { error } = await admin.from("audit_logs").insert({
    actor_id: entry.actorId,
    actor_role: entry.actorRole ?? null,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId ?? null,
    trip_id: entry.tripId ?? null,
    metadata: entry.metadata ?? {},
    session_info: entry.sessionInfo ?? null,
  });
  if (error) console.error("Failed to write audit log", error.message);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Maps thrown errors onto structured, client-readable error codes.
 *
 * `instanceof` is unreliable across Deno module boundaries in the edge
 * runtime (esm.sh / import maps can produce two constructors for the same
 * source), so we duck-type on a tagged field instead.
 */
export function errorResponse(err: unknown): Response {
  console.error("edge function error:", err);

  if (err && typeof err === "object") {
    const e = err as { __tag?: string; name?: string; message?: string; status?: number };

    if (e.__tag === "AuthError" || e.name === "AuthError") {
      return json({ error: "ROLE_NOT_AUTHORIZED" }, 401);
    }

    if (e.__tag === "AppError" || e.name === "AppError") {
      const status = typeof e.status === "number" ? e.status : 400;
      return json({ error: e.message ?? "INTERNAL_ERROR" }, status);
    }
  }

  return json({ error: "INTERNAL_ERROR" }, 500);
}