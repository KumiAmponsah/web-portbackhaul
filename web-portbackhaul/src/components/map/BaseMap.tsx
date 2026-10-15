import "mapbox-gl/dist/mapbox-gl.css";

import { useMemo } from "react";
import Map, { type MapProps } from "react-map-gl/mapbox";

import { cn } from "@/lib/utils";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

/** Geographic centre of Ghana — a sensible default for a Ghana-first product. */
export const GHANA_CENTER = { lat: 7.9465, lng: -1.0232 };
export const GHANA_ZOOM = 6.5;

/** Greater Accra / Tema — useful when the user has opened a map from a port view. */
export const ACCRA_CENTER = { lat: 5.6037, lng: -0.1870 };
export const ACCRA_ZOOM = 11;

export interface BaseMapProps {
  /** Initial centre. Defaults to Ghana. */
  center?: { lat: number; lng: number };
  /** Initial zoom. Defaults to Ghana-zoom. */
  zoom?: number;
  /** Pixel height of the map. Defaults to 400. */
  height?: number | string;
  className?: string;
  /** Passed straight through to react-map-gl's <Map>. */
  interactive?: boolean;
  /** Optional children (markers, popups, sources/layers). */
  children?: React.ReactNode;
  /** Escape hatch — any additional react-map-gl props. */
  mapProps?: Omit<MapProps, "initialViewState" | "mapboxAccessToken" | "mapStyle">;
}

/**
 * BaseMap
 *
 * A thin wrapper around react-map-gl + Mapbox. Isolated so a caller never
 * touches the Mapbox token or the map library directly — swapping to MapLibre
 * later means editing this file only.
 *
 * The token comes from VITE_MAPBOX_TOKEN. If it is missing, a clear error
 * card is rendered instead of a broken map.
 */
export function BaseMap({
  center = GHANA_CENTER,
  zoom = GHANA_ZOOM,
  height = 400,
  className,
  interactive = true,
  children,
  mapProps,
}: BaseMapProps) {
  const initialViewState = useMemo(
    () => ({
      longitude: center.lng,
      latitude: center.lat,
      zoom,
    }),
    [center.lat, center.lng, zoom],
  );

  if (!MAPBOX_TOKEN) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center",
          className,
        )}
        style={{ height }}
      >
        <p className="text-sm font-bold text-destructive">Map is not configured</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Add <code className="rounded bg-muted px-1 py-0.5">VITE_MAPBOX_TOKEN=pk.…</code> to your{" "}
          <code className="rounded bg-muted px-1 py-0.5">.env</code> file and restart the dev
          server.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn("relative overflow-hidden rounded-lg border border-border", className)}
      style={{ height }}
    >
      <Map
        initialViewState={initialViewState}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        interactive={interactive}
        attributionControl
        {...mapProps}
      >
        {children}
      </Map>
    </div>
  );
}