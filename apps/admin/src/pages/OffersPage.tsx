import { formatINR, rupeesToPaise } from '@slush/core';
import { Alert, Badge, Button, Card, Dialog, EmptyState, SelectField, Spinner, Switch, TextField, cn } from '@slush/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { rpc, select } from '../lib/api';
import { messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percent' | 'flat';
  value: number;
  min_order_paise: number | null;
  max_discount_paise: number | null;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit_total: number | null;
  usage_limit_per_customer: number | null;
  used_count: number;
  is_active: boolean;
}

interface PromoRow {
  id: string;
  kind: 'happy_hour' | 'first_order';
  name: string;
  discount_type: 'percent' | 'flat';
  value: number;
  max_discount_paise: number | null;
  min_order_paise: number | null;
  days_mask: number;
  start_time: string | null;
  end_time: string | null;
  starts_on: string | null;
  ends_on: string | null;
  is_active: boolean;
  promotion_targets: { category_id: string | null; product_id: string | null }[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const rupees = (paise: number | null | undefined) => (paise == null ? '' : String(paise / 100));
const discountText = (type: 'percent' | 'flat', value: number) => (type === 'percent' ? `${value / 100}% off` : `${formatINR(value)} off`);
const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

/** The live summary sentence from Phase 6 A9. */
export function couponSummary(c: Pick<CouponRow, 'discount_type' | 'value' | 'max_discount_paise' | 'min_order_paise' | 'ends_at' | 'usage_limit_per_customer' | 'usage_limit_total'>): string {
  const parts = [discountText(c.discount_type, c.value)];
  if (c.discount_type === 'percent' && c.max_discount_paise) parts.push(`up to ${formatINR(c.max_discount_paise)}`);
  if (c.min_order_paise) parts.push(`orders over ${formatINR(c.min_order_paise)}`);
  if (c.ends_at) parts.push(`until ${dateText(c.ends_at)}`);
  if (c.usage_limit_per_customer) parts.push(`${c.usage_limit_per_customer} use${c.usage_limit_per_customer === 1 ? '' : 's'} per customer`);
  parts.push(c.usage_limit_total ? `${c.usage_limit_total} total` : 'no total limit (needs the Owner)');
  return parts.join(', ');
}

/** A9: Offers. Big coupons and unlimited ones go to the Owner before they work (R2). */
export function OffersPage() {
  const staff = useStaff();
  const [tab, setTab] = useState<'coupons' | 'happy' | 'first'>('coupons');
  const data = useAsync(async () => {
    const [coupons, promos, categories, products, settings] = await Promise.all([
      select<CouponRow[]>(staff.db.from('coupons').select('*').order('created_at', { ascending: false })),
      select<PromoRow[]>(staff.db.from('promotions').select('*, promotion_targets(category_id, product_id)').order('created_at', { ascending: false })),
      select<{ id: string; name: string }[]>(staff.db.from('categories').select('id, name').is('archived_at', null).order('sort_order')),
      select<{ id: string; name: string }[]>(staff.db.from('products').select('id, name').is('archived_at', null).order('name')),
      select<{ key: string; value: unknown }[]>(staff.db.from('settings').select('key, value')),
    ]);
    const s = Object.fromEntries(settings.map((r) => [r.key, r.value]));
    return { coupons, promos, categories, products, offersOn: s.offers_enabled === true, otpRequired: s.first_order_offer_requires_otp !== false };
  }, [staff.db]);

  if (!data.data) return data.error ? <Alert>{messageOf(data.error)}</Alert> : <Spinner className="size-8 text-brand" />;
  const d = data.data;

  return (
    <>
      <PageHeader title="Offers" description="Coupons, happy hours and the first-order offer. One order-level offer per order; happy-hour prices apply per item." />
      {!d.offersOn && (
        <div className="mb-4">
          <Alert tone="warning" title="Offers are switched off">
            Customers don’t see any offers until the Owner turns on “Offers” in{' '}
            <Link to="/settings" className="font-bold underline">
              Settings
            </Link>
            . You can still prepare them here.
          </Alert>
        </div>
      )}
      <div className="mb-5 flex gap-2" role="tablist">
        {(
          [
            ['coupons', 'Coupons'],
            ['happy', 'Happy hour'],
            ['first', 'First order'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn('rounded-full px-4 py-2 text-sm font-bold', tab === k ? 'bg-brand text-white shadow-glow' : 'bg-card text-ink-muted')}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'coupons' && <Coupons rows={d.coupons} reload={data.reload} />}
      {tab === 'happy' && <HappyHours rows={d.promos.filter((p) => p.kind === 'happy_hour')} categories={d.categories} products={d.products} reload={data.reload} />}
      {tab === 'first' && <FirstOrder otpRequired={d.otpRequired} />}
    </>
  );
}

function Coupons({ rows, reload }: { rows: CouponRow[]; reload: () => void }) {
  const staff = useStaff();
  const stepUp = useStepUp();
  const [editing, setEditing] = useState<CouponRow | 'new' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string }>();

  const toggle = async (c: CouponRow) => {
    setMessage(undefined);
    try {
      const r = await stepUp(() => rpc<{ status: string }>(staff.db, 'set_coupon_active', { p_coupon_id: c.id, p_active: !c.is_active }));
      if (r.status === 'needs_owner') setMessage({ tone: 'warning', text: `${c.code} is a big or unlimited coupon, so it has been sent to the Owner for approval.` });
      reload();
    } catch (e) {
      setMessage({ tone: 'danger', text: messageOf(e) });
    }
  };

  return (
    <>
      {message && <div className="mb-4"><Alert tone={message.tone}>{message.text}</Alert></div>}
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setEditing('new')}>+ New coupon</Button>
      </div>
      {rows.length === 0 && <EmptyState title="No coupons yet">Create one, e.g. SLUSH10 for 10% off.</EmptyState>}
      <div className="flex flex-col gap-3">
        {rows.map((c) => (
          <Card key={c.id} className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2">
                <span className="font-mono text-lg font-black">{c.code}</span>
                {c.is_active ? <Badge tone="success">Live</Badge> : <Badge>Off</Badge>}
                {c.usage_limit_total !== null && c.used_count >= c.usage_limit_total && <Badge tone="warning">Used up</Badge>}
              </p>
              <p className="text-sm">{couponSummary(c)}</p>
              <p className="text-xs text-ink-muted">
                Used {c.used_count}
                {c.usage_limit_total ? ` of ${c.usage_limit_total}` : ''} times{c.description ? ` · ${c.description}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit</Button>
              <Switch checked={c.is_active} onChange={() => void toggle(c)} label={c.is_active ? 'Live' : 'Off'} />
            </div>
          </Card>
        ))}
      </div>
      <CouponEditor
        value={editing}
        onClose={() => setEditing(null)}
        onSaved={(status) => {
          setEditing(null);
          setMessage(
            status === 'needs_owner'
              ? { tone: 'warning', text: 'Saved. It’s over the limit (or has no usage limit), so the Owner has to approve it before it works.' }
              : { tone: 'success', text: 'Coupon saved.' },
          );
          reload();
        }}
      />
    </>
  );
}

function CouponEditor({ value, onClose, onSaved }: { value: CouponRow | 'new' | null; onClose: () => void; onSaved: (status: string) => void }) {
  const staff = useStaff();
  const stepUp = useStepUp();
  const c = value === 'new' || value === null ? null : value;
  const key = value === null ? 'closed' : (c?.id ?? 'new');
  return value === null ? null : <CouponForm key={key} coupon={c} onClose={onClose} onSave={(p) => stepUp(() => rpc<{ status: string }>(staff.db, 'upsert_coupon', { p })).then((r) => onSaved(r.status))} />;
}

function CouponForm({ coupon: c, onClose, onSave }: { coupon: CouponRow | null; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [code, setCode] = useState(c?.code ?? '');
  const [description, setDescription] = useState(c?.description ?? '');
  const [type, setType] = useState<'percent' | 'flat'>(c?.discount_type ?? 'percent');
  const [value, setValue] = useState(c ? (c.discount_type === 'percent' ? String(c.value / 100) : rupees(c.value)) : '10');
  const [min, setMin] = useState(rupees(c?.min_order_paise));
  const [max, setMax] = useState(rupees(c?.max_discount_paise));
  const [ends, setEnds] = useState(c?.ends_at?.slice(0, 10) ?? '');
  const [total, setTotal] = useState(c?.usage_limit_total ? String(c.usage_limit_total) : '100');
  const [perCustomer, setPerCustomer] = useState(c?.usage_limit_per_customer ? String(c.usage_limit_per_customer) : '1');
  const [active, setActive] = useState(c?.is_active ?? true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const valueNum = Number(value);
  const payload = {
    ...(c ? { id: c.id } : {}),
    code: code.toUpperCase(),
    description,
    discount_type: type,
    value: type === 'percent' ? Math.round(valueNum * 100) : rupeesToPaise(valueNum || 0),
    min_order_paise: num(min) === null ? null : rupeesToPaise(num(min)!),
    max_discount_paise: num(max) === null ? null : rupeesToPaise(num(max)!),
    ends_at: ends ? new Date(`${ends}T23:59:59+05:30`).toISOString() : null,
    usage_limit_total: num(total),
    usage_limit_per_customer: num(perCustomer),
    is_active: active,
  };
  const valid = /^[A-Z0-9]{3,20}$/i.test(code) && valueNum > 0 && (type === 'flat' || valueNum <= 100);

  return (
    <Dialog open onClose={onClose} title={c ? `Edit ${c.code}` : 'New coupon'} wide>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          onSave(payload)
            .catch((err: unknown) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20))} placeholder="SLUSH10" className="font-mono uppercase" />
        <TextField label="Note (staff only, optional)" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 120))} placeholder="Instagram campaign" />
        <SelectField label="Discount" value={type} onChange={(e) => setType(e.target.value as 'percent' | 'flat')}>
          <option value="percent">Percentage off</option>
          <option value="flat">Fixed amount off (₹)</option>
        </SelectField>
        <TextField label={type === 'percent' ? 'Percent' : 'Amount (₹)'} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} />
        <TextField label="Minimum order (₹, optional)" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value.replace(/[^\d.]/g, ''))} />
        {type === 'percent' && <TextField label="Maximum discount (₹, optional)" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value.replace(/[^\d.]/g, ''))} />}
        <TextField label="Last day (optional)" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
        <TextField label="Total uses (blank = unlimited)" inputMode="numeric" value={total} onChange={(e) => setTotal(e.target.value.replace(/\D/g, ''))} />
        <TextField label="Uses per customer" inputMode="numeric" value={perCustomer} onChange={(e) => setPerCustomer(e.target.value.replace(/\D/g, ''))} />
        <div className="self-end pb-3">
          <Switch checked={active} onChange={setActive} label="Switch on after saving" />
        </div>
        <p className="rounded-2xl bg-brand-tint px-4 py-3 text-sm font-semibold text-brand-ink sm:col-span-2">
          {valid ? couponSummary({ ...payload, value: payload.value, discount_type: type }) : 'Fill in a code (3–20 letters or numbers) and a discount.'}
        </p>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!valid}>Save coupon</Button>
        </div>
      </form>
    </Dialog>
  );
}

function HappyHours({ rows, categories, products, reload }: { rows: PromoRow[]; categories: { id: string; name: string }[]; products: { id: string; name: string }[]; reload: () => void }) {
  const staff = useStaff();
  const [editing, setEditing] = useState<PromoRow | 'new' | null>(null);
  const [error, setError] = useState<string>();
  const targetNames = (p: PromoRow) => {
    const names = p.promotion_targets.map((t) => categories.find((c) => c.id === t.category_id)?.name ?? products.find((x) => x.id === t.product_id)?.name).filter(Boolean);
    return names.length ? names.join(', ') : 'everything';
  };
  const days = (mask: number) => (mask === 127 ? 'every day' : DAYS.filter((_, i) => mask & (1 << i)).join(', '));

  return (
    <>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setEditing('new')}>+ New happy hour</Button>
      </div>
      {rows.length === 0 && <EmptyState title="No happy hours yet">e.g. 20% off slushes, 3–6 PM on weekdays.</EmptyState>}
      <div className="flex flex-col gap-3">
        {rows.map((p) => (
          <Card key={p.id} className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 font-bold">
                {p.name} {p.is_active ? <Badge tone="success">Live</Badge> : <Badge>Off</Badge>}
              </p>
              <p className="text-sm">
                {discountText(p.discount_type, p.value)} {targetNames(p)} · {p.start_time?.slice(0, 5)}–{p.end_time?.slice(0, 5)} · {days(p.days_mask)}
                {p.ends_on && ` · until ${dateText(p.ends_on)}`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
              <Switch
                checked={p.is_active}
                label={p.is_active ? 'Live' : 'Off'}
                onChange={(v) =>
                  void rpc(staff.db, 'set_promotion_active', { p_promotion_id: p.id, p_active: v }).then(reload, (e: unknown) => setError(messageOf(e)))
                }
              />
            </div>
          </Card>
        ))}
      </div>
      {editing && (
        <HappyHourForm
          key={editing === 'new' ? 'new' : editing.id}
          promo={editing === 'new' ? null : editing}
          categories={categories}
          products={products}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function HappyHourForm({
  promo: p,
  categories,
  products,
  onClose,
  onSaved,
}: {
  promo: PromoRow | null;
  categories: { id: string; name: string }[];
  products: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const staff = useStaff();
  const [name, setName] = useState(p?.name ?? 'Happy hour');
  const [type, setType] = useState<'percent' | 'flat'>(p?.discount_type ?? 'percent');
  const [value, setValue] = useState(p ? (p.discount_type === 'percent' ? String(p.value / 100) : rupees(p.value)) : '20');
  const [start, setStart] = useState(p?.start_time?.slice(0, 5) ?? '15:00');
  const [end, setEnd] = useState(p?.end_time?.slice(0, 5) ?? '18:00');
  const [mask, setMask] = useState(p?.days_mask ?? 127);
  const [cats, setCats] = useState<string[]>(p?.promotion_targets.flatMap((t) => (t.category_id ? [t.category_id] : [])) ?? []);
  const [prods, setProds] = useState<string[]>(p?.promotion_targets.flatMap((t) => (t.product_id ? [t.product_id] : [])) ?? []);
  const [endsOn, setEndsOn] = useState(p?.ends_on ?? '');
  const [active, setActive] = useState(p?.is_active ?? true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const valueNum = Number(value);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await rpc(staff.db, 'upsert_promotion', {
        p: {
          ...(p ? { id: p.id } : {}),
          kind: 'happy_hour',
          name,
          discount_type: type,
          value: type === 'percent' ? Math.round(valueNum * 100) : rupeesToPaise(valueNum || 0),
          start_time: start,
          end_time: end,
          days_mask: mask,
          ends_on: endsOn || null,
          category_ids: cats,
          product_ids: prods,
          is_active: active,
        },
      });
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={p ? 'Edit happy hour' : 'New happy hour'} wide>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label="Name (customers see this)" value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Discount" value={type} onChange={(e) => setType(e.target.value as 'percent' | 'flat')}>
            <option value="percent">% off</option>
            <option value="flat">₹ off each</option>
          </SelectField>
          <TextField label={type === 'percent' ? 'Percent' : 'Amount (₹)'} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="From" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="Until" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <TextField label="Last day (optional)" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-bold">Days</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={Boolean(mask & (1 << i))}
                onClick={() => setMask(mask ^ (1 << i) || mask)}
                className={cn('rounded-full border-2 px-3 py-1.5 text-sm font-bold', mask & (1 << i) ? 'border-brand bg-brand-tint text-brand-ink' : 'border-line text-ink-muted')}
              >
                {d}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-bold">Applies to (choose nothing for the whole menu)</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {categories.map((c) => (
              <button key={c.id} type="button" aria-pressed={cats.includes(c.id)} onClick={() => setCats(toggleIn(cats, c.id))} className={cn('rounded-full border-2 px-3 py-1.5 text-sm font-bold', cats.includes(c.id) ? 'border-brand bg-brand-tint text-brand-ink' : 'border-line text-ink-muted')}>
                {c.name}
              </button>
            ))}
          </div>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer font-bold text-brand-ink">Or pick single items ({prods.length})</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {products.map((x) => (
                <button key={x.id} type="button" aria-pressed={prods.includes(x.id)} onClick={() => setProds(toggleIn(prods, x.id))} className={cn('rounded-full border-2 px-3 py-1 text-xs font-bold', prods.includes(x.id) ? 'border-brand bg-brand-tint text-brand-ink' : 'border-line text-ink-muted')}>
                  {x.name}
                </button>
              ))}
            </div>
          </details>
        </fieldset>
        <Switch checked={active} onChange={setActive} label="Live" description="Shown on the menu and applied automatically during its hours." />
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!name.trim() || !(valueNum > 0) || (type === 'percent' && valueNum > 100)}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function FirstOrder({ otpRequired }: { otpRequired: boolean }) {
  return (
    <Card className="max-w-2xl">
      <h2 className="font-display text-xl font-extrabold">First-order offer</h2>
      <p className="mt-2 text-sm">
        A discount for someone’s very first order. Without an SMS code (OTP) to prove the mobile number is theirs, anyone can type a new number to
        get it again and again, so it stays <b>switched off until SMS OTP is set up</b> (approved decision R3).
      </p>
      <p className="mt-3">
        <Badge tone={otpRequired ? 'warning' : 'success'}>{otpRequired ? 'Requires SMS OTP: locked' : 'OTP ready'}</Badge>
      </p>
      <p className="mt-3 text-sm text-ink-muted">SMS OTP is the first item planned after launch (see docs/OWNER-ACTION-ITEMS.md, L1).</p>
    </Card>
  );
}
