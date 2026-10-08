import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { rpc } from './api';
import { env } from './env';
import { type StaffClaims, authClient, decodeClaims, pinClient } from './supabase';

export type StaffRole = NonNullable<StaffClaims['staff_role']>;

export interface PinSession {
  token: string;
  staffName: string;
  role: 'cashier' | 'kitchen';
  expiresAt: string;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  /** Email login that still needs something before it can be used. */
  | { status: 'needs'; need: 'mfa_challenge' | 'mfa_enroll' | 'not_staff'; email: string }
  | (ReadyBase & { kind: 'email' })
  | (ReadyBase & { kind: 'pin'; expiresAt: string });

interface ReadyBase {
  status: 'ready';
  role: StaffRole;
  name: string;
  staffId: string;
  branchId: string;
  db: SupabaseClient;
  /** Current access token, for our Edge API (/v1/admin/*). */
  token: () => Promise<string | undefined>;
}

const emailToken = async () => (await authClient?.auth.getSession())?.data.session?.access_token;

interface SessionApi {
  state: SessionState;
  startPinSession: (s: PinSession) => void;
  signOut: () => Promise<void>;
  /** Re-read the email session (after 2FA verification or enrolment). */
  refresh: () => Promise<void>;
  /** Demo mode only: sign in as one of the demo people. */
  startDemo: (role: StaffRole) => Promise<void>;
}

const demoModule = () => (__DEMO__ ? import('../demo/session') : Promise.reject(new Error('Demo mode is not part of this build.')));

const Ctx = createContext<SessionApi | null>(null);
const PIN_KEY = 'slush-pin-session';

function loadPin(): PinSession | null {
  try {
    const raw = sessionStorage.getItem(PIN_KEY);
    const s = raw ? (JSON.parse(raw) as PinSession) : null;
    return s && new Date(s.expiresAt) > new Date() ? s : null;
  } catch {
    return null;
  }
}
function savePin(s: PinSession | null) {
  try {
    if (s) sessionStorage.setItem(PIN_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(PIN_KEY);
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
}

async function resolveEmailSession(session: Session | null): Promise<SessionState> {
  if (!session || !authClient) return { status: 'signed_out' };
  const email = session.user.email ?? '';
  const claims = decodeClaims(session.access_token);
  if (!claims.staff_id || !claims.staff_role) return { status: 'needs', need: 'not_staff', email };

  const { data: aal } = await authClient.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== 'aal2') {
    // Anyone who has 2FA set up must use it; Owners must set it up (Phase 8 S2).
    if (aal?.nextLevel === 'aal2') return { status: 'needs', need: 'mfa_challenge', email };
    if (claims.staff_role === 'owner') return { status: 'needs', need: 'mfa_enroll', email };
  }
  const { data: me } = await authClient.from('staff').select('name').eq('id', claims.staff_id).maybeSingle();
  return {
    status: 'ready',
    kind: 'email',
    role: claims.staff_role,
    name: (me as { name?: string } | null)?.name ?? email,
    staffId: claims.staff_id,
    branchId: claims.branch_id ?? '',
    db: authClient,
    token: emailToken,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const fromPin = useCallback((s: PinSession): SessionState => {
    const claims = decodeClaims(s.token);
    return {
      status: 'ready',
      kind: 'pin',
      role: s.role,
      name: s.staffName,
      staffId: claims.staff_id ?? '',
      branchId: claims.branch_id ?? '',
      db: pinClient(s.token),
      token: async () => s.token,
      expiresAt: s.expiresAt,
    };
  }, []);

  const refresh = useCallback(async () => {
    if (__DEMO__) {
      const demo = await demoModule();
      const role = demo.savedDemoRole();
      return setState(role ? await demo.demoSession(role) : { status: 'signed_out' });
    }
    const pin = loadPin();
    if (pin) return setState(fromPin(pin));
    if (!authClient) return setState({ status: 'signed_out' });
    const { data } = await authClient.auth.getSession();
    setState(await resolveEmailSession(data.session));
  }, [fromPin]);

  useEffect(() => {
    void refresh();
    if (!authClient) return;
    const { data } = authClient.auth.onAuthStateChange((event, session) => {
      if (loadPin()) return;
      if (event === 'SIGNED_OUT') setState({ status: 'signed_out' });
      else if (event === 'SIGNED_IN' || event === 'MFA_CHALLENGE_VERIFIED' || event === 'USER_UPDATED') {
        // Defer: Supabase recommends not awaiting other auth calls inside this callback.
        setTimeout(() => void resolveEmailSession(session).then(setState), 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [refresh]);

  const startPinSession = useCallback(
    (s: PinSession) => {
      savePin(s);
      setState(fromPin(s));
    },
    [fromPin],
  );

  const startDemo = useCallback(async (role: StaffRole) => {
    const demo = await demoModule();
    demo.saveDemoRole(role);
    setState(await demo.demoSession(role));
  }, []);

  const signOut = useCallback(async () => {
    if (__DEMO__) {
      (await demoModule()).saveDemoRole(null);
      setState({ status: 'signed_out' });
      return;
    }
    const pin = loadPin();
    if (pin) {
      await rpc(pinClient(pin.token), 'end_pin_session').catch(() => undefined);
      savePin(null);
      setState({ status: 'signed_out' });
      return;
    }
    await authClient?.auth.signOut();
    setState({ status: 'signed_out' });
  }, []);

  const value = useMemo(() => ({ state, startPinSession, signOut, refresh, startDemo }), [state, startPinSession, signOut, refresh, startDemo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** The signed-in staff session; only use inside routes guarded by <RequireSession>. */
export function useStaff() {
  const { state } = useSession();
  if (state.status !== 'ready') throw new Error('useStaff used without a ready session');
  return state;
}
