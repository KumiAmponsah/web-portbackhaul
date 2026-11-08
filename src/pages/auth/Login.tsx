import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Logo } from "@/components/Logo";
import { Seo } from "@/components/Seo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { describeError } from "@/lib/errors";
import { ROLE_HOME } from "@/lib/roles";

import { AuthPanel } from "./AuthPanel";

export default function Login() {
  // Assuming your useAuth hook provides a `loading` or `isLoading` boolean
  // If it's named differently, change it here (e.g., isLoading)
  const { signIn, session, profile, isEmailVerified, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  // 1. Wait for the auth state and profile to finish loading
  if (loading) {
    return (
      <AuthPanel>
        <div className="flex h-[50vh] flex-col items-center justify-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading your account...</p>
        </div>
      </AuthPanel>
    );
  }

  // 2. Now we can safely redirect based on the loaded state
  if (session && !isEmailVerified) return <Navigate to="/verify-email" replace />;
  if (session && profile) return <Navigate to={ROLE_HOME[profile.role]} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      toast.success("Signed in");
      // Navigate to /app, the AppRouter will handle the role-based redirect
      navigate("/app", { replace: true });
    } catch (error) {
      toast.error(describeError(error, "Could not sign in."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPanel>
      <Seo
        title="Sign in · PortBackhaul"
        description="Sign in to your PortBackhaul account to manage shipments, trucks and trips."
        path="/login"
        noIndex
      />

      <Link to="/" className="mb-8 inline-block" aria-label="PortBackhaul home">
        <Logo />
      </Link>

      <h1 className="text-2xl font-extrabold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Access your shipments, trips and payments.
      </p>

      <form onSubmit={handleSubmit} className="mt-7 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email address</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-xs font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        New to PortBackhaul?{" "}
        <Link to="/register" className="font-semibold text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </AuthPanel>
  );
}