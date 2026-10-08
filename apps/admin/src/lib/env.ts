const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

const orderUrl = import.meta.env.VITE_ORDER_URL as string | undefined;

export const env = {
  /** Customer ordering site, printed into the table QR codes, e.g. https://order.theslushbar.in */
  orderUrl: (orderUrl ?? 'http://localhost:5174').replace(/\/$/, ''),
  supabaseUrl: url ?? '',
  publishableKey: publishableKey ?? '',
  /** False until .env.local is filled in (see .env.example). */
  configured: Boolean(url && publishableKey),
  /**
   * Demo mode: the whole backend runs in this browser (see src/demo). On when VITE_DEMO=true,
   * or when no Supabase project is configured yet (decided at build time in vite.config.ts).
   */
  demo: __DEMO__,
};
