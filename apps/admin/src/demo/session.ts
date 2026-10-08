import type { SessionState } from '../lib/session';
import { DEMO_PEOPLE, type DemoRole, backend } from './backend';
import { demoClient } from './client';

const ROLE_KEY = 'slush-admin-demo-role';

export function savedDemoRole(): DemoRole | null {
  try {
    const r = localStorage.getItem(ROLE_KEY);
    return r === 'owner' || r === 'manager' || r === 'cashier' || r === 'kitchen' ? r : null;
  } catch {
    return null;
  }
}

export function saveDemoRole(role: DemoRole | null) {
  try {
    if (role) localStorage.setItem(ROLE_KEY, role);
    else localStorage.removeItem(ROLE_KEY);
  } catch {
    /* the demo just won't remember who you were */
  }
}

/** A signed-in session for one of the demo people, backed by the in-browser database. */
export async function demoSession(role: DemoRole): Promise<SessionState> {
  const b = await backend();
  const claims = b.claims(role);
  const base = {
    status: 'ready' as const,
    role,
    name: DEMO_PEOPLE[role].name,
    staffId: String(claims.staff_id),
    branchId: b.branchId,
    db: demoClient(b, role),
    token: () => b.token(role),
  };
  return role === 'cashier' || role === 'kitchen'
    ? { ...base, kind: 'pin', expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() }
    : { ...base, kind: 'email' };
}
