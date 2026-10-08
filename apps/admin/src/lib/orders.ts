import type { SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from './api';

export type OrderStatus =
  | 'pending' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'completed' | 'delivered' | 'rejected' | 'cancelled' | 'refunded';
export type OrderType = 'dine_in' | 'takeaway' | 'delivery';

export interface ItemOption {
  group: string;
  name: string;
  price_paise?: number;
}
export interface OrderItem {
  id: string;
  name: string;
  variant: string;
  qty: number;
  note: string | null;
  options: ItemOption[];
  unit_price_paise?: number;
  line_total_paise?: number;
  promo_discount_paise?: number;
  refunded_qty?: number;
}

/** A card on the counter board (public.live_orders). */
export interface BoardOrder {
  id: string;
  order_number: string;
  pickup_number: number;
  order_type: OrderType;
  status: OrderStatus;
  version: number;
  table_label: string | null;
  customer_name: string;
  mobile_masked: string;
  note: string | null;
  total_paise: number;
  requires_mobile_check: boolean;
  on_hold: boolean;
  hold_reason: string | null;
  late_payment: boolean;
  paid_at: string;
  confirmed_at: string | null;
  preparing_at: string | null;
  ready_at: string | null;
  eta_minutes: number | null;
  delivery_address: string | null;
  delivery_landmark: string | null;
  items: OrderItem[];
}

/** Kitchen card: no prices or phone numbers exist in this shape (public.kitchen_orders). */
export interface KitchenOrder {
  id: string;
  pickup_number: number;
  order_number: string;
  order_type: OrderType;
  table_label: string | null;
  status: 'confirmed' | 'preparing';
  version: number;
  note: string | null;
  confirmed_at: string;
  preparing_at: string | null;
  items: OrderItem[];
}

export interface Refund {
  id: string;
  kind: 'full' | 'partial';
  amount_paise: number;
  reason: string;
  status: 'requested' | 'approved' | 'declined' | 'processing' | 'processed' | 'failed';
  is_automatic: boolean;
  needs_owner: boolean;
  requested_by: string | null;
  decided_by: string | null;
  created_at: string;
  failure_reason: string | null;
  decision_note: string | null;
}

export interface OrderDetail extends BoardOrder {
  subtotal_paise: number;
  promo_discount_paise: number;
  order_discount_paise: number;
  delivery_fee_paise: number;
  tax_paise: number;
  reject_reason: string | null;
  cancel_reason: string | null;
  completed_at: string | null;
  mobile_checked_at: string | null;
  receipt_number: string | null;
  payments: {
    id: string;
    provider_payment_id: string;
    amount_paise: number;
    status: string;
    method: string | null;
    vpa_masked: string | null;
    refunded_paise: number;
    is_duplicate: boolean;
    captured_at: string | null;
    failure_reason: string | null;
  }[];
  refunds: Refund[];
  timeline: { from: OrderStatus | null; to: OrderStatus; actor: 'customer' | 'staff' | 'system'; staff: string | null; reason: string | null; at: string }[];
  flags: { rule: string; severity: 'info' | 'warn' | 'block'; status: string; at: string }[];
}

export interface ReceiptData {
  receipt_number: string;
  is_tax_invoice: boolean;
  issued_at: string;
  snapshot: {
    shop: { header: string; legal_name: string | null; address: string; pincode: string | null; phone: string | null; gstin: string | null };
    order: { order_number: string; pickup_number: number; order_type: OrderType; table_label: string | null; customer_name: string; paid_at: string; delivery_address: string | null };
    items: OrderItem[];
    totals: {
      subtotal_paise: number;
      promo_discount_paise: number;
      order_discount_paise: number;
      delivery_fee_paise: number;
      tax_paise: number;
      tax_included_paise: number;
      total_paise: number;
      gst_rate_bp: number | null;
      gst_inclusive: boolean | null;
    };
    payment: { method: string | null; vpa_masked: string | null; reference: string | null };
    footer: string | null;
  };
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'New',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  delivered: 'Delivered',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

export const TYPE_LABEL: Record<OrderType, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };

export function whereLabel(o: { order_type: OrderType; table_label: string | null }): string {
  return o.order_type === 'dine_in' && o.table_label ? `Table ${o.table_label}` : TYPE_LABEL[o.order_type];
}

/** The one forward step the counter can take next (the database enforces the same rules). */
export function nextStep(o: { status: OrderStatus; order_type: OrderType }): { to: OrderStatus; label: string } | null {
  switch (o.status) {
    case 'confirmed':
      return { to: 'preparing', label: 'Start' };
    case 'preparing':
      return { to: 'ready', label: 'Ready' };
    case 'ready':
      return o.order_type === 'delivery' ? { to: 'out_for_delivery', label: 'Out for delivery' } : { to: 'completed', label: o.order_type === 'dine_in' ? 'Served' : 'Handed over' };
    case 'out_for_delivery':
      return { to: 'delivered', label: 'Delivered' };
    default:
      return null;
  }
}

export function minutesSince(iso: string | null | undefined, now: number): number {
  return iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000)) : 0;
}

export function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : '';
}

/** A clock that ticks every 20 s, for "4 min ago" labels and the late-order pulse. */
export function useNow(intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface LiveResult<T> {
  orders: T[];
  late_after_min: number;
}

/**
 * Live list for the board / kitchen. Realtime broadcasts are only hints ("something changed"),
 * so every hint and a 15-second timer both simply re-fetch from the database (Phase 7 §7).
 */
export function useLiveOrders<T extends { id: string }>(db: SupabaseClient, branchId: string, fn: 'live_orders' | 'kitchen_orders') {
  const [data, setData] = useState<LiveResult<T>>();
  const [error, setError] = useState<unknown>();
  const [connected, setConnected] = useState(false);
  const inFlight = useRef(false);
  const again = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      setData(await rpc<LiveResult<T>>(db, fn));
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [db, fn]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 15_000);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);

    let channel: ReturnType<SupabaseClient['channel']> | undefined;
    if (branchId) {
      channel = db
        .channel(`branch:${branchId}:orders`, { config: { private: true } })
        .on('broadcast', { event: 'order' }, () => void load())
        .subscribe((status) => setConnected(status === 'SUBSCRIBED'));
    }
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) void db.removeChannel(channel);
    };
  }, [db, branchId, load]);

  return { data, error, connected, reload: load };
}
