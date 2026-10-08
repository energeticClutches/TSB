import { formatINR, rupeesToPaise } from '@slush/core';
import { Alert, Button, Dialog, SelectField, Switch, TextField, cn } from '@slush/ui';
import { useEffect, useState } from 'react';
import { rpc } from '../lib/api';
import { ApiError, messageOf } from '../lib/errors';
import { menuImageUrl, toMenuWebp } from '../lib/image';
import { type AdminMenu, type AdminProduct, type AdminWindow, FLAVOUR_COLOURS, WEEKDAYS } from '../lib/menuAdmin';
import { useStaff } from '../lib/session';

interface VariantRow {
  id?: string | undefined;
  name: string;
  price: string;
  is_default: boolean;
}

const emptyVariant = (): VariantRow => ({ name: '', price: '', is_default: false });

/** Add or edit a menu item: sizes, add-ons, photo, colour, time windows (Phase 6 A8b). */
export function ItemEditor({
  open,
  product,
  categoryId,
  menu,
  onClose,
  onSaved,
}: {
  open: boolean;
  product: AdminProduct | undefined;
  categoryId: string | undefined;
  menu: AdminMenu;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const staff = useStaff();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState<'item' | 'combo'>('item');
  const [accent, setAccent] = useState<string | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [prep, setPrep] = useState('5');
  const [featured, setFeatured] = useState(false);
  const [active, setActive] = useState(true);
  const [variants, setVariants] = useState<VariantRow[]>([emptyVariant()]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [windows, setWindows] = useState<AdminWindow[]>([]);
  const [combo, setCombo] = useState<{ product_id: string; qty: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setName(product?.name ?? '');
    setDescription(product?.description ?? '');
    setCategory(product?.category_id ?? categoryId ?? menu.categories[0]?.id ?? '');
    setKind(product?.kind ?? 'item');
    setAccent(product?.accent_color ?? null);
    setImagePath(product?.image_path ?? null);
    setPrep(String(product?.prep_minutes ?? 5));
    setFeatured(product?.is_featured ?? false);
    setActive(product?.is_active ?? true);
    setVariants(
      product?.variants.length
        ? product.variants.map((v) => ({ id: v.id, name: v.name, price: String(v.price_paise / 100), is_default: v.is_default }))
        : [{ ...emptyVariant(), name: 'Regular', is_default: true }],
    );
    setGroupIds(product?.modifier_group_ids ?? []);
    setWindows(product?.windows ?? []);
    setCombo(product?.combo_components.map((c) => ({ product_id: c.product_id, qty: c.qty })) ?? []);
  }, [open, product, categoryId, menu.categories]);

  const setVariant = (i: number, patch: Partial<VariantRow>) =>
    setVariants((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : patch.is_default ? { ...r, is_default: false } : r)));

  const upload = async (file: File) => {
    setUploading(true);
    setError(undefined);
    try {
      const blob = await toMenuWebp(file);
      // Storage policy: files must live under the uploader's branch folder.
      const path = `${await branchFolder()}/${crypto.randomUUID()}.webp`;
      const { error: e } = await staff.db.storage.from('menu').upload(path, blob, { contentType: 'image/webp', cacheControl: '31536000', upsert: false });
      if (e) throw new ApiError('INTERNAL', 'The photo couldn’t be uploaded. Try again.');
      setImagePath(path);
    } catch (e) {
      setError(e instanceof Error && !(e instanceof ApiError) ? e.message : messageOf(e));
    } finally {
      setUploading(false);
    }
  };

  const branchFolder = async () => {
    const { data } = await staff.db.from('branches').select('id').single();
    return (data as { id: string }).id;
  };

  const save = async () => {
    setError(undefined);
    const priced = variants.map((v) => ({ ...v, paise: Number.isFinite(Number(v.price)) && v.price.trim() !== '' ? rupeesToPaise(Number(v.price)) : NaN }));
    if (priced.some((v) => !v.name.trim() || Number.isNaN(v.paise) || v.paise < 0)) return setError('Every size needs a name and a price.');
    // Typo guard (Phase 2 §2.6): confirm big price drops before sending.
    for (const v of priced) {
      const old = product?.variants.find((o) => o.id === v.id);
      if (old && old.price_paise > 0 && v.paise < old.price_paise * 0.5) {
        const ok = window.confirm(`${v.name}: ${formatINR(old.price_paise)} → ${formatINR(v.paise)}. That’s a big drop. Is it correct?`);
        if (!ok) return;
      }
    }
    setBusy(true);
    try {
      const result = await rpc<{ product_id: string; pending_approvals: { variant: string }[] }>(staff.db, 'upsert_product', {
        p: {
          ...(product ? { id: product.id } : {}),
          category_id: category,
          kind,
          name,
          description,
          image_path: imagePath ?? '',
          accent_color: accent ?? '',
          prep_minutes: Number(prep) || 0,
          is_featured: featured,
          is_active: active,
          variants: priced.map((v) => ({ id: v.id, name: v.name.trim(), price_paise: v.paise, is_default: v.is_default })),
          modifier_group_ids: groupIds,
          windows,
          combo_components: kind === 'combo' ? combo : [],
        },
      });
      onSaved(
        result.pending_approvals.length
          ? `Saved. The price drop for ${result.pending_approvals.map((p) => p.variant).join(', ')} needs the Owner’s approval, so the old price stays until then.`
          : `${name} saved. It’s live on the menu within a minute.`,
      );
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const otherItems = menu.products.filter((p) => p.kind === 'item' && p.id !== product?.id);

  return (
    <Dialog open={open} wide title={product ? `Edit ${product.name}` : 'Add a menu item'} onClose={onClose}>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
          <div className="flex flex-col items-center gap-2">
            <div
              className="grid size-40 place-items-center overflow-hidden rounded-3xl border-2 border-dashed border-line"
              style={accent ? { background: `radial-gradient(circle, ${accent}33, transparent 70%)` } : undefined}
            >
              {imagePath ? <img src={menuImageUrl(imagePath)} alt="" className="size-full object-cover" /> : <span className="px-4 text-center text-sm text-ink-muted">No photo yet</span>}
            </div>
            <label className="cursor-pointer text-sm font-bold text-brand-ink underline">
              {uploading ? 'Uploading…' : imagePath ? 'Change photo' : 'Upload photo'}
              <input type="file" accept="image/*" className="sr-only" disabled={uploading} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            </label>
            {imagePath && (
              <button type="button" className="text-xs text-ink-muted underline" onClick={() => setImagePath(null)}>
                Remove photo
              </button>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} hint={`${description.length}/300`} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
                {menu.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
              <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as 'item' | 'combo')}>
                <option value="item">Menu item</option>
                <option value="combo">Combo (bundle of items)</option>
              </SelectField>
            </div>
          </div>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-bold">Sizes & prices</legend>
          <div className="flex flex-col gap-2">
            {variants.map((v, i) => (
              <div key={v.id ?? `new-${i}`} className="grid grid-cols-[1fr_110px_auto_auto_auto] items-center gap-2">
                <input aria-label="Size name" placeholder="e.g. Regular 350 ml" value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} maxLength={40} className="h-11 rounded-xl border border-line px-3" />
                <div className="flex h-11 items-center rounded-xl border border-line px-3">
                  <span className="text-ink-muted">₹</span>
                  <input aria-label="Price in rupees" inputMode="decimal" value={v.price} onChange={(e) => setVariant(i, { price: e.target.value })} className="w-full pl-1 outline-none" />
                </div>
                <label className="flex items-center gap-1 text-xs">
                  <input type="radio" name="default-size" checked={v.is_default} onChange={() => setVariant(i, { is_default: true })} /> Default
                </label>
                <button type="button" aria-label="Remove size" disabled={variants.length === 1} onClick={() => setVariants((rows) => rows.filter((_, j) => j !== i))} className="grid size-9 place-items-center rounded-full text-ink-muted hover:bg-danger-tint hover:text-danger disabled:opacity-30">
                  ✕
                </button>
              </div>
            ))}
          </div>
          {variants.length < 10 && (
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setVariants((rows) => [...rows, emptyVariant()])}>
              + Add size
            </Button>
          )}
        </fieldset>

        {kind === 'combo' && (
          <fieldset>
            <legend className="mb-2 text-sm font-bold">What’s in the combo</legend>
            {combo.map((c, i) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <select value={c.product_id} onChange={(e) => setCombo((rows) => rows.map((r, j) => (j === i ? { ...r, product_id: e.target.value } : r)))} className="h-11 flex-1 rounded-xl border border-line px-3">
                  {otherItems.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input aria-label="Quantity" type="number" min={1} max={10} value={c.qty} onChange={(e) => setCombo((rows) => rows.map((r, j) => (j === i ? { ...r, qty: Number(e.target.value) } : r)))} className="h-11 w-20 rounded-xl border border-line px-3" />
                <button type="button" aria-label="Remove" onClick={() => setCombo((rows) => rows.filter((_, j) => j !== i))} className="size-9 rounded-full text-ink-muted hover:text-danger">
                  ✕
                </button>
              </div>
            ))}
            <Button size="sm" variant="ghost" disabled={!otherItems.length} onClick={() => setCombo((rows) => [...rows, { product_id: otherItems[0]!.id, qty: 1 }])}>
              + Add item to combo
            </Button>
          </fieldset>
        )}

        {menu.groups.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-bold">Choices & add-ons</legend>
            <div className="flex flex-wrap gap-2">
              {menu.groups.map((g) => {
                const on = groupIds.includes(g.id);
                return (
                  <button key={g.id} type="button" aria-pressed={on} onClick={() => setGroupIds((ids) => (on ? ids.filter((x) => x !== g.id) : [...ids, g.id]))} className={cn('rounded-full border-2 px-4 py-2 text-sm font-bold transition', on ? 'border-brand bg-brand-tint text-brand-ink' : 'border-line text-ink-muted')}>
                    {on ? '✓ ' : ''}
                    {g.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-2 text-sm font-bold">Card colour</legend>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setAccent(null)} aria-pressed={accent === null} className={cn('h-9 rounded-full border-2 px-3 text-xs font-bold', accent === null ? 'border-ink' : 'border-line')}>
                None
              </button>
              {FLAVOUR_COLOURS.map((c) => (
                <button key={c.hex} type="button" title={c.name} aria-label={c.name} aria-pressed={accent === c.hex} onClick={() => setAccent(c.hex)} className={cn('size-9 rounded-full border-4', accent === c.hex ? 'border-ink' : 'border-white shadow-card')} style={{ background: c.hex }} />
              ))}
            </div>
          </fieldset>
          <TextField label="Preparation time (minutes)" inputMode="numeric" value={prep} onChange={(e) => setPrep(e.target.value.replace(/\D/g, ''))} hint="Used for the customer’s waiting-time estimate." />
        </div>

        <WindowsEditor windows={windows} onChange={setWindows} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Switch checked={featured} onChange={setFeatured} label="Featured" description="Shown in the top carousel." />
          <Switch checked={active} onChange={setActive} label="On the menu" description="Turn off to hide it without deleting." />
        </div>

        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={uploading || !name.trim() || !category}>
            Save item
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function WindowsEditor({ windows, onChange }: { windows: AdminWindow[]; onChange: (w: AdminWindow[]) => void }) {
  const update = (i: number, patch: Partial<AdminWindow>) => onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-bold">Only available at certain times</legend>
      <p className="mb-2 text-sm text-ink-muted">Leave empty to sell during all opening hours.</p>
      {windows.map((w, i) => (
        <div key={i} className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl bg-surface p-3">
          <div className="flex gap-1">
            {WEEKDAYS.map((d, bit) => {
              const on = (w.days_mask & (1 << bit)) !== 0;
              return (
                <button key={d} type="button" aria-pressed={on} onClick={() => update(i, { days_mask: w.days_mask ^ (1 << bit) || w.days_mask })} className={cn('h-8 w-10 rounded-full text-xs font-bold', on ? 'bg-brand text-white' : 'bg-card text-ink-muted')}>
                  {d}
                </button>
              );
            })}
          </div>
          <input aria-label="From" type="time" value={w.start} onChange={(e) => update(i, { start: e.target.value })} className="h-9 rounded-xl border border-line px-2" />
          <span className="text-sm">to</span>
          <input aria-label="Until" type="time" value={w.end} onChange={(e) => update(i, { end: e.target.value })} className="h-9 rounded-xl border border-line px-2" />
          <button type="button" aria-label="Remove time window" onClick={() => onChange(windows.filter((_, j) => j !== i))} className="ml-auto size-8 rounded-full text-ink-muted hover:text-danger">
            ✕
          </button>
        </div>
      ))}
      {windows.length < 7 && (
        <Button size="sm" variant="ghost" onClick={() => onChange([...windows, { days_mask: 127, start: '16:00', end: '23:00' }])}>
          + Add time window
        </Button>
      )}
    </fieldset>
  );
}
