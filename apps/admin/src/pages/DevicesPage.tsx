import { Alert, Badge, Button, Card, Dialog, EmptyState, Spinner, Switch, TextField } from '@slush/ui';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { rpc, select } from '../lib/api';
import { messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface Device {
  id: string;
  name: string;
  allowed_roles: string[];
  paired_at: string | null;
  pairing_expires_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}
const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export function DevicesPage() {
  const staff = useStaff();
  const stepUp = useStepUp();
  const list = useAsync(
    () => select<Device[]>(staff.db.from('devices').select('id, name, allowed_roles, paired_at, pairing_expires_at, last_seen_at, revoked_at').order('created_at', { ascending: false })),
    [staff.db],
  );
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<Device>();
  const [error, setError] = useState<string>();

  const revoke = async (d: Device) => {
    setError(undefined);
    try {
      await stepUp(() => rpc(staff.db, 'revoke_device', { p_device_id: d.id }));
      setRevoking(undefined);
      list.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const active = list.data?.filter((d) => !d.revoked_at && (d.paired_at || (d.pairing_expires_at && new Date(d.pairing_expires_at) > new Date()))) ?? [];

  return (
    <>
      <PageHeader
        title="Devices"
        description="Only paired shop devices accept staff PINs. If a tablet is lost or stolen, revoke it here straight away."
        action={<Button onClick={() => setAdding(true)}>Add device</Button>}
      />
      {error && <Alert>{error}</Alert>}
      {list.loading && !list.data ? (
        <Spinner className="size-8 text-brand" />
      ) : active.length === 0 ? (
        <EmptyState title="No devices yet" action={<Button onClick={() => setAdding(true)}>Add the counter tablet</Button>}>
          Pair the counter tablet or PC and the kitchen screen so staff can sign in with their PIN.
        </EmptyState>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-line">
            {active.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div>
                  <p className="font-bold">{d.name}</p>
                  <p className="text-sm text-ink-muted">
                    {d.paired_at ? `Last used ${d.last_seen_at ? when.format(new Date(d.last_seen_at)) : 'never'}` : 'Waiting to be paired'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {d.allowed_roles.map((r) => (
                    <Badge key={r} tone="lagoon" className="capitalize">
                      {r}
                    </Badge>
                  ))}
                  {!d.paired_at && <Badge tone="warning">Not paired</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(d)}>
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AddDevice open={adding} onClose={() => setAdding(false)} onCreated={list.reload} />
      <Dialog open={Boolean(revoking)} title={`Revoke ${revoking?.name ?? ''}?`} onClose={() => setRevoking(undefined)}>
        <p className="mb-4 text-sm text-ink-muted">Everyone signed in on it is signed out immediately and it stops accepting PINs. Pair it again to reuse it.</p>
        <Button variant="danger" block onClick={() => revoking && void revoke(revoking)}>
          Revoke device
        </Button>
      </Dialog>
    </>
  );
}

function AddDevice({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const staff = useStaff();
  const stepUp = useStepUp();
  const [name, setName] = useState('Counter tablet');
  const [cashier, setCashier] = useState(true);
  const [kitchen, setKitchen] = useState(false);
  const [result, setResult] = useState<{ pairing_code: string; expires_at: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!result) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [result]);

  const close = () => {
    setResult(undefined);
    setError(undefined);
    onClose();
  };
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const roles = [cashier && 'cashier', kitchen && 'kitchen'].filter(Boolean);
      const r = await stepUp(() => rpc<{ pairing_code: string; expires_at: string }>(staff.db, 'create_device', { p_name: name, p_allowed_roles: roles }));
      setResult(r);
      onCreated();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const secondsLeft = result ? Math.max(0, Math.round((new Date(result.expires_at).getTime() - now) / 1000)) : 0;

  return (
    <Dialog open={open} title="Add a shop device" onClose={close}>
      {result ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-sm text-ink-muted">
            On the new device, open the admin site, choose <b>Sign in with your PIN</b>, and enter:
          </p>
          <p className="font-display text-5xl font-black tracking-[0.25em] text-brand-ink">{result.pairing_code}</p>
          {secondsLeft > 0 ? (
            <Badge tone="warning">
              Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </Badge>
          ) : (
            <Badge tone="danger">Expired: add the device again</Badge>
          )}
          <Button block onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <TextField label="Device name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          <Switch checked={cashier} onChange={setCashier} label="Cashiers can sign in here" />
          <Switch checked={kitchen} onChange={setKitchen} label="Kitchen staff can sign in here" />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" block loading={busy} disabled={!name.trim() || (!cashier && !kitchen)}>
            Get pairing code
          </Button>
        </form>
      )}
    </Dialog>
  );
}
