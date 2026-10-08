import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { env } from './env';

/** Owner/Manager: normal Supabase Auth session (email + password + 2FA). */
export const authClient: SupabaseClient | null = env.configured && !__DEMO__
  ? createClient(env.supabaseUrl, env.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'slush-admin-auth' },
    })
  : null;

const pinClients = new Map<string, SupabaseClient>();

/** Cashier/Kitchen: a PIN session token minted by our API (Phase 7 §4). */
export function pinClient(token: string): SupabaseClient {
  let client = pinClients.get(token);
  if (!client) {
    pinClients.clear();
    client = createClient(env.supabaseUrl, env.publishableKey, { accessToken: async () => token });
    pinClients.set(token, client);
  }
  return client;
}

export interface StaffClaims {
  sub?: string;
  exp?: number;
  aal?: string;
  staff_id?: string;
  branch_id?: string;
  staff_role?: 'owner' | 'manager' | 'cashier' | 'kitchen';
  pin_session_id?: string;
}

/** Read a JWT's payload for display/routing only. Authorization always happens on the server. */
export function decodeClaims(token: string): StaffClaims {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json))) as StaffClaims;
  } catch {
    return {};
  }
}
