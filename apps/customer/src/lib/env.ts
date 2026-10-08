const e = import.meta.env;

export const env = {
  /** Demo mode: built-in menu + simulated payments, no backend (for previews and reviews). */
  demo: e.VITE_DEMO === 'true' || !e.VITE_SUPABASE_URL,
  branchSlug: (e.VITE_BRANCH_SLUG as string | undefined) ?? 'bahadurgarh-s6',
  supabaseUrl: (e.VITE_SUPABASE_URL as string | undefined) ?? '',
  publishableKey: (e.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? '',
  turnstileSiteKey: (e.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '1x00000000000000000000AA',
};

/** Menu photos: our bundled placeholders (/img/…) or Supabase Storage paths. */
export function imageUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (path.startsWith('/') || path.startsWith('http')) return path;
  return `${env.supabaseUrl}/storage/v1/object/public/menu/${path}`;
}
