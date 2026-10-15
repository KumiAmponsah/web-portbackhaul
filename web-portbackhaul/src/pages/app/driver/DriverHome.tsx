import { useMemo, useState } from "react";
import {
  Check,
  CircleDollarSign,
  Loader2,
  MapPin,
  Navigation,
  Package,
  Power,
  Truck,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Seo } from "@/components/Seo";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { useAssignments, useRespondToAssignment } from "@/hooks/use-assignments";
import { useMyDriverRecord, useSetDriverAvailability, useTrucks } from "@/hooks/use-fleet";
import { usePayouts } from "@/hooks/use-payments";
import { useShipments } from "@/hooks/use-shipments";
import { useTrips } from "@/hooks/use-trips";
import { describeError } from "@/lib/errors";
import { formatDateTime, formatGhs, formatWeight } from "@/lib/format";

const ACTIVE_TRIP_STATUSES = [
  "DRIVER_ACCEPTED",
  "DRIVER_ARRIVED",
  "LOADING",
  "LOADED",
  "IN_TRANSIT",
  "ARRIVED_DESTINATION",
];

export default function DriverHome() {
  const { profile } = useAuth();
  const {
    data: driver,
    isLoading: loadingDriver,
    isError: driverFailed,
    error: driverError,
    refetch: refetchDriver,
  } = useMyDriverRecord();
  const { data: assignments } = useAssignments();
  const { data: trips } = useTrips();
  const { data: shipments } = useShipments();
  const { data: trucks } = useTrucks();
  const { data: payouts } = usePayouts();

  const setAvailability = useSetDriverAvailability();
  const respond = useRespondToAssignment();
  const [busyId, setBusyId] = useState<string | null>(null);

  const offers = useMemo(
    () => (assignments ?? []).filter((a) => a.status === "OFFERED"),
    [assignments],
  );

  const activeTrip = useMemo(
    () => (trips ?? []).find((t) => ACTIVE_TRIP_STATUSES.includes(t.status)) ?? null,
    [trips],
  );

  const shipmentById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof shipments>[number]>();
    for (const shipment of shipments ?? []) map.set(shipment.id, shipment);
    return map;
  }, [shipments]);

  const truck = useMemo(
    () => (trucks ?? []).find((t) => t.id === driver?.assigned_truck_id) ?? null,
    [trucks, driver],
  );

  const earnings = useMemo(() => {
    const rows = payouts ?? [];
    return {
      paid: rows.filter((p) => p.status === "PAID").reduce((sum, p) => sum + Number(p.amount_ghs), 0),
      pending: rows.filter((p) => p.status !== "PAID" && p.status !== "CANCELLED").reduce((sum, p) => sum + Number(p.amount_ghs), 0),
    };
  }, [payouts]);

  async function handleRespond(assignmentId: string, accept: boolean) {
    setBusyId(assignmentId);
    try {
      await respond.mutateAsync({ assignmentId, accept, reason: accept ? undefined : "Declined by driver" });
      toast.success(accept ? "Job accepted. Your trip has been created." : "Job declined.");
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusyId(null);
    }
  }

  async function handleAvailability(next: boolean) {
    if (!driver) return;
    try {
      await setAvailability.mutateAsync({ driverId: driver.id, available: next });
      toast.success(next ? "You're available for cargo" : "You're now off duty");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  if (driverFailed) {
    return (
      <div className="p-8">
        <QueryErrorState error={driverError} onRetry={() => void refetchDriver()} subject="your driver profile" />
      </div>
    );
  }

  if (loadingDriver) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your driver profile…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[900px] animate-fade space-y-6">
      <Seo title="Driver · PortBackhaul" description="Your jobs, trips and earnings." path="/app/driver" noIndex />

      <PageHeader
        eyebrow="Driver"
        title={profile?.full_name ?? "Driver"}
        subtitle={truck ? `Assigned truck ${truck.registration_no} · ${truck.capacity_tons}T` : "No truck linked yet"}
      />

      {/* Availability — the primary driver control, deliberately large */}
      <section className="panel flex items-center justify-between gap-4 p-6">
        <div className="flex items-center gap-4">
          <span
            className={`flex h-14 w-14 items-center justify-center rounded-lg ${
              driver?.is_available ? "bg-status-verified-bg text-status-verified" : "bg-muted text-muted-foreground"
            }`}
          >
            <Power className="h-7 w-7" aria-hidden />
          </span>
          <div>
            <h2 className="text-xl font-extrabold">Available for cargo</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {driver?.is_available ? "You will receive matching job offers." : "You will not be offered new jobs."}
            </p>
          </div>
        </div>
        <Switch
          checked={driver?.is_available ?? false}
          onCheckedChange={(checked) => void handleAvailability(checked)}
          aria-label="Available for cargo"
          className="scale-125"
        />
      </section>

      {/* Current job */}
      <section>
        <h2 className="eyebrow mb-3">Current job</h2>
        {activeTrip ? (
          <Link
            to={`/app/driver/trip/${activeTrip.id}`}
            className="panel block p-6 transition-all hover:border-primary/40 hover:shadow-[0_2px_8px_rgba(27,38,59,0.08)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <span className="font-mono text-lg font-bold tabular">{activeTrip.trip_ref}</span>
                <p className="mt-1.5 flex items-center gap-1.5 text-base font-semibold">
                  <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {activeTrip.pickup_location_text} → {activeTrip.destination_text}
                </p>
              </div>
              <StatusBadge status={activeTrip.status} raw />
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <span className="font-mono text-xl font-extrabold tabular text-primary">
                {formatGhs(activeTrip.transport_fee_ghs)}
              </span>
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                <Navigation className="h-4 w-4" aria-hidden />
                Open trip
              </span>
            </div>
          </Link>
        ) : (
          <div className="panel">
            <EmptyState
              icon={Truck}
              title="No active trip"
              description="Accept a job offer below to start a trip."
            />
          </div>
        )}
      </section>

      {/* Job offers */}
      <section>
        <h2 className="eyebrow mb-3">Job invitations ({offers.length})</h2>
        {offers.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={Package}
              title="No job offers right now"
              description="Stay available and verified — matching offers will arrive here and by notification."
            />
          </div>
        ) : (
          <div className="space-y-4">
            {offers.map((offer) => {
              const shipment = shipmentById.get(offer.shipment_id);
              return (
                <article key={offer.id} className="panel animate-rise p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <span className="font-mono text-sm font-bold tabular text-muted-foreground">
                        {shipment?.cargo_ref ?? "New job"}
                      </span>
                      <h3 className="mt-1 text-xl font-extrabold">
                        {offer.route_origin} → {offer.route_destination}
                      </h3>
                    </div>
                    <span className="font-mono text-2xl font-extrabold tabular text-primary">
                      {formatGhs(offer.offered_fee_ghs)}
                    </span>
                  </div>

                  <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm sm:grid-cols-4">
                    <Field label="Cargo" value={shipment?.description ?? offer.truck_type.replace(/_/g, " ")} />
                    <Field label="Weight" value={formatWeight(shipment?.weight_kg ?? null)} />
                    <Field label="Truck type" value={offer.truck_type.replace(/_/g, " ")} />
                    <Field label="Pickup" value={formatDateTime(offer.pickup_at)} />
                  </dl>

                  {offer.requirements_notes ? (
                    <p className="mt-3 rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
                      {offer.requirements_notes}
                    </p>
                  ) : null}

                  <div className="mt-5 flex gap-3">
                    <Button
                      size="lg"
                      className="h-14 flex-1 text-base"
                      onClick={() => void handleRespond(offer.id, true)}
                      disabled={busyId === offer.id}
                    >
                      {busyId === offer.id ? (
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      ) : (
                        <Check className="mr-2 h-5 w-5" />
                      )}
                      Accept
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      className="h-14 flex-1 text-base"
                      onClick={() => void handleRespond(offer.id, false)}
                      disabled={busyId === offer.id}
                    >
                      <X className="mr-2 h-5 w-5" />
                      Decline
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Earnings */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="panel p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CircleDollarSign className="h-4 w-4" aria-hidden />
            Paid out
          </p>
          <p className="mt-1 font-mono text-2xl font-extrabold tabular text-status-verified">{formatGhs(earnings.paid)}</p>
        </div>
        <div className="panel p-5">
          <p className="text-sm font-medium text-muted-foreground">Awaiting release</p>
          <p className="mt-1 font-mono text-2xl font-extrabold tabular text-status-pending">{formatGhs(earnings.pending)}</p>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to="/app/driver/trips">Completed trips</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/app/driver/earnings">Earnings detail</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/app/profile">Profile & documents</Link>
        </Button>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow mb-0.5">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
