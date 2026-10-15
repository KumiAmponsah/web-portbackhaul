import { useQuery } from "@tanstack/react-query";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

export interface GeocodeResult {
  /** Stable Mapbox feature id. */
  id: string;
  /** Short primary line, e.g. "Kumasi". */
  name: string;
  /** Full address line, e.g. "Kumasi, Ashanti, Ghana". */
  placeName: string;
  lat: number;
  lng: number;
}

interface MapboxFeature {
  id: string;
  text: string;
  place_name: string;
  center: [number, number]; // [lng, lat]
}

interface MapboxResponse {
  features: MapboxFeature[];
}

/**
 * Forward geocoding — "Kumasi" → [{ name, placeName, lat, lng }, ...]
 *
 * Uses Mapbox Geocoding v5. The `country=gh` bias makes Ghanaian results
 * rank first, but other countries still appear for cross-border routes.
 * `proximity` is intentionally omitted here; Step 4 will pass it in when we
 * want "suggestions near the map centre".
 */
export function useGeocode(query: string, options?: { limit?: number; enabled?: boolean }) {
  const trimmed = query.trim();
  const enabled = (options?.enabled ?? true) && trimmed.length >= 3;

  return useQuery({
    queryKey: ["geocode", trimmed, options?.limit ?? 6],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<GeocodeResult[]> => {
      if (!MAPBOX_TOKEN) throw new Error("Mapbox token not configured.");

      const params = new URLSearchParams({
        access_token: MAPBOX_TOKEN,
        country: "gh",
        limit: String(options?.limit ?? 6),
        types: "place,locality,region,country,address,poi",
      });

      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
        trimmed,
      )}.json?${params.toString()}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Geocoding failed (${response.status}).`);
      }
      const data = (await response.json()) as MapboxResponse;

      return (data.features ?? []).map((f) => ({
        id: f.id,
        name: f.text,
        placeName: f.place_name,
        lat: f.center[1],
        lng: f.center[0],
      }));
    },
  });
}

/**
 * Reverse geocoding — { lat, lng } → "Tema Port, Tema, Ghana"
 *
 * Used in Step 4 when the user clicks on the map. Returns the nearest
 * named place within a few metres.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult | null> {
  if (!MAPBOX_TOKEN) throw new Error("Mapbox token not configured.");

  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    limit: "1",
    types: "place,locality,region,country,address,poi",
  });

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = (await response.json()) as MapboxResponse;
  const first = data.features?.[0];
  if (!first) return null;

  return {
    id: first.id,
    name: first.text,
    placeName: first.place_name,
    lat: first.center[1],
    lng: first.center[0],
  };
}