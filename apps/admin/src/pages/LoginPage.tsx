import { Alert, Button, Card, Logo, TextField } from '@slush/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { env } from '../lib/env';
import { type StaffRole, useSession } from '../lib/session';
import { authClient } from '../lib/supabase';

export function LoginPage() {
  return __DEMO__ ? <DemoLogin /> : <EmailLogin />;
}

const DEMO_ROLES: { role: StaffRole; name: string; what: string }[] = [
  { role: 'owner', name: 'Vikram · Owner', what: 'Everything: settings, staff, approvals, refunds over the limit' },
  { role: 'manager', name: 'Meera · Manager', what: 'Menu, refunds, QR codes, order history' },
  { role: 'cashier', name: 'Karan · Cashier', what: 'Live orders board at the counter (PIN login)' },
  { role: 'kitchen', name: 'Neha · Kitchen', what: 'The dark kitchen screen (PIN login)' },
];

/** Demo mode: pick who to be. The whole backend runs in this browser; nothing is sent anywhere. */
function DemoLogin() {
  const { startDemo } = useSession();
  const [busy, setBusy] = useState<StaffRole>();
  const [error, setError] = useState<string>();
  const start = async (role: StaffRole) => {
    setBusy(role);
    setError(undefined);
    try {
      await startDemo(role);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The demo database didn’t start.');
      setBusy(undefined);
    }
  };
  return (
    <AuthLayout title="Try the staff app">
      <Alert tone="brand" title="Demo mode">
        A private practice copy of the shop runs inside this browser. Place pretend customer orders, accept them, refund them. No real money
        or customers are involved. The first start takes a few seconds.
      </Alert>
      <ul className="mt-5 flex flex-col gap-2">
        {DEMO_ROLES.map((r) => (
          <li key={r.role}>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void start(r.role)}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border-2 border-line bg-card px-4 py-3 text-left transition hover:border-brand disabled:opacity-60"
            >
              <span>
                <b className="block">{r.name}</b>
                <span className="text-sm text-ink-muted">{r.what}</span>
              </span>
              <span aria-hidden className="text-brand-ink">{busy === r.role ? '…' : '→'}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <div className="mt-4"><Alert>{error}</Alert></div>}
    </AuthLayout>
  );
}

function EmailLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!authClient) return;
    setBusy(true);
    setError(undefined);
    const { error: e } = await authClient.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    // Same message for wrong email or wrong password: don't reveal which accounts exist.
    if (e) setError(e.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : 'Email or password is incorrect.');
  };

  return (
    <AuthLayout title="Owner & manager sign in">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" size="lg" block loading={busy}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-muted">
        Counter or kitchen staff?{' '}
        <Link to="/device" className="font-bold text-brand-ink underline">
          Sign in with your PIN
        </Link>
      </p>
    </AuthLayout>
  );
}

export function AuthLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-gradient-to-b from-brand-tint to-surface px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={72} />
          <h1 className="font-display text-2xl font-black tracking-tight">{title}</h1>
        </div>
        <Card className="p-6 sm:p-8">{children}</Card>
      </div>
    </main>
  );
}
