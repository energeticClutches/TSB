import { formatINR, rupeesToPaise } from '@slush/core';
import { Alert, Badge, Button, Card, Dialog, EmptyState, SelectField, Spinner, Switch, TextField, cn } from '@slush/ui';
import { useEffect, useState } from 'react';
import { ItemEditor, WindowsEditor } from '../components/ItemEditor';
import { PageHeader } from '../components/Shell';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { menuImageUrl } from '../lib/image';
import { type AdminCategory, type AdminGroup, type AdminProduct, type AdminWindow, loadAdminMenu } from '../lib/menuAdmin';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

export function MenuPage() {
  const staff = useStaff();
  const menu = useAsync(() => loadAdminMenu(staff.db), [staff.db]);
  const [tab, setTab] = useState<'items' | 'groups'>('items');
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  if (menu.loading && !menu.data) return <Spinner className="size-8 text-brand" />;
  if (menu.error) return <Alert title="Couldn’t load the menu">{messageOf(menu.error)}</Alert>;
  const data = menu.data!;

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
      if (success) setNotice(success);
      menu.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Menu"
        description="Changes go live on customers’ phones within a minute. Removed items are archived, so old receipts stay correct."
        action={
          <div className="flex rounded-full bg-card p-1 shadow-card">
            {(['items', 'groups'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={cn('rounded-full px-4 py-2 text-sm font-bold', tab === t ? 'bg-brand text-white' : 'text-ink-muted')}>
                {t === 'items' ? 'Categories & items' : 'Choices & add-ons'}
              </button>
            ))}
          </div>
        }
      />
      <div className="mb-4 flex flex-col gap-2">
        {notice && <Alert tone="success">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
      </div>
      {tab === 'items' ? (
        <ItemsTab data={data} run={run} onNotice={(n) => (setNotice(n), menu.reload())} />
      ) : (
        <GroupsTab groups={data.groups} onSaved={(n) => (setNotice(n), menu.reload())} run={run} />
      )}
    </>
  );
}

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<void>;

function ItemsTab({ data, run, onNotice }: { data: Awaited<ReturnType<typeof loadAdminMenu>>; run: Run; onNotice: (n: string) => void }) {
  const staff = useStaff();
  const [selected, setSelected] = useState<string | undefined>(data.categories[0]?.id);
  const [editing, setEditing] = useState<AdminProduct | 'new'>();
  const [categoryDialog, setCategoryDialog] = useState<AdminCategory | 'new'>();

  useEffect(() => {
    if (!selected || !data.categories.some((c) => c.id === selected)) setSelected(data.categories[0]?.id);
  }, [data.categories, selected]);

  const items = data.products.filter((p) => p.category_id === selected).sort((a, b) => a.sort_order - b.sort_order);

  const moveCategory = (i: number, dir: -1 | 1) => {
    const ids = data.categories.map((c) => c.id);
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    void run(() => rpc(staff.db, 'reorder_categories', { p_ids: ids }));
  };
  const moveItem = (i: number, dir: -1 | 1) => {
    const ids = items.map((p) => p.id);
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    void run(() => rpc(staff.db, 'reorder_products', { p_category_id: selected, p_ids: ids }));
  };

  if (data.categories.length === 0) {
    return (
      <>
        <EmptyState title="Start with a category" action={<Button onClick={() => setCategoryDialog('new')}>Add category</Button>}>
          For example: Slushes, Shakes, Pizzas, Mocktails.
        </EmptyState>
        <CategoryDialog value={categoryDialog} onClose={() => setCategoryDialog(undefined)} run={run} />
      </>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card className="p-3">
        <ul className="flex flex-col gap-1">
          {data.categories.map((c, i) => (
            <li key={c.id} className={cn('group flex items-center gap-1 rounded-2xl pr-1', selected === c.id && 'bg-brand-tint')}>
              <button type="button" onClick={() => setSelected(c.id)} className="flex-1 px-3 py-2.5 text-left font-bold">
                {c.name}
                <span className="ml-1 text-xs font-normal text-ink-muted">({data.products.filter((p) => p.category_id === c.id).length})</span>
                {!c.is_active && <Badge className="ml-2">Hidden</Badge>}
                {c.windows.length > 0 && <Badge tone="lagoon" className="ml-2">Timed</Badge>}
              </button>
              <button type="button" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => moveCategory(i, -1)} className="size-7 rounded-full text-ink-muted disabled:opacity-20">
                ↑
              </button>
              <button type="button" aria-label={`Move ${c.name} down`} disabled={i === data.categories.length - 1} onClick={() => moveCategory(i, 1)} className="size-7 rounded-full text-ink-muted disabled:opacity-20">
                ↓
              </button>
              <button type="button" aria-label={`Edit ${c.name}`} onClick={() => setCategoryDialog(c)} className="size-7 rounded-full text-ink-muted">
                ✎
              </button>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" block className="mt-2" onClick={() => setCategoryDialog('new')}>
          + Add category
        </Button>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex justify-end">
          <Button onClick={() => setEditing('new')}>+ Add item</Button>
        </div>
        {items.length === 0 ? (
          <EmptyState title="No items in this category yet" action={<Button onClick={() => setEditing('new')}>Add the first item</Button>} />
        ) : (
          items.map((p, i) => (
            <Card key={p.id} className={cn('flex items-center gap-4 p-3', !p.is_active && 'opacity-60')}>
              <div className="size-16 shrink-0 overflow-hidden rounded-2xl" style={{ background: p.accent_color ? `${p.accent_color}22` : 'var(--color-surface)' }}>
                {p.image_path && <img src={menuImageUrl(p.image_path)} alt="" className="size-full object-cover" loading="lazy" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold">
                  {p.name} {p.kind === 'combo' && <Badge tone="brand">Combo</Badge>} {p.is_featured && <Badge tone="warning">★ Featured</Badge>}{' '}
                  {!p.is_active && <Badge>Hidden</Badge>} {p.windows.length > 0 && <Badge tone="lagoon">Timed</Badge>}
                </p>
                <p className="truncate text-sm text-ink-muted">{p.variants.map((v) => `${v.name} ${formatINR(v.price_paise)}`).join(' · ')}</p>
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={p.is_sold_out} onChange={(e) => void run(() => rpc(staff.db, 'set_product_sold_out', { p_id: p.id, p_sold_out: e.target.checked }))} />
                Sold out
              </label>
              <div className="flex">
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveItem(i, -1)} className="size-8 rounded-full text-ink-muted disabled:opacity-20">
                  ↑
                </button>
                <button type="button" aria-label="Move down" disabled={i === items.length - 1} onClick={() => moveItem(i, 1)} className="size-8 rounded-full text-ink-muted disabled:opacity-20">
                  ↓
                </button>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => window.confirm(`Remove ${p.name} from the menu? Past orders keep it.`) && void run(() => rpc(staff.db, 'archive_product', { p_id: p.id }), `${p.name} removed from the menu.`)}
              >
                Remove
              </Button>
            </Card>
          ))
        )}
      </div>

      <ItemEditor open={editing !== undefined} product={editing === 'new' ? undefined : editing} categoryId={selected} menu={data} onClose={() => setEditing(undefined)} onSaved={onNotice} />
      <CategoryDialog value={categoryDialog} onClose={() => setCategoryDialog(undefined)} run={run} />
    </div>
  );
}

function CategoryDialog({ value, onClose, run }: { value: AdminCategory | 'new' | undefined; onClose: () => void; run: Run }) {
  const staff = useStaff();
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [windows, setWindows] = useState<AdminWindow[]>([]);
  const existing = value && value !== 'new' ? value : undefined;

  useEffect(() => {
    setName(existing?.name ?? '');
    setActive(existing?.is_active ?? true);
    setWindows(existing?.windows ?? []);
  }, [value, existing]);

  return (
    <Dialog open={value !== undefined} title={existing ? `Edit ${existing.name}` : 'Add a category'} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => rpc(staff.db, 'upsert_category', { p: { ...(existing ? { id: existing.id } : {}), name, is_active: active, windows } }), 'Category saved.').then(onClose);
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
        <Switch checked={active} onChange={setActive} label="Show on the menu" />
        <WindowsEditor windows={windows} onChange={setWindows} />
        <Button type="submit" block disabled={!name.trim()}>
          Save category
        </Button>
        {existing && (
          <Button variant="ghost" onClick={() => void run(() => rpc(staff.db, 'archive_category', { p_id: existing.id }), 'Category removed.').then(onClose)}>
            Remove category
          </Button>
        )}
      </form>
    </Dialog>
  );
}

function GroupsTab({ groups, onSaved, run }: { groups: AdminGroup[]; onSaved: (n: string) => void; run: Run }) {
  const staff = useStaff();
  const [editing, setEditing] = useState<AdminGroup | 'new'>();
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing('new')}>+ New group</Button>
      </div>
      {groups.length === 0 ? (
        <EmptyState title="No choices yet">Create groups like “Ice level” (free, pick one) or “Toppings” (paid, pick up to 3), then attach them to items.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map((g) => (
            <Card key={g.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-display text-lg font-extrabold">{g.name}</p>
                  <p className="text-sm text-ink-muted">
                    {g.kind === 'free_option' ? 'Free choice' : 'Paid add-on'} · {g.min_select > 0 ? `pick ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}` : `up to ${g.max_select}`}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setEditing(g)}>
                  Edit
                </Button>
              </div>
              <ul className="mt-3 flex flex-wrap gap-2">
                {g.options.map((o) => (
                  <li key={o.id}>
                    <Badge tone={o.is_sold_out ? 'danger' : 'neutral'}>
                      {o.name}
                      {o.price_paise > 0 && ` +${formatINR(o.price_paise)}`}
                      {o.is_sold_out && ' (sold out)'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
      <GroupDialog
        value={editing}
        onClose={() => setEditing(undefined)}
        onSaved={onSaved}
        onArchive={(g) => void run(() => rpc(staff.db, 'archive_modifier_group', { p_id: g.id }), `${g.name} removed.`).then(() => setEditing(undefined))}
      />
    </>
  );
}

function GroupDialog({ value, onClose, onSaved, onArchive }: { value: AdminGroup | 'new' | undefined; onClose: () => void; onSaved: (n: string) => void; onArchive: (g: AdminGroup) => void }) {
  const staff = useStaff();
  const existing = value && value !== 'new' ? value : undefined;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'paid_addon' | 'free_option'>('paid_addon');
  const [min, setMin] = useState('0');
  const [max, setMax] = useState('1');
  const [options, setOptions] = useState<{ id?: string | undefined; name: string; price: string; is_default: boolean }[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(undefined);
    setName(existing?.name ?? '');
    setKind(existing?.kind ?? 'paid_addon');
    setMin(String(existing?.min_select ?? 0));
    setMax(String(existing?.max_select ?? 1));
    setOptions(existing?.options.map((o) => ({ id: o.id, name: o.name, price: String(o.price_paise / 100), is_default: o.is_default })) ?? [{ name: '', price: '0', is_default: false }]);
  }, [value, existing]);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await rpc(staff.db, 'upsert_modifier_group', {
        p: {
          ...(existing ? { id: existing.id } : {}),
          name,
          kind,
          min_select: Number(min),
          max_select: Number(max),
          options: options.map((o) => ({ id: o.id, name: o.name, price_paise: kind === 'free_option' ? 0 : rupeesToPaise(Number(o.price) || 0), is_default: o.is_default })),
        },
      });
      onSaved(`${name} saved.`);
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={value !== undefined} title={existing ? `Edit ${existing.name}` : 'New choice group'} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label="Group name" placeholder="e.g. Ice level, Toppings" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="free_option">Free choice (ice level, sweetness…)</option>
          <option value="paid_addon">Paid add-on (boba, extra cheese…)</option>
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Must pick at least" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} />
          <TextField label="Can pick at most" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-bold">Options</legend>
          {options.map((o, i) => (
            <div key={o.id ?? `n${i}`} className="flex items-center gap-2">
              <input aria-label="Option name" value={o.name} onChange={(e) => setOptions((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} maxLength={40} className="h-10 flex-1 rounded-xl border border-line px-3" />
              {kind === 'paid_addon' && (
                <div className="flex h-10 w-24 items-center rounded-xl border border-line px-2">
                  <span className="text-ink-muted">+₹</span>
                  <input aria-label="Price" inputMode="decimal" value={o.price} onChange={(e) => setOptions((rows) => rows.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))} className="w-full pl-1 outline-none" />
                </div>
              )}
              <label className="flex items-center gap-1 text-xs" title="Pre-selected">
                <input type="checkbox" checked={o.is_default} onChange={(e) => setOptions((rows) => rows.map((r, j) => (j === i ? { ...r, is_default: e.target.checked } : r)))} /> Default
              </label>
              <button type="button" aria-label="Remove option" disabled={options.length === 1} onClick={() => setOptions((rows) => rows.filter((_, j) => j !== i))} className="size-8 rounded-full text-ink-muted disabled:opacity-30">
                ✕
              </button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setOptions((rows) => [...rows, { name: '', price: '0', is_default: false }])}>
            + Add option
          </Button>
        </fieldset>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" block loading={busy} disabled={!name.trim() || options.some((o) => !o.name.trim())}>
          Save group
        </Button>
        {existing && (
          <Button variant="ghost" onClick={() => onArchive(existing)}>
            Remove group
          </Button>
        )}
      </form>
    </Dialog>
  );
}
