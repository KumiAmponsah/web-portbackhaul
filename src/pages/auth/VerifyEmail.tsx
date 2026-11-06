import { Loader2, MailCheck, RefreshCw, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Logo } from "@/components/Logo";
import { Seo } from "@/components/Seo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { describeError } from "@/lib/errors";

import { AuthPanel } from "./AuthPanel";

export default function VerifyEmail() {
  // 1. All hooks called at the top level
  const { user, isEmailVerified, resendVerification, refresh, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as "signup" | "email" | "recovery" | null;

  const stateEmail = (location.state as { email?: string } | null)?.email;
  const [email, setEmail] = useState<string>(stateEmail ?? user?.email ?? "");
  const [resending, setResending] = useState<boolean>(false);
  const [verifying, setVerifying] = useState<boolean>(false);
  const [verified, setVerified] = useState<boolean>(false);

  // If already verified and logged in (and not in the middle of token verification), go to app
  if (user && isEmailVerified && !tokenHash) return <Navigate to="/" replace />;

  async function handleResend() {
    if (!email.trim()) {
      toast.error("Enter the email address you registered with.");
      return;
    }
    setResending(true);
    try {
      await resendVerification(email.trim());
      toast.success("Verification email sent. Please check your inbox.");
    } catch (error) {
      toast.error(describeError(error, "Could not resend the verification email."));
    } finally {
      setResending(false);
    }
  }

  async function handleVerifyToken() {
    if (!tokenHash) {
      toast.error("No verification token found in the link.");
      return;
    }
    setVerifying(true);
    try {
      // Securely verify the token hash with Supabase
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type ?? "signup",
      });

      if (error) throw error;

      setVerified(true);
      await refresh();
      toast.success("Email verified successfully!");
      
      // Redirect after a short delay so they see the success message
      setTimeout(() => {
        navigate("/", { replace: true });
      }, 1500);
    } catch (error) {
      toast.error(describeError(error, "Could not verify email. The link may have expired."));
    } finally {
      setVerifying(false);
    }
  }

  async function handleCheck() {
    setVerifying(true);
    try {
      await refresh();
      const { data } = await supabase.auth.getUser();
      if (data.user?.email_confirmed_at) {
        toast.success("Email verified");
        navigate("/", { replace: true });
      } else {
        toast.error("We can't see a verification yet. Click the link in the email, then try again.");
      }
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setVerifying(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }

  // View: User clicked the email link and arrived here with a token
  if (tokenHash) {
    return (
      <AuthPanel>
        <Seo title="Confirm your email · PortBackhaul" description="Confirm your email address." path="/verify-email" noIndex />

        <Link to="/" className="mb-8 inline-block" aria-label="PortBackhaul home">
          <Logo />
        </Link>

        {verified ? (
          <>
            <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-status-verified-bg text-status-verified">
              <CheckCircle2 className="h-6 w-6" aria-hidden />
            </span>
            <h1 className="text-2xl font-extrabold tracking-tight">Email verified!</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Your account is ready. Redirecting you to the dashboard...
            </p>
            <div className="mt-6 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          </>
        ) : (
          <>
            <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-status-progress-bg text-status-progress">
              <MailCheck className="h-6 w-6" aria-hidden />
            </span>
            <h1 className="text-2xl font-extrabold tracking-tight">Confirm your email</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Click the button below to securely verify your email address and activate your account.
            </p>
            <div className="mt-7">
              <Button onClick={() => void handleVerifyToken()} disabled={verifying} className="w-full h-12 text-base">
                {verifying ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <CheckCircle2 className="mr-2 h-5 w-5" />}
                Confirm my email
              </Button>
            </div>
          </>
        )}
      </AuthPanel>
    );
  }

  // View: User just registered and needs to check their email
  return (
    <AuthPanel>
      <Seo title="Verify your email · PortBackhaul" description="Confirm your email address." path="/verify-email" noIndex />

      <Link to="/" className="mb-8 inline-block" aria-label="PortBackhaul home">
        <Logo />
      </Link>

      <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-status-verified-bg text-status-verified">
        <MailCheck className="h-6 w-6" aria-hidden />
      </span>

      <h1 className="text-2xl font-extrabold tracking-tight">Check your email</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        We sent a verification link to your email. Please click the link to verify your account.
      </p>

      <div className="mt-7 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="verify-email">Email address</Label>
          <Input
            id="verify-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => void handleCheck()} disabled={verifying} className="flex-1">
            {verifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            I've verified my email
          </Button>
          <Button variant="outline" onClick={() => void handleResend()} disabled={resending} className="flex-1">
            {resending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Resend email
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleSignOut()}
        className="mt-8 text-sm text-muted-foreground underline hover:text-foreground"
      >
        Use a different account
      </button>
    </AuthPanel>
  );
}