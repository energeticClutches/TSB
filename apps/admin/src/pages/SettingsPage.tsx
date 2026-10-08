import {
  DEFAULT_SETTINGS,
  type SettingKey,
  type Settings,
  crossCheckSettings,
  formatINR,
  parseSetting,
  rupeesToPaise,
} from '@slush/core';
import { Alert, Button, Card, SelectField, Spinner, Switch, TextField } from '@slush/ui';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { rpc, select } from '../lib/api';
import { ApiError, messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

type Kind = 'bool' | 'int' | 'rupees' | 'percent' | 'text' | 'enum';
interface FieldSpec {
  key: SettingKey;
  label: string;
  kind: Kind;
  help?: string;
  unit?: string;
  options?: { value: string; label: string }[];
  locked?: string;
}

const GROUPS: { title: string; description: string; fields: FieldSpec[] }[] = [
  {
    title: 'Ordering',
    description: 'When customers can place orders and when staff get nudged.',
    fields: [
      { key: 'last_order_buffer_min', label: 'Last orders before closing', kind: 'int', unit: 'minutes' },
      { key: 'late_order_alert_min', label: 'Highlight orders waiting longer than', kind: 'int', unit: 'minutes' },
    ],
  },
  {
    title: 'Lucky Draw',
    description:
      'A customer’s spending adds up across every order (GST and delivery not counted). When it reaches the amount below, ' +
      'they get one Lucky Draw number — one per mobile number, for ever. Changing these only affects a new campaign.',
    fields: [
      { key: 'loyalty_threshold_paise', label: 'Spending that earns a Lucky Draw number', kind: 'rupees' },
      { key: 'lucky_draw_token_limit', label: 'Numbers in the campaign', kind: 'int' },
    ],
  },
  {
    title: 'Delivery',
    description: 'Straight-line distance from the shop.',
    fields: [
      { key: 'delivery_enabled', label: 'Accept delivery orders', kind: 'bool' },
      { key: 'delivery_radius_m', label: 'Delivery radius', kind: 'int', unit: 'metres' },
      { key: 'delivery_fee_paise', label: 'Delivery fee', kind: 'rupees' },
      { key: 'delivery_min_order_paise', label: 'Minimum order for delivery', kind: 'rupees' },
    ],
  },
  {
    title: 'Receipts & GST',
    description: 'GST stays off until you register.',
    fields: [
      { key: 'legal_name', label: 'Legal name on receipts', kind: 'text' },
      { key: 'receipt_header', label: 'Receipt header', kind: 'text' },
      { key: 'receipt_footer', label: 'Receipt footer', kind: 'text' },
      { key: 'gst_enabled', label: 'Charge GST', kind: 'bool' },
      { key: 'gstin', label: 'GSTIN', kind: 'text' },
      { key: 'gst_rate_bp', label: 'GST rate', kind: 'percent' },
      { key: 'gst_inclusive', label: 'Menu prices already include GST', kind: 'bool' },
    ],
  },
  {
    title: 'Fraud limits',
    description: 'Actions above these limits need your approval.',
    fields: [
      { key: 'refund_owner_approval_above_paise', label: 'Refunds above this need the Owner', kind: 'rupees' },
      { key: 'refund_daily_limit_per_staff', label: 'Refund requests per staff member per day', kind: 'int' },
      { key: 'manual_loyalty_adjust_daily_cap', label: 'Manual spending corrections per day', kind: 'int' },
      { key: 'coupon_owner_approval_above_bp', label: 'Coupons above this discount need the Owner', kind: 'percent' },
      { key: 'price_drop_owner_approval_bp', label: 'Price drops above this need the Owner', kind: 'percent' },
      { key: 'max_paid_orders_per_mobile_per_day', label: 'Orders per mobile number per day', kind: 'int' },
    ],
  },
  {
    title: 'Payments & offers',
    description: 'Master switches.',
    fields: [
      { key: 'offers_enabled', label: 'Offers switched on', kind: 'bool', help: 'Coupons, combos and happy hour.' },
      {
        key: 'first_order_offer_requires_otp',
        label: 'Keep the first-order offer off until SMS OTP exists',
        kind: 'bool',
        locked: 'Stays on until SMS OTP is added (approved fraud rule R3).',
      },
      {
        key: 'payment_mode',
        label: 'Razorpay mode',
        kind: 'enum',
        options: [
          { value: 'test', label: 'Test (no real money)' },
          { value: 'live', label: 'Live' },
        ],
        locked: 'Switches to Live at launch, after the go-live checklist passes.',
      },
    ],
  },
];

type Inputs = Partial<Record<SettingKey, string | boolean>>;

function toInput(spec: FieldSpec, value: unknown): string | boolean {
  if (spec.kind === 'bool') return Boolean(value);
  if (value === null || value === undefined) return '';
  if (spec.kind === 'rupees') return String((value as number) / 100);
  if (spec.kind === 'percent') return String((value as number) / 100);
  return String(value);
}

function fromInput(spec: FieldSpec, input: string | boolean): unknown {
  if (spec.kind === 'bool') return input;
  const text = String(input).trim();
  if (text === '') return spec.kind === 'text' && !['legal_name', 'gstin'].includes(spec.key) ? '' : null;
  if (spec.kind === 'rupees') return Number.isFinite(Number(text)) ? rupeesToPaise(Number(text)) : text;
  if (spec.kind === 'percent') return Number.isFinite(Number(text)) ? Math.round(Number(text) * 100) : text;
  if (spec.kind === 'int') return Number.isFinite(Number(text)) ? Number(text) : text;
  return text;
}

const SPECS = GROUPS.flatMap((g) => g.fields);

export function SettingsPage() {
  const staff = useStaff();
  const stepUp = useStepUp();
  const loaded = useAsync(
    () => select<{ key: SettingKey; value: unknown }[]>(staff.db.from('settings').select('key, value')),
    [staff.db],
  );
  const saved = useMemo(
    () => ({ ...DEFAULT_SETTINGS, ...Object.fromEntries((loaded.data ?? []).map((r) => [r.key, r.value])) }) as Settings,
    [loaded.data],
  );
  const [inputs, setInputs] = useState<Inputs>({});
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [formError, setFormError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInputs(Object.fromEntries(SPECS.map((s) => [s.key, toInput(s, saved[s.key])])) as Inputs);
  }, [saved]);

  const parsed = useMemo(() => {
    const values: Partial<Settings> = {};
    const fieldErrors: Partial<Record<SettingKey, string>> = {};
    for (const spec of SPECS) {
      const raw = inputs[spec.key];
      if (raw === undefined) continue;
      const result = parseSetting(spec.key, fromInput(spec, raw));
      if (result.ok) (values as Record<string, unknown>)[spec.key] = result.value;
      else fieldErrors[spec.key] = result.message;
    }
    return { values, fieldErrors };
  }, [inputs]);

  const changes = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(parsed.values).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(saved[k as SettingKey])),
      ),
    [parsed.values, saved],
  );
  const cross = crossCheckSettings({ ...saved, ...parsed.values });
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    setFormError(undefined);
    setNotice(undefined);
    setErrors(parsed.fieldErrors);
    if (Object.keys(parsed.fieldErrors).length) return setFormError('Please fix the highlighted fields.');
    if (cross.errors.length) return setFormError(cross.errors[0]);
    setBusy(true);
    try {
      await stepUp(() => rpc(staff.db, 'update_settings', { p_changes: changes }));
      setNotice('Saved. Changes apply immediately.');
      loaded.reload();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fields as Partial<Record<SettingKey, string>>);
      setFormError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (loaded.loading && !loaded.data) return <Spinner className="size-8 text-brand" />;
  if (loaded.error) return <Alert title="Couldn’t load settings">{messageOf(loaded.error)}</Alert>;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Business rules for The Slush Bar. Every change is recorded in the audit log."
        action={
          <Button onClick={() => void save()} loading={busy} disabled={!dirty}>
            Save changes
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {formError && <Alert>{formError}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {cross.warnings.map((w) => (
          <Alert key={w} tone="warning">
            {w}
          </Alert>
        ))}
        {GROUPS.map((group) => (
          <Card key={group.title}>
            <h2 className="font-display text-xl font-extrabold">{group.title}</h2>
            <p className="mb-5 text-sm text-ink-muted">{group.description}</p>
            <div className="grid gap-5 sm:grid-cols-2">
              {group.fields.map((spec) => (
                <SettingField
                  key={spec.key}
                  spec={spec}
                  value={inputs[spec.key] ?? ''}
                  error={errors[spec.key] ?? parsed.fieldErrors[spec.key]}
                  onChange={(v) => setInputs((prev) => ({ ...prev, [spec.key]: v }))}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function SettingField({
  spec,
  value,
  error,
  onChange,
}: {
  spec: FieldSpec;
  value: string | boolean;
  error: string | undefined;
  onChange: (v: string | boolean) => void;
}) {
  if (spec.kind === 'bool') {
    return (
      <div className="sm:col-span-2">
        <Switch checked={Boolean(value)} onChange={onChange} label={spec.label} description={spec.locked ?? spec.help} disabled={Boolean(spec.locked)} />
      </div>
    );
  }
  if (spec.kind === 'enum') {
    return (
      <SelectField label={spec.label} value={String(value)} onChange={(e) => onChange(e.target.value)} hint={spec.locked ?? spec.help} error={error} disabled={Boolean(spec.locked)}>
        {spec.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </SelectField>
    );
  }
  const numeric = spec.kind !== 'text';
  const preview =
    spec.kind === 'rupees' && value !== '' && Number.isFinite(Number(value))
      ? formatINR(rupeesToPaise(Number(value)))
      : spec.kind === 'percent' && value !== ''
        ? `${String(value)}%`
        : undefined;
  return (
    <TextField
      label={spec.unit ? `${spec.label} (${spec.unit})` : spec.label}
      value={String(value)}
      inputMode={numeric ? 'decimal' : 'text'}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      hint={[preview, spec.help].filter(Boolean).join(' · ') || undefined}
    />
  );
}
