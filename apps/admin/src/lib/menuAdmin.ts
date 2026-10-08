import type { SupabaseClient } from '@supabase/supabase-js';
import { select } from './api';

/** Menu as the admin edits it (raw tables through row-level security, not the public snapshot). */
export interface AdminVariant {
  id?: string;
  name: string;
  price_paise: number;
  is_default: boolean;
}
export interface AdminWindow {
  days_mask: number;
  start: string;
  end: string;
}
export interface AdminProduct {
  id: string;
  category_id: string;
  kind: 'item' | 'combo';
  name: string;
  description: string;
  image_path: string | null;
  accent_color: string | null;
  prep_minutes: number;
  is_featured: boolean;
  is_sold_out: boolean;
  is_active: boolean;
  sort_order: number;
  variants: AdminVariant[];
  modifier_group_ids: string[];
  windows: AdminWindow[];
  combo_components: { product_id: string; variant_id: string | null; qty: number }[];
}
export interface AdminCategory {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  windows: AdminWindow[];
}
export interface AdminOption {
  id?: string;
  name: string;
  price_paise: number;
  is_default: boolean;
  is_sold_out?: boolean;
}
export interface AdminGroup {
  id: string;
  name: string;
  kind: 'paid_addon' | 'free_option';
  min_select: number;
  max_select: number;
  options: AdminOption[];
}
export interface AdminMenu {
  categories: AdminCategory[];
  products: AdminProduct[];
  groups: AdminGroup[];
}

const hhmm = (t: string) => t.slice(0, 5);

export async function loadAdminMenu(db: SupabaseClient): Promise<AdminMenu> {
  const [cats, prods, groups] = await Promise.all([
    select<(Omit<AdminCategory, 'windows'> & { availability_windows: { days_mask: number; start_time: string; end_time: string }[] })[]>(
      db.from('categories').select('id, name, sort_order, is_active, availability_windows(days_mask, start_time, end_time)').is('archived_at', null).order('sort_order'),
    ),
    select<any[]>(
      db
        .from('products')
        .select(
          `id, category_id, kind, name, description, image_path, accent_color, prep_minutes, is_featured, is_sold_out, is_active, sort_order,
           product_variants(id, name, price_paise, is_default, sort_order, archived_at),
           product_modifier_groups(group_id, sort_order),
           availability_windows(days_mask, start_time, end_time),
           combo_components!combo_components_combo_product_id_fkey(component_product_id, component_variant_id, qty, sort_order)`,
        )
        .is('archived_at', null)
        .order('sort_order'),
    ),
    select<any[]>(
      db
        .from('modifier_groups')
        .select('id, name, kind, min_select, max_select, modifier_options(id, name, price_paise, is_default, is_sold_out, sort_order, archived_at)')
        .is('archived_at', null)
        .order('name'),
    ),
  ]);

  const bySort = <T extends { sort_order: number }>(a: T, b: T) => a.sort_order - b.sort_order;
  return {
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      sort_order: c.sort_order,
      is_active: c.is_active,
      windows: c.availability_windows.map((w) => ({ days_mask: w.days_mask, start: hhmm(w.start_time), end: hhmm(w.end_time) })),
    })),
    products: prods.map((p) => ({
      id: p.id,
      category_id: p.category_id,
      kind: p.kind,
      name: p.name,
      description: p.description,
      image_path: p.image_path,
      accent_color: p.accent_color,
      prep_minutes: p.prep_minutes,
      is_featured: p.is_featured,
      is_sold_out: p.is_sold_out,
      is_active: p.is_active,
      sort_order: p.sort_order,
      variants: [...p.product_variants]
        .filter((v: { archived_at: string | null }) => !v.archived_at)
        .sort(bySort)
        .map((v: any) => ({ id: v.id, name: v.name, price_paise: Number(v.price_paise), is_default: v.is_default, is_token_redeemable: v.is_token_redeemable })),
      modifier_group_ids: [...p.product_modifier_groups].sort(bySort).map((g: { group_id: string }) => g.group_id),
      windows: p.availability_windows.map((w: any) => ({ days_mask: w.days_mask, start: hhmm(w.start_time), end: hhmm(w.end_time) })),
      combo_components: [...p.combo_components]
        .sort(bySort)
        .map((c: any) => ({ product_id: c.component_product_id, variant_id: c.component_variant_id, qty: c.qty })),
    })),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      min_select: g.min_select,
      max_select: g.max_select,
      options: [...g.modifier_options]
        .filter((o: { archived_at: string | null }) => !o.archived_at)
        .sort(bySort)
        .map((o: any) => ({ id: o.id, name: o.name, price_paise: Number(o.price_paise), is_default: o.is_default, is_sold_out: o.is_sold_out })),
    })),
  };
}

/** The five poster flavours, offered as one-tap accent colours. */
export const FLAVOUR_COLOURS = [
  { name: 'Blue Lagoon', hex: '#00C0F3' },
  { name: 'Mango Mania', hex: '#FFB300' },
  { name: 'Strawberry Splash', hex: '#FF1744' },
  { name: 'Kiwi Kick', hex: '#64DD17' },
  { name: 'Jamun Twist', hex: '#7B1FA2' },
  { name: 'Brand pink', hex: '#E6007A' },
];

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
