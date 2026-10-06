import { createClient } from "@supabase/supabase-js";

import type { Database } from "./types";

const supabaseUrl: string = import.meta.env.VITE_SUPABASE_URL ?? "https://hueyyiqztzghhucbfwwu.supabase.co";
const supabaseAnonKey: string =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? "sb_publishable_JEVs9Ppc_o3vpeSdl_nCAQ_qJGAf1GU";

/**
 * Single browser Supabase client. Only the publishable (anon) key is ever
 * shipped to the client — service-role keys live exclusively in Edge Functions.
 */
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});

export const SUPABASE_URL: string = supabaseUrl;
