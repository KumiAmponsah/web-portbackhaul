// src/hooks/use-assignments.ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { describeError } from "@/lib/errors";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ShipmentAssignment {
  id: string;
  shipment_id: string;
  requested_by: string;
  truck_type: string;
  required_capacity_tons: number;
  pickup_at: string | null;
  route_origin: string | null;
  route_destination: string | null;
  requirements_notes: string | null;
  offered_fee_ghs: number | null;
  truck_id: string | null;
  driver_id: string | null;
  status: string;
  decline_reason: string | null;
  responded_at: string | null;
  created_at: string;
}

/** Assignment enriched with joined shipment / truck / driver info. */
export interface AssignmentWithDetails extends ShipmentAssignment {
  shipment?: {
    id: string;
    cargo_ref: string | null;
    description: string | null;
    destination_city: string | null;
    pickup_location_text: string | null;
    weight_kg: number | null;
  } | null;
  truck?: {
    id: string;
    registration_no: string | null;
    truck_type: string | null;
    capacity_tons: number | null;
    verification_status: string | null;
  } | null;
  driver?: {
    id: string;
    full_name: string | null;
    phone: string | null;
    verification_status: string | null;
  } | null;
}

const ASSIGNMENT_COLUMNS =
  "id, shipment_id, requested_by, truck_type, required_capacity_tons, pickup_at, route_origin, route_destination, requirements_notes, offered_fee_ghs, truck_id, driver_id, status, decline_reason, responded_at, created_at";

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/** All assignments in the org (used by admins / dispatchers). */
export function useAssignments() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["assignments", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<ShipmentAssignment[]> => {
      const { data, error } = await supabase
        .from("shipment_assignments")
        .select(ASSIGNMENT_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) {
        console.error("Failed to load assignments", error.message);
        throw new Error(describeError(error));
      }
      return (data ?? []) as ShipmentAssignment[];
    },
  });
}

/**
 * Assignments created by the currently signed-in agent, enriched with
 * shipment / truck / driver details fetched in follow-up queries.
 *
 * We avoid PostgREST embeds because the FKs aren't guaranteed to exist
 * (or to be named predictably). Fetching related rows by id is bulletproof.
 */
export function useMyAssignments() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["my-assignments", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<AssignmentWithDetails[]> => {
      // 1. base rows
      const { data: rows, error } = await supabase
        .from("shipment_assignments")
        .select(ASSIGNMENT_COLUMNS)
        .eq("requested_by", user!.id)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Failed to load my assignments", error.message);
        throw new Error(describeError(error));
      }

      const assignments = (rows ?? []) as ShipmentAssignment[];
      if (assignments.length === 0) return [];

      const shipmentIds = Array.from(
        new Set(assignments.map((a) => a.shipment_id).filter(Boolean)),
      );
      const truckIds = Array.from(
        new Set(assignments.map((a) => a.truck_id).filter(Boolean) as string[]),
      );
      const driverIds = Array.from(
        new Set(assignments.map((a) => a.driver_id).filter(Boolean) as string[]),
      );

      // 2. related rows in parallel
      const [shipmentsRes, trucksRes, driversRes] = await Promise.all([
        shipmentIds.length
          ? supabase
              .from("shipments")
              .select(
                "id, cargo_ref, description, destination_city, pickup_location_text, weight_kg",
              )
              .in("id", shipmentIds)
          : Promise.resolve({ data: [], error: null }),
        truckIds.length
          ? supabase
              .from("trucks")
              .select(
                "id, registration_no, truck_type, capacity_tons, verification_status",
              )
              .in("id", truckIds)
          : Promise.resolve({ data: [], error: null }),
        driverIds.length
          ? supabase
              .from("drivers")
              .select("id, full_name, phone, verification_status")
              .in("id", driverIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (shipmentsRes.error)
        console.warn("shipments enrich failed", shipmentsRes.error.message);
      if (trucksRes.error)
        console.warn("trucks enrich failed", trucksRes.error.message);
      if (driversRes.error)
        console.warn("drivers enrich failed", driversRes.error.message);

      const shipmentMap = new Map(
        (shipmentsRes.data ?? []).map((s: any) => [s.id, s]),
      );
      const truckMap = new Map((trucksRes.data ?? []).map((t: any) => [t.id, t]));
      const driverMap = new Map(
        (driversRes.data ?? []).map((d: any) => [d.id, d]),
      );

      // 3. stitch
      return assignments.map<AssignmentWithDetails>((a) => ({
        ...a,
        shipment: shipmentMap.get(a.shipment_id) ?? null,
        truck: a.truck_id ? truckMap.get(a.truck_id) ?? null : null,
        driver: a.driver_id ? driverMap.get(a.driver_id) ?? null : null,
      }));
    },
  });
}

/** A single assignment by id, enriched the same way. */
export function useAssignment(id: string | null | undefined) {
  return useQuery({
    queryKey: ["assignment", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<AssignmentWithDetails | null> => {
      const { data: row, error } = await supabase
        .from("shipment_assignments")
        .select(ASSIGNMENT_COLUMNS)
        .eq("id", id!)
        .maybeSingle();

      if (error) {
        console.error("Failed to load assignment", error.message);
        throw new Error(describeError(error));
      }
      if (!row) return null;

      const a = row as ShipmentAssignment;

      const [shipmentRes, truckRes, driverRes] = await Promise.all([
        a.shipment_id
          ? supabase
              .from("shipments")
              .select(
                "id, cargo_ref, description, destination_city, pickup_location_text, weight_kg",
              )
              .eq("id", a.shipment_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        a.truck_id
          ? supabase
              .from("trucks")
              .select(
                "id, registration_no, truck_type, capacity_tons, verification_status",
              )
              .eq("id", a.truck_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        a.driver_id
          ? supabase
              .from("drivers")
              .select("id, full_name, phone, verification_status")
              .eq("id", a.driver_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      return {
        ...a,
        shipment: (shipmentRes.data as any) ?? null,
        truck: (truckRes.data as any) ?? null,
        driver: (driverRes.data as any) ?? null,
      } as AssignmentWithDetails;
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Matched trucks (RPC)                                               */
/* ------------------------------------------------------------------ */

export interface MatchedTruck {
  truck_id: string;
  registration_no: string;
  truck_type: string;
  capacity_tons: number;
  verification_status: string;
  is_available: boolean;
  distance_km: number | null;
  driver_id: string | null;
  driver_name: string | null;
  driver_verification: string | null;
  driver_available: boolean | null;
}

/**
 * Server-side matching: capacity, type, verification, availability and distance
 * from the pickup point, ranked with the nearest available driver first.
 */
export function useMatchedTrucks(params: {
  truckType: string | null;
  capacity: number;
  lat?: number | null;
  lng?: number | null;
  enabled?: boolean;
}) {
  const { truckType, capacity, lat, lng, enabled = true } = params;

  return useQuery({
    queryKey: ["matched-trucks", truckType, capacity, lat, lng],
    enabled: enabled && capacity > 0,
    queryFn: async (): Promise<MatchedTruck[]> => {
      const { data, error } = await supabase.rpc("match_trucks", {
        p_truck_type: truckType ?? undefined,
        p_capacity: capacity,
        p_lat: lat ?? undefined,
        p_lng: lng ?? undefined,
        p_limit: 10,
      });
      if (error) {
        console.error("Truck matching failed", error.message);
        throw new Error(describeError(error));
      }
      return (data ?? []) as MatchedTruck[];
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

export interface RequestTruckInput {
  shipmentId: string;
  truckType: string;
  capacity: number;
  pickupAt: string | null;
  origin: string;
  destination: string;
  notes?: string | null;
  fee?: number | null;
  truckId?: string | null;
}

export function useRequestTruck() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RequestTruckInput) => {
      const { data, error } = await supabase.rpc("request_truck", {
        p_shipment_id: input.shipmentId,
        p_truck_type: input.truckType,
        p_capacity: input.capacity,
        p_pickup_at: input.pickupAt ?? undefined,
        p_origin: input.origin,
        p_destination: input.destination,
        p_notes: input.notes ?? undefined,
        p_fee: input.fee ?? undefined,
        p_truck_id: input.truckId ?? undefined,
      });
      if (error) throw new Error(describeError(error));
      // RPC should return the new assignment id (uuid). If it returns void,
      // this will be null — the list will still refresh via invalidation.
      return (data as string | null) ?? null;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
      void queryClient.invalidateQueries({ queryKey: ["my-assignments"] });
      void queryClient.invalidateQueries({ queryKey: ["shipments"] });
    },
  });
}

/** Cancel a pending request that hasn't been accepted yet. */
export function useCancelAssignment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (assignmentId: string) => {
      const { error } = await supabase
        .from("shipment_assignments")
        .update({ status: "CANCELLED" })
        .eq("id", assignmentId);
      if (error) throw new Error(describeError(error));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
      void queryClient.invalidateQueries({ queryKey: ["my-assignments"] });
    },
  });
}

/** Driver accepts or declines an offered job; acceptance creates the trip + QR. */
export function useRespondToAssignment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      assignmentId,
      accept,
      reason,
    }: {
      assignmentId: string;
      accept: boolean;
      reason?: string;
    }) => {
      const { error } = await supabase.rpc("respond_to_assignment", {
        p_assignment_id: assignmentId,
        p_accept: accept,
        p_reason: reason ?? undefined,
      });
      if (error) throw new Error(describeError(error));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
      void queryClient.invalidateQueries({ queryKey: ["my-assignments"] });
      void queryClient.invalidateQueries({ queryKey: ["trips"] });
      void queryClient.invalidateQueries({ queryKey: ["shipments"] });
    },
  });
}