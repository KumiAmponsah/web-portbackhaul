import { AppError, corsHeaders, createAdminClient, errorResponse, json } from "../_shared/auth.ts";

/**
 * send-verification-email
 *
 * Creates the auth user server-side and delivers the email-confirmation /
 * password-reset link via the Resend API — completely bypassing Supabase's
 * internal SMTP, which is heavily rate-limited and fails with "Error sending
 * confirmation email".
 *
 *   signup   -> admin.generateLink({ type: "signup" })   (creates the user,
 *             returns the raw link WITHOUT sending any email)
 *   recovery -> admin.generateLink({ type: "recovery" }) (password reset)
 *          -> POST https://api.resend.com/emails with that link
 *
 * Emails point at the CLIENT with ?token_hash=...&type=... instead of the
 * auth server's action_link: under the PKCE flow the browser has no code
 * verifier for admin-generated links, so action_link redirects silently
 * fail to establish a session. The client calls verifyOtp({ token_hash })
 * to establish the session directly (documented custom-email pattern).
 *
 * The token hash is only ever emailed — never returned to the client or
 * logged. The client never sees the service role and never touches auth
 * admin APIs.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The Resend key may be provisioned under the canonical name or the
 * project's original private-env name — accept both.
 */
function resendApiKey(): string | null {
  return Deno.env.get("RESEND_API_KEY") ?? Deno.env.get("resend_api_key") ?? null;
}

const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "onboarding@resend.dev";
const FROM_NAME = "PortBackhaul";
const LINK_TTL_TEXT = "24 hours";

const SIGNUP_ROLES = new Set([
  "CARGO_OWNER",
  "CLEARING_AGENT",
  "TRUCK_OWNER",
  "DRIVER",
  "LOADING_OPERATOR",
]);

/** Redirect paths we are willing to put inside an emailed link. */
const ALLOWED_PATHS = new Set(["/auth/callback", "/auth/reset-password"]);

/**
 * Hosts we are willing to redirect to after email confirmation.
 * Matches:
 *   - localhost / 127.0.0.1 (any port, http or https)
 *   - *.rork.live, *.rork.app              (your production/preview domains)
 *   - *.supabase.co                        (Supabase Studio preview + project URLs)
 *   - *.vercel.app, *.netlify.app          (common preview hosts)
 *   - *.lovable.app, *.lovableproject.com  (Lovable preview hosts)
 *   - the bare apex of the above (rork.live, rork.app, etc.)
 */
function isAllowedRedirect(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!ALLOWED_PATHS.has(url.pathname)) return false;

  const host = url.hostname.toLowerCase();

  // Local development.
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  // Everything else must be HTTPS.
  if (url.protocol !== "https:") return false;

  const allowedSuffixes = [
    "rork.live",
    "rork.app",
    "supabase.co",
    "supabase.in",
    "vercel.app",
    "netlify.app",
    "lovable.app",
    "lovableproject.com",
    "lovable.dev",
  ];

  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// --- best-effort in-memory rate limiting (per edge isolate) ----------------
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_PER_EMAIL = 6;
const RATE_MAX_PER_IP = 30;
const hits = new Map<string, number[]>();

function isRateLimited(key: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

// --- validation -------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function assertValidEmail(email: unknown): string {
  if (typeof email !== "string" || !EMAIL_RE.test(email) || email.length > 254) {
    throw new AppError("EMAIL_INVALID", 400);
  }
  return email.trim().toLowerCase();
}

function assertValidPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 8 || password.length > 72) {
    throw new AppError("WEAK_PASSWORD", 400);
  }
  return password;
}

/**
 * Builds the client URL the email should point at. Uses the token hash +
 * verify type so the browser can call verifyOtp() directly (works under PKCE
 * where admin-generated action links cannot establish a session).
 */
function buildEmailActionUrl(
  redirectTo: string,
  tokenHash: string,
  verifyType: "signup" | "recovery",
): string {
  const target = new URL(redirectTo);
  const path = ALLOWED_PATHS.has(target.pathname) ? target.pathname : "/auth/callback";
  const params = new URLSearchParams({ token_hash: tokenHash, type: verifyType });
  return `${target.origin}${path}?${params.toString()}`;
}

/** Origin + path only — used for client observability, never includes tokens. */
function safeRedirectSummary(redirectTo: string): string {
  const target = new URL(redirectTo);
  return `${target.origin}${target.pathname}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// --- email template ---------------------------------------------------------

function buildEmail(
  actionLink: string,
  fullName: string | null,
  kind: "confirm" | "reset",
): { subject: string; html: string; text: string } {
  const isConfirm = kind === "confirm";
  const greeting = fullName ? `Hi ${escapeHtml(fullName.trim())},` : "Hi there,";
  const subject = isConfirm
    ? "Confirm your email · PortBackhaul"
    : "Set a new password · PortBackhaul";
  const intro = isConfirm
    ? "Thank you for registering on PortBackhaul. Please confirm your email address to activate your account." +
      " Once confirmed, our team will review and verify your account before marketplace features are enabled."
    : "We received a request to reset the password for your PortBackhaul account." +
      " Click the button below to choose a new password.";
  const cta = isConfirm ? "Confirm my email" : "Choose a new password";
  const expiry = isConfirm
    ? `This link expires after ${LINK_TTL_TEXT}. If it has expired, request a new verification email from the app.`
    : `This link expires after ${LINK_TTL_TEXT}. If it has expired, request a new reset email from the app.`;
  const footnote = isConfirm
    ? "You received this email because someone created a PortBackhaul account with this address." +
      " If this wasn't you, you can safely ignore it — the account stays inactive."
    : "You received this email because a password reset was requested for this address." +
      " If this wasn't you, you can safely ignore it — your password stays unchanged.";
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5F6F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Confirm your email address to activate your PortBackhaul account.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F4;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="background:#0F5132;border-radius:8px 8px 0 0;padding:28px 32px;">
          <span style="color:#FFFFFF;font-size:20px;font-weight:800;letter-spacing:0.06em;">PORTBACKHAUL</span><br/>
          <span style="color:#C08A2E;font-size:11px;font-weight:700;letter-spacing:0.14em;">MOVE GHANA FORWARD</span>
        </td></tr>
        <tr><td style="background:#FFFFFF;border-radius:0 0 8px 8px;padding:32px;border:1px solid #E5E7E4;border-top:none;">
          <p style="margin:0 0 16px;color:#1B263B;font-size:16px;font-weight:700;">${greeting}</p>
          <p style="margin:0 0 24px;color:#4A5560;font-size:14px;line-height:22px;">
            ${intro}
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td
            style="background:#C08A2E;border-radius:8px;">
            <a href="${actionLink}"
              style="display:inline-block;padding:14px 32px;color:#FFFFFF;font-size:15px;font-weight:700;text-decoration:none;">
              ${cta}
            </a>
          </td></tr></table>
          <p style="margin:24px 0 0;color:#4A5560;font-size:13px;line-height:20px;">
            Or copy and paste this link into your browser:<br/>
            <a href="${actionLink}" style="color:#0F5132;word-break:break-all;">${actionLink}</a>
          </p>
          <p style="margin:24px 0 0;color:#4A5560;font-size:12px;line-height:18px;">
            ${expiry}
          </p>
          <hr style="border:none;border-top:1px solid #E5E7E4;margin:28px 0;"/>
          <p style="margin:0;color:#5F6B77;font-size:12px;line-height:18px;">
            ${footnote}
          </p>
          <p style="margin:12px 0 0;color:#5F6B77;font-size:12px;">&copy; PortBackhaul &middot; Ghana road freight coordination</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = `${greeting}\n\n${
    isConfirm
      ? "Thank you for registering on PortBackhaul. Please confirm your email address to activate your account:"
      : "We received a request to reset the password for your PortBackhaul account. Choose a new password here:"
  }\n\n${actionLink}\n\nThis link expires after ${LINK_TTL_TEXT}. If it has expired, request a new email from the app.\n\nIf you didn't expect this email, you can safely ignore it.\n\nPortBackhaul - Move Ghana Forward`;
  return { subject, html, text };
}

// --- Resend -----------------------------------------------------------------

type SendResult = { ok: true } | { ok: false; status: number; message: string };

async function sendViaResend(
  to: string,
  fullName: string | null,
  actionLink: string,
  kind: "confirm" | "reset",
): Promise<SendResult> {
  const apiKey = resendApiKey()!;
  const { subject, html, text } = buildEmail(actionLink, fullName, kind);

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      reply_to: FROM_EMAIL,
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const raw = (await response.text()).slice(0, 300);
    // Log the provider status only — never the API key or link.
    console.error(`Resend send failed status=${response.status} detail=${raw}`);
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string; name?: string };
      message = parsed.message ?? parsed.name ?? raw;
    } catch {
      // keep raw text
    }
    return { ok: false, status: response.status, message };
  }
  return { ok: true };
}

// --- handler ----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "INVALID_ACTION" }, 405);

  try {
    if (!resendApiKey()) {
      // Refuse before creating any user — we never fake a successful send.
      throw new AppError("EMAIL_PROVIDER_NOT_CONFIGURED", 503);
    }

    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action;
    const redirectToRaw = typeof body.redirectTo === "string" ? body.redirectTo : undefined;

    // Log the rejected value (origin+path only) so misconfigurations are
    // diagnosable without leaking tokens. Emails are never put in the log.
    if (!isAllowedRedirect(redirectToRaw)) {
      let safeValue = "missing";
      if (redirectToRaw) {
        try {
          const u = new URL(redirectToRaw);
          safeValue = `${u.origin}${u.pathname}`;
        } catch {
          safeValue = "unparseable";
        }
      }
      console.error(`INVALID_REDIRECT: received redirectTo=${safeValue}`);
      throw new AppError("INVALID_REDIRECT", 400);
    }

    const email = assertValidEmail(body.email);
    if (
      isRateLimited(`email:${email}`, RATE_MAX_PER_EMAIL) ||
      isRateLimited(`ip:${clientIp(req)}`, RATE_MAX_PER_IP)
    ) {
      throw new AppError("EMAIL_RATE_LIMITED", 429);
    }

    const admin = createAdminClient();
    let actionLink: string;
    let emailKind: "confirm" | "reset" = "confirm";
    let fullName: string | null = typeof body.full_name === "string" ? body.full_name : null;

    if (action === "recovery") {
      // Password reset. Only addresses that already have an account get a
      // real link; unknown addresses get the same silent success.
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo: redirectToRaw! },
      });
      if (linkError || !link) {
        const message = linkError?.message ?? "";
        console.error(`recovery link failed for ${email.split("@")[1] ?? "unknown"}: ${message.slice(0, 200)}`);
        // Stay silent (anti-enumeration), mirroring Supabase's own behaviour.
        return json({ sent: true });
      }
      const metaName = (link.user.user_metadata as { full_name?: unknown } | null | undefined)?.full_name;
      fullName = typeof metaName === "string" && metaName.trim() ? metaName : fullName;
      actionLink = buildEmailActionUrl(redirectToRaw!, link.properties.hashed_token, "recovery");
      emailKind = "reset";
    } else {
      const password = action === "resend" ? null : assertValidPassword(body.password);
      const signupMeta = {
        redirectTo: redirectToRaw!,
        data: {
          full_name: typeof body.full_name === "string" ? body.full_name : null,
          phone: typeof body.phone === "string" ? body.phone : null,
          company_name: typeof body.company_name === "string" ? body.company_name : null,
          // The database trigger rejects ADMIN — roles cannot be self-escalated.
          role: typeof body.role === "string" && SIGNUP_ROLES.has(body.role) ? body.role : "CARGO_OWNER",
        },
      };
      // The resend probe intentionally omits `password` so GoTrue's own
      // validation rejects unknown addresses (anti-enumeration). The signup
      // link contract requires a password, so the two payloads are built
      // separately instead of conditionally spreading one object literal.
      const linkParams = (
        password === null
          ? { type: "signup" as const, email }
          : { type: "signup" as const, email, password, options: signupMeta }
      ) as Parameters<typeof admin.auth.admin.generateLink>[0];
      const { data: link, error: linkError } = await admin.auth.admin.generateLink(linkParams);

      if (linkError || !link) {
        const message = linkError?.message ?? "";
        console.error(`generateLink failed for ${email.split("@")[1] ?? "unknown"}: ${message.slice(0, 200)}`);
        if (/already (been )?registered/i.test(message)) throw new AppError("EMAIL_ALREADY_REGISTERED", 409);
        if (action === "resend") {
          // Resend to an address that never registered: stay silent (anti-enumeration),
          // mirroring Supabase's own /resend behaviour.
          return json({ sent: true });
        }
        throw new AppError("SIGNUP_FAILED", 502);
      }

      if (password !== null) {
        // GoTrue's generateLink keeps the ORIGINAL password when the user
        // already exists — sync it to what was just typed, otherwise a
        // retried signup silently stores a password the user never learns.
        const { error: pwError } = await admin.auth.admin.updateUserById(link.user.id, { password });
        if (pwError) {
          console.error(
            `password sync failed for ${email.split("@")[1] ?? "unknown"}: ${pwError.message.slice(0, 200)}`,
          );
          throw new AppError("SIGNUP_FAILED", 502);
        }
      }

      actionLink = buildEmailActionUrl(redirectToRaw!, link.properties.hashed_token, "signup");
    }

    // Origin + path only, so the client can surface redirect discrepancies.
    // Never return or log the token itself.
    const verifyRedirect = safeRedirectSummary(redirectToRaw!);

    const result = await sendViaResend(email, fullName, actionLink, emailKind);
    if (!result.ok) {
      if (result.status === 429) throw new AppError("EMAIL_RATE_LIMITED", 429);
      // Surface the provider's exact rejection so delivery issues stay diagnosable.
      // Resend error bodies never contain credentials.
      return json({ error: "EMAIL_SEND_FAILED", providerMessage: result.message }, 502);
    }

    return json({ sent: true, verifyRedirect });
  } catch (err) {
    return errorResponse(err);
  }
});