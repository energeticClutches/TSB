/**
 * Third-party scripts allowed by our Content-Security-Policy (Phase 8 §3.4): Razorpay Checkout
 * and Cloudflare Turnstile. Both load only when needed, keeping the menu fast.
 */
import type { RazorpayOptions } from './api';
import { env } from './env';

const loaded = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loaded.delete(src);
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(s);
    });
    loaded.set(src, p);
  }
  return p;
}

// ---------------------------------------------------------------- Razorpay

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (resp: unknown) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      execute(id: string): void;
      reset(id: string): void;
      remove(id: string): void;
    };
  }
}

export type PaymentOutcome = 'completed' | 'dismissed' | 'failed';

/** Opens Razorpay's UPI sheet. The result is only a hint: the server always confirms with Razorpay. */
export async function openRazorpay(opts: RazorpayOptions): Promise<PaymentOutcome> {
  await loadScript('https://checkout.razorpay.com/v1/checkout.js');
  return new Promise((resolve) => {
    const rzp = new window.Razorpay!({
      key: opts.key_id,
      order_id: opts.order_id,
      amount: opts.amount,
      currency: opts.currency,
      name: opts.name,
      description: 'Order at The Slush Bar',
      prefill: { contact: opts.prefill.contact, name: opts.prefill.name },
      theme: { color: '#E6007A' },
      config: { display: { preferences: { show_default_blocks: true } } },
      handler: () => resolve('completed'),
      modal: { ondismiss: () => resolve('dismissed'), confirm_close: true },
    });
    rzp.on('payment.failed', () => resolve('failed'));
    rzp.open();
  });
}

// ---------------------------------------------------------------- Turnstile (invisible bot check)

export async function getTurnstileToken(): Promise<string> {
  if (env.demo) return 'demo';
  await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.bottom = '0';
  host.style.left = '0';
  document.body.appendChild(host);
  try {
    return await new Promise<string>((resolve, reject) => {
      const id = window.turnstile!.render(host, {
        sitekey: env.turnstileSiteKey,
        size: 'invisible',
        callback: (token: string) => resolve(token),
        'error-callback': () => reject(new Error('turnstile')),
        'timeout-callback': () => reject(new Error('turnstile')),
      });
      window.turnstile!.execute(id);
    });
  } finally {
    host.remove();
  }
}
