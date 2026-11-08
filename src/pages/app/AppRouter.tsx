import {
  Bell,
  CheckCircle2,
  ClipboardList,
  FileText,
  Loader2,
  MapPin,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Navigate, Outlet } from "react-router-dom";

import { AppShell, type NavItem } from "@/components/app/AppShell";
import { useAuth } from "@/hooks/use-auth";
import { ROLE_HOME, ROLE_LABEL, type Role } from "@/lib/roles";

const NAV_BY_ROLE: Record<Role, NavItem[]> = {
  CLEARING_AGENT: [
    { to: "/app/agent/new-cargo", label: "New Cargo", icon: FileText },
    { to: "/app/agent/request-truck", label: "Request Truck", icon: Truck },
    { to: "/app/agent/available-trucks", label: "Available Trucks", icon: Users },
    { to: "/app/agent/trips", label: "Active Trips", icon: MapPin },
    { to: "/app/agent/completed", label: "Completed", icon: CheckCircle2 },
  ],
  DRIVER: [
    { to: "/app/driver", label: "My Jobs", icon: Truck, end: true },
    { to: "/app/driver/trips", label: "My Trips", icon: MapPin },
    { to: "/app/driver/earnings", label: "Earnings", icon: Bell },
    { to: "/app/notifications", label: "Notifications", icon: Bell },
  ],
  ADMIN: [{ to: "/admin", label: "Admin Dashboard", icon: ClipboardList }],
};

/** Role-aware application shell shared by every authenticated non-admin screen. */
export function AppLayout() {
  const { profile } = useAuth();
  
  // Show a spinner while the profile is loading
  if (!profile) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <AppShell nav={NAV_BY_ROLE[profile.role]} sectionLabel={ROLE_LABEL[profile.role]}>
      <Outlet />
    </AppShell>
  );
}

/** /app redirects each role to its own home screen. */
export function AppIndexRedirect() {
  const { profile } = useAuth();
  
  // 1. While loading the profile, show a spinner instead of a blank white screen
  if (!profile) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  
  // 2. Redirect based on account status
  if (profile.account_status !== "APPROVED") {
    return <Navigate to="/app/account-status" replace />;
  }
  
  // 3. Redirect to their specific dashboard
  const homeRoute = ROLE_HOME[profile.role];
  if (!homeRoute) {
    // Safe fallback just in case the role isn't in the map
    return <Navigate to="/app/account-status" replace />;
  }

  return <Navigate to={homeRoute} replace />;
}

export type { LucideIcon };