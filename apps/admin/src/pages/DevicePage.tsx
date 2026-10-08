import { Alert, Button, Card, EmptyState, Logo, PinPad, Spinner, TextField, cn } from '@slush/ui';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { edge } from '../lib/api';
import { ApiError, messageOf } from '../lib/errors';
import { useSession } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface DeviceStaff {
  device_name: string;
  staff: { id: string; name: string; role: 'cashier' | 'kitchen' }[];
}
interface PinLoginResponse {
  access_token: string;
  expires_at: string;
  staff_name: string;
  role: 'cashier' | 'kitchen';
}

const TILE_COLOURS = ['bg-brand-tint text-brand-ink', 'bg-lagoon-tint text-lagoon-ink', 'bg-mango-tint text-mango-ink', 'bg-kiwi-tint text-kiwi-ink', 'bg-jamun-tint text-jamun-ink', 'bg-berry-tint text-berry-ink'];

/** Shared shop device: pair once, then staff tap their name and enter a PIN (Phase 6 A1b). */
export function DevicePage() {
  const device = useAsync(() => edge<DeviceStaff>('/auth/device/staff'), []);
  const notPaired = device.error instanceof ApiError && device.error.code === 'DEVICE_NOT_REGISTERED';

  return (
    <main className="min-h-dvh bg-gradient-to-b from-brand-tint to-surface px-4 py-8">
      <header className="mx-auto mb-8 flex max-w-3xl items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo size={48} />
          <div>
            <p className="font-display text-lg font-black leading-tight">The Slush Bar</p>
            <p className="text-sm text-ink-muted">{device.data?.device_name ?? 'Shop device'}</p>
          </div>
        </div>
        <Link to="/login" className="text-sm font-bold text-brand-ink underline">
          Owner / manager login
        </Link>
      </header>
      <div className="mx-auto max-w-3xl">
        {device.loading ? (
          <div className="grid place-items-center py-20">
            <Spinner className="size-10 text-brand" />
          </div>
        ) : notPaired ? (
          <PairDevice onPaired={device.reload} />
        ) : device.error ? (
          <Alert title="Can’t load this device">{messageOf(device.error)}</Alert>
        ) : (
          <StaffPicker data={device.data!} />
        )}
      </div>
    </main>
  );
}

function PairDevice({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const pair = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await edge('/auth/device/pair', { body: { pairing_code: code } });
      onPaired();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'NOT_FOUND' ? 'That code is wrong or has expired. Ask the owner for a new one.' : messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto max-w-md p-8">
      <h1 className="font-display text-2xl font-black">Set up this device</h1>
      <p className="mt-2 text-sm text-ink-muted">
        On the owner’s phone: <b>Admin → Devices → Add device</b>. Then enter the 6-digit code shown there. The code works once and
        expires after 10 minutes.
      </p>
      <form
        className="mt-6 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void pair();
        }}
      >
        <TextField
          label="Pairing code"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="text-center font-display text-2xl tracking-[0.4em]"
          autoFocus
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" size="lg" block loading={busy} disabled={code.length !== 6}>
          Pair device
        </Button>
      </form>
    </Card>
  );
}

function StaffPicker({ data }: { data: DeviceStaff }) {
  const { startPinSession } = useSession();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<DeviceStaff['staff'][number]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (data.staff.length === 0) {
    return <EmptyState title="No staff can use this device yet">The owner adds counter and kitchen staff in Admin → Staff.</EmptyState>;
  }

  const login = async (pin: string) => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await edge<PinLoginResponse>('/auth/pin-login', { body: { staff_id: selected.id, pin } });
      startPinSession({ token: res.access_token, staffName: res.staff_name, role: res.role, expiresAt: res.expires_at });
      void navigate(res.role === 'kitchen' ? '/kitchen' : '/board', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') {
        const left = e.details.attempts_left as number | undefined;
        setError(`Wrong PIN.${left !== undefined ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}`);
      } else if (e instanceof ApiError && e.code === 'ACCOUNT_LOCKED') {
        setError('Too many wrong PINs. Locked for 15 minutes. Ask the owner if you forgot your PIN.');
      } else setError(messageOf(e));
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  if (!selected) {
    return (
      <section>
        <h1 className="mb-6 text-center font-display text-3xl font-black">Who’s working?</h1>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {data.staff.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s)}
                className="flex w-full flex-col items-center gap-3 rounded-3xl bg-card p-6 shadow-card transition hover:-translate-y-0.5"
              >
                <span className={cn('grid size-16 place-items-center rounded-full font-display text-2xl font-black', TILE_COLOURS[i % TILE_COLOURS.length])}>
                  {s.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="font-bold">{s.name}</span>
                <span className="text-xs font-semibold text-ink-muted capitalize">{s.role}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="flex flex-col items-center gap-6">
      <div className="text-center">
        <p className="text-sm text-ink-muted">Enter PIN for</p>
        <h1 className="font-display text-3xl font-black">{selected.name}</h1>
      </div>
      <PinPad onComplete={(pin) => void login(pin)} disabled={busy} error={error} resetKey={attempt} />
      <Button variant="ghost" onClick={() => (setSelected(undefined), setError(undefined))}>
        ← Not you?
      </Button>
    </section>
  );
}
