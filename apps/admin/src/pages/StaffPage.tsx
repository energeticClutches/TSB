import { PIN_PROBLEM_MESSAGE, checkPin } from '@slush/core';
import { Alert, Badge, Button, Card, Dialog, SelectField, Spinner, TextField } from '@slush/ui';
import { useState } from 'react';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { edge, rpc, select } from '../lib/api';
import { ApiError, messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { authClient } from '../lib/supabase';
import { useAsync } from '../lib/useAsync';

interface Member {
  id: string;
  name: string;
  email: string | null;
  is_active: boolean;
  locked_until: string | null;
  role: string;
}

export function StaffPage() {
  const staff = useStaff();
  const team = useAsync(async () => {
    const rows = await select<{ role: string; staff: Omit<Member, 'role'> }[]>(
      staff.db.from('staff_branch_roles').select('role, staff(id, name, email, is_active, locked_until)'),
    );
    return rows
      .map((r) => ({ ...r.staff, role: r.role }))
      .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name));
  }, [staff.db]);
  const [dialog, setDialog] = useState<'pin' | 'manager' | null>(null);
  const [resetFor, setResetFor] = useState<Member>();
  const [deactivateFor, setDeactivateFor] = useState<Member>();

  return (
    <>
      <PageHeader
        title="Staff"
        description="Counter and kitchen staff sign in on shop devices with a 4-digit PIN. Managers use email."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setDialog('manager')}>
              Invite manager
            </Button>
            <Button onClick={() => setDialog('pin')}>Add counter / kitchen staff</Button>
          </div>
        }
      />
      <Card className="p-0">
        {team.loading && !team.data ? (
          <div className="p-6">
            <Spinner className="size-6 text-brand" />
          </div>
        ) : team.error ? (
          <div className="p-6">
            <Alert>{messageOf(team.error)}</Alert>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {team.data!.map((m) => {
              const locked = m.locked_until && new Date(m.locked_until) > new Date();
              const pinRole = m.role === 'cashier' || m.role === 'kitchen';
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div>
                    <p className="font-bold">
                      {m.name} {m.id === staff.staffId && <span className="text-sm font-normal text-ink-muted">(you)</span>}
                    </p>
                    <p className="text-sm text-ink-muted">{m.email ?? 'PIN login'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="brand" className="capitalize">
                      {m.role}
                    </Badge>
                    {!m.is_active && <Badge>Deactivated</Badge>}
                    {locked && <Badge tone="danger">Locked (wrong PINs)</Badge>}
                    {m.is_active && pinRole && (
                      <Button size="sm" variant="ghost" onClick={() => setResetFor(m)}>
                        Reset PIN
                      </Button>
                    )}
                    {m.is_active && m.id !== staff.staffId && (
                      <Button size="sm" variant="ghost" onClick={() => setDeactivateFor(m)}>
                        Deactivate
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <AddPinStaff open={dialog === 'pin'} onClose={() => setDialog(null)} onDone={team.reload} />
      <InviteManager open={dialog === 'manager'} onClose={() => setDialog(null)} onDone={team.reload} />
      <ResetPin member={resetFor} onClose={() => setResetFor(undefined)} onDone={team.reload} />
      <Deactivate member={deactivateFor} onClose={() => setDeactivateFor(undefined)} onDone={team.reload} />
    </>
  );
}

function PinFields({ pin, setPin, confirm, setConfirm, error }: { pin: string; setPin: (v: string) => void; confirm: string; setConfirm: (v: string) => void; error?: string | undefined }) {
  const problem = pin.length === 4 ? checkPin(pin) : null;
  return (
    <>
      <TextField
        label="4-digit PIN"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        maxLength={4}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        error={error ?? (problem ? PIN_PROBLEM_MESSAGE[problem] : undefined)}
        hint="Not 1234, 0000, a year, or a PIN someone else uses."
      />
      <TextField
        label="Type the PIN again"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        maxLength={4}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
        error={confirm.length === 4 && confirm !== pin ? 'The two PINs don’t match.' : undefined}
      />
    </>
  );
}

const pinReady = (pin: string, confirm: string) => pin.length === 4 && checkPin(pin) === null && pin === confirm;

function AddPinStaff({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const staff = useStaff();
  const stepUp = useStepUp();
  const [name, setName] = useState('');
  const [role, setRole] = useState<'cashier' | 'kitchen'>('cashier');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<ApiError | string>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setName('');
    setPin('');
    setConfirm('');
    setError(undefined);
    onClose();
  };
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await stepUp(() => rpc(staff.db, 'create_pin_staff', { p_name: name, p_role: role, p_pin: pin }));
      onDone();
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e : messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const pinError = error instanceof ApiError && error.fields.pin ? error.message : undefined;

  return (
    <Dialog open={open} title="Add counter / kitchen staff" onClose={close}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as 'cashier' | 'kitchen')}>
          <option value="cashier">Cashier: live orders, accept, print, Lucky Draw</option>
          <option value="kitchen">Kitchen: order queue only (no prices or phone numbers)</option>
        </SelectField>
        <PinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} error={pinError} />
        {error && !pinError && <Alert>{typeof error === 'string' ? error : error.message}</Alert>}
        <Button type="submit" block loading={busy} disabled={!name.trim() || !pinReady(pin, confirm)}>
          Add staff member
        </Button>
      </form>
    </Dialog>
  );
}

function ResetPin({ member, onClose, onDone }: { member: Member | undefined; onClose: () => void; onDone: () => void }) {
  const staff = useStaff();
  const stepUp = useStepUp();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPin('');
    setConfirm('');
    setError(undefined);
    onClose();
  };
  const save = async () => {
    if (!member) return;
    setBusy(true);
    try {
      await stepUp(() => rpc(staff.db, 'reset_staff_pin', { p_staff_id: member.id, p_pin: pin }));
      onDone();
      close();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(member)} title={`New PIN for ${member?.name ?? ''}`} onClose={close}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-ink-muted">This also unlocks the account and signs them out of every device.</p>
        <PinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} error={error} />
        <Button type="submit" block loading={busy} disabled={!pinReady(pin, confirm)}>
          Set new PIN
        </Button>
      </form>
    </Dialog>
  );
}

function Deactivate({ member, onClose, onDone }: { member: Member | undefined; onClose: () => void; onDone: () => void }) {
  const staff = useStaff();
  const stepUp = useStepUp();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!member) return;
    setBusy(true);
    try {
      await stepUp(() => rpc(staff.db, 'deactivate_staff', { p_staff_id: member.id, p_reason: reason }));
      onDone();
      setReason('');
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(member)} title={`Deactivate ${member?.name ?? ''}?`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">They’re signed out everywhere immediately and can’t sign in again. Their past actions stay in the audit log.</p>
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Left the job" />
        {error && <Alert>{error}</Alert>}
        <Button variant="danger" block loading={busy} disabled={!reason.trim()} onClick={() => void save()}>
          Deactivate
        </Button>
      </div>
    </Dialog>
  );
}

function InviteManager({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const stepUp = useStepUp();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setName('');
    setEmail('');
    setError(undefined);
    setSent(false);
    onClose();
  };
  const invite = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await stepUp(async () => {
        const { data } = (await authClient?.auth.getSession()) ?? { data: { session: null } };
        return edge('/admin/staff', { body: { name, email, role: 'manager' }, token: data.session?.access_token });
      });
      setSent(true);
      onDone();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Invite a manager" onClose={close}>
      {sent ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">Invitation sent to {email}. They set their own password from the email.</Alert>
          <Button block onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
        >
          <p className="text-sm text-ink-muted">Managers handle orders, refunds, menu and reports, but can’t change settings or staff.</p>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" block loading={busy} disabled={!name.trim() || !email.includes('@')}>
            Send invitation
          </Button>
        </form>
      )}
    </Dialog>
  );
}
