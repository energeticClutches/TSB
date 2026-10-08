/**
 * Live order status: Supabase Realtime broadcast on the channel named by the order's secret
 * token (Phase 5 §4.5), plus a slow poll as a fallback for flaky connections. The realtime
 * client is only downloaded on the tracker page.
 */
import { env } from './env';

export function watchOrder(token: string, onChange: () => void): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | null = null;

  if (!env.demo && env.supabaseUrl && env.publishableKey) {
    void import('@supabase/realtime-js')
      .then(({ RealtimeClient }) => {
        if (stopped) return;
        const client = new RealtimeClient(`${env.supabaseUrl.replace(/^http/, 'ws')}/realtime/v1`, {
          params: { apikey: env.publishableKey },
        });
        const channel = client.channel(`order:${token}`).on('broadcast', { event: 'status' }, () => onChange());
        channel.subscribe();
        unsubscribe = () => {
          void channel.unsubscribe();
          client.disconnect();
        };
      })
      .catch(() => undefined);
  }

  // Poll while the page is visible: fast in the demo, every 20 s otherwise.
  const interval = env.demo ? 3_000 : 20_000;
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') onChange();
  }, interval);
  const onVisible = () => document.visibilityState === 'visible' && onChange();
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    unsubscribe?.();
  };
}
