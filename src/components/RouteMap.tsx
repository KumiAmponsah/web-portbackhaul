import { Clock, Minus, Plus, Truck } from "lucide-react";
import { useMemo, useState } from "react";

import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface MapPoint {
  lat: number;
  lng: number;
  label?: string;
}

interface RouteMapProps {
  pickup: MapPoint | null;
  destination: MapPoint | null;
  /** Ordered GPS trail, oldest first. */
  trail?: MapPoint[];
  current?: MapPoint | null;
  lastUpdated?: string | null;
  className?: string;
  height?: number;
}

/**
 * Map provider abstraction.
 *
 * This renders a self-contained schematic route view with no third-party map
 * dependency or API key. It is deliberately isolated so a real provider
 * (Mapbox, Google, MapLibre) can be swapped in behind the same props without
 * touching any calling screen.
 */
export function RouteMap({
  pickup,
  destination,
  trail = [],
  current,
  lastUpdated,
  className,
  height = 320,
}: RouteMapProps) {
  const [zoom, setZoom] = useState<number>(1);

  const points = useMemo<MapPoint[]>(() => {
    const all: MapPoint[] = [];
    if (pickup) all.push(pickup);
    all.push(...trail);
    if (current) all.push(current);
    if (destination) all.push(destination);
    return all;
  }, [pickup, destination, trail, current]);

  const projection = useMemo(() => {
    if (points.length === 0) return null;
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    const padLat = Math.max((maxLat - minLat) * 0.18, 0.4);
    const padLng = Math.max((maxLng - minLng) * 0.18, 0.4);

    const spanLat = maxLat - minLat + padLat * 2;
    const spanLng = maxLng - minLng + padLng * 2;

    return (point: MapPoint): { x: number; y: number } => ({
      x: ((point.lng - (minLng - padLng)) / spanLng) * 1000,
      // latitude increases northwards, SVG y increases downwards
      y: (1 - (point.lat - (minLat - padLat)) / spanLat) * 600,
    });
  }, [points]);

  if (!projection || !pickup || !destination) {
    return (
      <div
        className={cn("flex items-center justify-center rounded-lg border border-border bg-muted/40", className)}
        style={{ height }}
      >
        <p className="text-sm text-muted-foreground">Route coordinates are not available for this trip.</p>
      </div>
    );
  }

  const pickupXY = projection(pickup);
  const destXY = projection(destination);
  const currentXY = current ? projection(current) : null;
  const trailXY = trail.map(projection);

  const linePoints = [pickupXY, ...trailXY, ...(currentXY ? [currentXY] : [])]
    .map((p) => `${p.x},${p.y}`)
    .join(" ");

  const remainingPoints = [currentXY ?? pickupXY, destXY].map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className={cn("relative overflow-hidden rounded-lg border border-border bg-[#E8EDE8]", className)} style={{ height }}>
      <svg
        viewBox="0 0 1000 600"
        className="h-full w-full transition-transform duration-300"
        style={{ transform: `scale(${zoom})` }}
        role="img"
        aria-label={`Route from ${pickup.label ?? "pickup"} to ${destination.label ?? "destination"}`}
      >
        <defs>
          <pattern id="map-grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M50 0H0v50" fill="none" stroke="rgba(27,38,59,0.07)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="1000" height="600" fill="url(#map-grid)" />

        {/* schematic coastline at the southern edge */}
        <path d="M0 560 Q 250 530, 500 555 T 1000 540 L1000 600 L0 600 Z" fill="#CFE0E8" opacity="0.7" />

        {/* remaining leg */}
        <polyline
          points={remainingPoints}
          fill="none"
          stroke="hsl(var(--secondary))"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray="10 10"
          opacity="0.35"
        />

        {/* completed leg */}
        <polyline
          points={linePoints}
          fill="none"
          stroke="hsl(var(--secondary))"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-draw"
        />

        <MapPin x={pickupXY.x} y={pickupXY.y} label={pickup.label} />
        <MapPin x={destXY.x} y={destXY.y} label={destination.label} />

        {currentXY ? (
          <g transform={`translate(${currentXY.x}, ${currentXY.y})`}>
            <circle r="22" fill="hsl(var(--secondary))" opacity="0.18" className="animate-pulse-dot" />
            <circle r="15" fill="hsl(var(--primary))" stroke="white" strokeWidth="3" />
            <g transform="translate(-8,-8)" fill="white">
              <rect x="1" y="5" width="8" height="6" rx="1" />
              <path d="M9 7h3l2 2v2H9z" />
              <circle cx="4" cy="12.5" r="1.6" />
              <circle cx="11.5" cy="12.5" r="1.6" />
            </g>
          </g>
        ) : null}
      </svg>

      <div className="absolute left-3 top-3 flex flex-col overflow-hidden rounded-md border border-border bg-card shadow-sm">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center border-b border-border transition-colors hover:bg-muted"
          onClick={() => setZoom((z) => Math.min(2.2, z + 0.2))}
          aria-label="Zoom in"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center transition-colors hover:bg-muted"
          onClick={() => setZoom((z) => Math.max(1, z - 0.2))}
          aria-label="Zoom out"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>

      {lastUpdated ? (
        <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium shadow-sm">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Last updated {relativeTime(lastUpdated)}
        </div>
      ) : null}

      {!current ? (
        <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm">
          <Truck className="h-3.5 w-3.5" aria-hidden />
          No live position yet
        </div>
      ) : null}
    </div>
  );
}

function MapPin({ x, y, label }: { x: number; y: number; label?: string }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <path
        d="M0 4 C -9 -6, -14 -12, -14 -19 A 14 14 0 1 1 14 -19 C 14 -12, 9 -6, 0 4 Z"
        fill="hsl(var(--accent))"
        stroke="white"
        strokeWidth="2.5"
      />
      <circle cy="-19" r="5" fill="white" />
      {label ? (
        <text x="20" y="-14" fontSize="19" fontWeight="700" fill="hsl(var(--secondary))">
          {label}
        </text>
      ) : null}
    </g>
  );
}
