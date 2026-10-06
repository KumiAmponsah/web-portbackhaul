import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Navigation,
  QrCode,
  Upload,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { QueryErrorState } from "@/components/QueryErrorState";
import { RouteMap } from "@/components/RouteMap";
import { Seo } from "@/components/Seo";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useTrucks } from "@/hooks/use-fleet";
import { useShipment } from "@/hooks/use-shipments";
import {
  useConfirmDelivery,
  useDriverAdvanceTrip,
  useRecordTripLocation,
  useTrip,
  useTripHistory,
  useTripLocations,
} from "@/hooks/use-trips";
import { supabase } from "@/integrations/supabase/client";
import { describeError } from "@/lib/errors";
import { formatGhs, formatTime, formatWeight } from "@/lib/format";
import { statusLabel } from "@/lib/status";

const TRACKED_STATUSES = [
  "DRIVER_ACCEPTED",
  "DRIVER_ARRIVED",
  "LOADING",
  "LOADED",
  "IN_TRANSIT",
  "ARRIVED_DESTINATION",
];

export default function DriverTrip() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const { data: trip, isLoading, isError, error, refetch } = useTrip(id);
  const { data: shipment } = useShipment(trip?.shipment_id);
  const { data: trucks } = useTrucks();
  const { data: history } = useTripHistory(id);
  const { data: locations } = useTripLocations(id);

  const advance = useDriverAdvanceTrip();
  const recordLocation = useRecordTripLocation();
  const confirmDelivery = useConfirmDelivery();

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState<boolean>(false);
  const [otp, setOtp] = useState<string>("");
  const [receiverName, setReceiverName] = useState<string>("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [uploading, setUploading] = useState<boolean>(false);

  const truck = useMemo(
    () => (trucks ?? []).find((t) => t.id === trip?.truck_id) ?? null,
    [trucks, trip],
  );
  const lastPing = locations?.[locations.length - 1] ?? null;
  const isTracked = trip ? TRACKED_STATUSES.includes(trip.status) : false;

  // Load the trip's QR token (drivers can read only their own trip's token).
  useEffect(() => {
    if (!trip?.id) return;
    let cancelled = false;

    void (async () => {
      const { data, error } = await supabase
        .from("qr_tokens")
        .select("token, expires_at")
        .eq("trip_id", trip.id)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data?.token || cancelled) return;

      // The QR contains only an opaque random token — never cargo or personal data.
      const url = await QRCode.toDataURL(data.token, {
        width: 320,
        margin: 1,
        color: { dark: "#1B263B", light: "#FFFFFF" },
      });
      if (!cancelled) setQrDataUrl(url);
    })();

    return () => {
      cancelled = true;
    };
  }, [trip?.id]);

  // Location sharing runs only while the trip is active, at a throttled interval.
  useEffect(() => {
    if (!sharing || !trip?.id || !isTracked) return;
    if (!("geolocation" in navigator)) {
      toast.error("Location is unavailable on this device.");
      setSharing(false);
      return;
    }

    const push = () => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          void recordLocation.mutateAsync({
            tripId: trip.id,
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            speed: position.coords.speed ? position.coords.speed * 3.6 : null,
            heading: position.coords.heading ?? null,
            accuracy: position.coords.accuracy ?? null,
          });
        },
        (error) => {
          console.error("Geolocation failed", error.message);
          toast.error("Location unavailable. Enable location access to keep sharing.");
          setSharing(false);
        },
        { enableHighAccuracy: true, timeout: 15_000 },
      );
    };

    push();
    const interval = window.setInterval(push, 120_000);
    return () => window.clearInterval(interval);
  }, [sharing, trip?.id, isTracked, recordLocation]);

  if (isError) {
    return (
      <div className="p-8">
        <QueryErrorState error={error} onRetry={() => void refetch()} subject="this trip" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading trip…
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="panel mx-auto max-w-lg p-8 text-center">
        <h1 className="text-lg font-bold">Trip not available</h1>
        <p className="mt-2 text-sm text-muted-foreground">You are not assigned to this trip.</p>
        <Button asChild className="mt-5" variant="outline">
          <Link to="/app/driver">Back to jobs</Link>
        </Button>
      </div>
    );
  }

  async function handleAdvance(action: string) {
    try {
      await advance.mutateAsync({ tripId: trip!.id, action });
      toast.success("Trip updated");
      if (action === "START_TRIP") setSharing(true);
      if (action === "ARRIVED_DESTINATION") setSharing(false);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function handleEvidenceUpload(file: File) {
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${user!.id}/delivery/${trip!.id}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("delivery-evidence").upload(path, file);
      if (error) throw new Error(describeError(error));
      setEvidence((prev) => [...prev, path]);
      toast.success("Evidence uploaded");
    } catch (error) {
      toast.error(describeError(error, "Upload failed."));
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirmDelivery() {
    if (!otp.trim() || !receiverName.trim()) {
      toast.error("Enter the receiver's name and the delivery code they were given.");
      return;
    }
    try {
      await confirmDelivery.mutateAsync({
        tripId: trip!.id,
        otp: otp.trim(),
        receiverName: receiverName.trim(),
        evidence,
      });
      toast.success("Delivery confirmed. Payment release has been requested.");
      setOtp("");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  const nextAction =
    trip.status === "DRIVER_ACCEPTED"
      ? { action: "CONFIRM_ARRIVAL", label: "Confirm arrival at pickup" }
      : trip.status === "LOADED"
        ? { action: "START_TRIP", label: "Start trip" }
        : trip.status === "IN_TRANSIT"
          ? { action: "ARRIVED_DESTINATION", label: "Arrived at destination" }
          : null;

  return (
    <div className="mx-auto w-full max-w-[900px] animate-fade space-y-6">
      <Seo
        title={`${trip.trip_ref} · PortBackhaul`}
        description="Driver trip."
        path={`/app/driver/trip/${trip.id}`}
        noIndex
      />

      <Link
        to="/app/driver"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to jobs
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono tabular">{trip.trip_ref}</span>
            <StatusBadge status={trip.status} raw className="text-xs" />
          </span>
        }
        subtitle={`${trip.pickup_location_text} → ${trip.destination_text}`}
        meta={
          <span className="font-mono text-lg font-extrabold tabular text-primary">
            {formatGhs(trip.transport_fee_ghs)}
          </span>
        }
      />

      <section className="panel p-5">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Field label="Cargo" value={shipment?.description ?? "—"} />
          <Field label="Weight" value={formatWeight(shipment?.weight_kg ?? null)} />
          <Field label="Container" value={shipment?.container_number ?? "—"} mono />
          <Field label="Truck" value={truck?.registration_no ?? "—"} mono />
        </dl>
      </section>

      {nextAction ? (
        <Button
          size="lg"
          className="h-16 w-full text-lg"
          onClick={() => void handleAdvance(nextAction.action)}
          disabled={advance.isPending}
        >
          {advance.isPending ? (
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          ) : (
            <CheckCircle2 className="mr-2 h-5 w-5" />
          )}
          {nextAction.label}
        </Button>
      ) : null}

      {trip.status === "DRIVER_ARRIVED" || trip.status === "LOADING" ? (
        <div className="panel bg-status-pending-bg p-5 text-center">
          <p className="text-sm font-semibold text-status-pending">
            Waiting for the clearing agent to confirm loading. Show your QR code at the gate.
          </p>
        </div>
      ) : null}

      {/* QR code for loading-point verification */}
      <section className="panel p-6 text-center">
        <h2 className="flex items-center justify-center gap-2 text-base font-bold">
          <QrCode className="h-5 w-5" aria-hidden />
          Trip verification code
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Show this at the loading point. It contains only a secure random token — no cargo or personal
          information.
        </p>
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={`Verification QR code for trip ${trip.trip_ref}`}
            className="mx-auto mt-5 h-64 w-64 rounded-lg border border-border"
          />
        ) : (
          <div className="mx-auto mt-5 flex h-64 w-64 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
            Generating code…
          </div>
        )}
      </section>

      {/* Tracking */}
      {isTracked ? (
        <section className="panel p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold">Live tracking</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Location is shared only while this trip is active, at 2-minute intervals.
              </p>
            </div>
            <Button variant={sharing ? "outline" : "default"} onClick={() => setSharing((v) => !v)}>
              <Navigation className="mr-2 h-4 w-4" />
              {sharing ? "Stop sharing" : "Share my location"}
            </Button>
          </div>

          <RouteMap
            className="mt-5"
            pickup={
              trip.pickup_lat !== null && trip.pickup_lng !== null
                ? {
                    lat: trip.pickup_lat,
                    lng: trip.pickup_lng,
                    label: trip.pickup_location_text ?? undefined,
                  }
                : null
            }
            destination={
              trip.destination_lat !== null && trip.destination_lng !== null
                ? {
                    lat: trip.destination_lat,
                    lng: trip.destination_lng,
                    label: trip.destination_text ?? undefined,
                  }
                : null
            }
            trail={(locations ?? []).map((l) => ({ lat: l.latitude, lng: l.longitude }))}
            current={lastPing ? { lat: lastPing.latitude, lng: lastPing.longitude } : null}
            lastUpdated={lastPing?.recorded_at ?? null}
            height={280}
          />
        </section>
      ) : null}

      {/* Delivery confirmation */}
      {trip.status === "ARRIVED_DESTINATION" ? (
        <section className="panel p-6">
          <h2 className="text-base font-bold">Confirm delivery</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Ask the clearing agent for the 6-digit delivery code, then record who received the cargo.
          </p>

          <div className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="receiver">Receiver name</Label>
              <Input
                id="receiver"
                className="h-12"
                value={receiverName}
                onChange={(e) => setReceiverName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="otp">Delivery code</Label>
              <Input
                id="otp"
                className="h-12 font-mono text-lg tracking-[0.3em]"
                maxLength={6}
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="000000"
              />
            </div>

            <div>
              <Label htmlFor="evidence" className="mb-1.5 block">
                Delivery evidence ({evidence.length})
              </Label>
              <input
                id="evidence"
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleEvidenceUpload(file);
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full"
                onClick={() => document.getElementById("evidence")?.click()}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload photo or document
              </Button>
            </div>

            <Button
              size="lg"
              className="h-14 w-full text-base"
              onClick={() => void handleConfirmDelivery()}
              disabled={confirmDelivery.isPending}
            >
              {confirmDelivery.isPending ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-5 w-5" />
              )}
              Confirm delivery
            </Button>
          </div>
        </section>
      ) : null}

      {(history ?? []).length > 0 ? (
        <section className="panel p-6">
          <h2 className="text-base font-bold">Trip history</h2>
          <ol className="mt-4 space-y-3">
            {(history ?? []).map((event) => (
              <li key={event.id} className="flex items-start gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{statusLabel(event.new_status)}</span>
                  {event.note ? <span className="block text-muted-foreground">{event.note}</span> : null}
                </span>
                <span className="shrink-0 font-mono text-xs tabular text-muted-foreground">
                  {formatTime(event.created_at)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow mb-0.5">{label}</dt>
      <dd className={`truncate font-medium ${mono ? "font-mono tabular" : ""}`}>{value}</dd>
    </div>
  );
}