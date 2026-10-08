import { type MenuSnapshot, type OrderType, formatINR, normalizeMobile } from '@slush/core';
import { cn } from '@slush/ui';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '../components/Chrome';
import { ApiError, type Loyalty, type Quote, type RazorpayOptions, getApi } from '../lib/api';
import { cart, useCart } from '../lib/cart';
import { env } from '../lib/env';
import { allowedOrderTypes, loadOrderType, rememberCustomer, rememberOrder, savedCustomer, useOrderingContext } from '../lib/ordering';
import { navigate } from '../lib/router';
import { getTurnstileToken, openRazorpay } from '../lib/scripts';
import { deviceId, load, save } from '../lib/storage';
import { ORDER_TYPE_LABEL, Row, problemText } from './CartPage';

// The map library is big; phones only download it when someone picks delivery.
const DeliveryMap = lazy(() => import('../components/DeliveryMap'));

/** One idempotency key per attempt, surviving refreshes, so a double tap never makes two orders (FR-18). */
function attemptKey(fingerprint: string): string {
  const saved = load<{ fp: string; key: string } | null>('slush-attempt', null, 'session');
  if (saved?.fp === fingerprint) return saved.key;
  const key = crypto.randomUUID();
  save('slush-attempt', { fp: fingerprint, key }, 'session');
  return key;
}

/** One-page checkout (Phase 6 C4). */
export function CheckoutPage({ menu }: { menu: MenuSnapshot }) {
  const lines = useCart();
  const ctx = useOrderingContext();
  const orderType: OrderType = loadOrderType(allowedOrderTypes(ctx, menu.branch.delivery_enabled));
  const saved = savedCustomer();
  const [name, setName] = useState(saved.name);
  const [mobile, setMobile] = useState(saved.mobile);
  const [note, setNote] = useState('');
  const [address, setAddress] = useState('');
  const [landmark, setLandmark] = useState('');
  const [location, setLocation] = useState<{ lat: number; lng: number }>();
  const [quote, setQuote] = useState<Quote>();
  const [changed, setChanged] = useState<Quote>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [demoPay, setDemoPay] = useState<{ token: string; options: RazorpayOptions }>();
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<string>();
  const quoteSeq = useRef(0);

  const validMobile = normalizeMobile(mobile) ? mobile.replace(/\D/g, '').slice(-10) : undefined;
  const cartLines = useMemo(
    () => lines.map(({ line_id, product_id, variant_id, qty, option_ids, note: n }) => ({ line_id, product_id, variant_id, qty, option_ids, note: n })),
    [lines],
  );

  const baseRequest = useCallback(
    () => ({
      ...(ctx.qrSlug ? { qr_slug: ctx.qrSlug } : {}),
      branch_slug: ctx.branchSlug,
      order_type: orderType,
      lines: cartLines,
      device_id: deviceId(),
      ...(validMobile ? { mobile: validMobile } : {}),
      ...(coupon ? { coupon_code: coupon } : {}),
      ...(orderType === 'delivery' && location ? { delivery: location } : {}),
    }),
    [ctx, orderType, cartLines, validMobile, coupon, location],
  );

  // Always show the SERVER's price (FR-14), refreshed when the cart or location changes.
  useEffect(() => {
    if (!lines.length) return;
    const seq = ++quoteSeq.current;
    void getApi()
      .then((api) => api.quote(baseRequest()))
      .then(
        (q) => seq === quoteSeq.current && setQuote(q),
        (e: unknown) => seq === quoteSeq.current && setError(e instanceof ApiError ? e.message : 'Couldn’t load the price. Check your connection.'),
      );
  }, [lines, baseRequest]);

  useEffect(() => {
    if (!lines.length && !busy) navigate('/menu', { replace: true });
  }, [lines.length, busy]);

  const validate = (): boolean => {
    const f: Record<string, string> = {};
    if (!name.trim()) f.name = 'Please enter your name.';
    if (!normalizeMobile(mobile)) f.mobile = 'Enter a 10-digit mobile number.';
    if (orderType === 'delivery' && address.trim().length < 5) f.address = 'Enter your delivery address.';
    if (orderType === 'delivery' && !location) f.location = 'Share your location so we can check we deliver there.';
    setFields(f);
    return Object.keys(f).length === 0;
  };

  const pay = async () => {
    setError(undefined);
    if (!quote || !validate()) return;
    setBusy(true);
    try {
      const api = await getApi();
      const turnstile = await getTurnstileToken().catch(() => {
        throw new ApiError('BOT_CHECK_FAILED', 'We couldn’t verify this device. Refresh the page and try again.');
      });
      const request = {
        ...baseRequest(),
        customer: { name: name.trim(), mobile },
        note: note.trim(),
        quote_hash: quote.quote_hash,
        'cf-turnstile-response': turnstile,
        ...(orderType === 'delivery' ? { delivery_details: { address, landmark } } : {}),
      };
      const key = attemptKey(JSON.stringify([request.lines, request.order_type, name.trim(), mobile, note.trim(), address, coupon]));
      const res = await api.checkout(request, key);
      rememberCustomer({ name: name.trim(), mobile });
      rememberOrder(res.public_token);
      if (!res.razorpay) {
        // Nothing to pay (a full discount): straight to the tracker.
        cart.clear();
        navigate(`/order/${res.public_token}`);
        return;
      }
      if (api.demo) {
        setDemoPay({ token: res.public_token, options: res.razorpay });
        return;
      }
      const outcome = await openRazorpay(res.razorpay);
      // Whatever the sheet says, the order page asks the server, which asks Razorpay (API-4).
      if (outcome === 'completed') cart.clear();
      navigate(`/order/${res.public_token}${outcome === 'completed' ? '' : '?unpaid=1'}`);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'PRICE_CHANGED' || e.code === 'ITEM_UNAVAILABLE') {
          setQuote(e.details.quote as Quote);
          setChanged(e.details.quote as Quote);
        } else if (e.code === 'VALIDATION_FAILED' && e.details.fields) setFields(e.details.fields as Record<string, string>);
        else if (e.code === 'COUPON_INVALID' || e.code === 'COUPON_EXHAUSTED') {
          setCoupon(undefined);
          setError(`${e.message} We removed it; check the new total and pay again.`);
        } else if (e.code === 'TOKENS_UNAVAILABLE' || e.code === 'TOO_MANY_TOKENS') {
          setError(`${e.message} Check the new total and pay again.`);
        }
        else if (e.code === 'IDEMPOTENCY_CONFLICT') {
          save('slush-attempt', null, 'session');
          setError('Please tap Pay again.');
        } else setError(e.message);
      } else setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const useMyLocation = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => setLocation({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }),
      () => setFields((f) => ({ ...f, location: 'Location permission was denied. Allow it in your browser settings.' })),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <div className="min-h-dvh pb-40">
      <Header back="/cart" title="Checkout" />
      <main className="mx-auto flex max-w-lg flex-col gap-5 px-4 pt-4">
        <p className="rounded-2xl bg-brand-tint px-4 py-2 text-sm font-bold text-brand-ink">
          {ORDER_TYPE_LABEL[orderType]}
          {orderType === 'dine_in' && ctx.tableLabel ? ` · Table ${ctx.tableLabel}` : ''}
        </p>

        <Field label="Your name" error={fields.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} className={inputCls(fields.name)} />
        </Field>
        <Field label="Mobile number" error={fields.mobile} hint="For your order updates and rewards. We never send marketing without asking.">
          <div className={cn(inputCls(fields.mobile), 'flex items-center gap-2')}>
            <span className="font-bold text-ink-muted">+91</span>
            <input value={mobile} onChange={(e) => setMobile(e.target.value.replace(/[^\d ]/g, '').slice(0, 11))} inputMode="numeric" autoComplete="tel-national" aria-label="Mobile number" className="w-full outline-none" />
          </div>
        </Field>
        <Field label="Note for the kitchen (optional)" hint={`${note.length}/200`}>
          <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} placeholder="e.g. kids at the table, paper straws" className={inputCls()} />
        </Field>

        {orderType === 'delivery' && (
          <section className="flex flex-col gap-4 rounded-3xl bg-card p-4 shadow-card">
            <Field label="Delivery address" error={fields.address}>
              <input value={address} onChange={(e) => setAddress(e.target.value.slice(0, 300))} autoComplete="street-address" placeholder="House / flat, street, sector" className={inputCls(fields.address)} />
            </Field>
            <Field label="Landmark (optional)">
              <input value={landmark} onChange={(e) => setLandmark(e.target.value.slice(0, 120))} className={inputCls()} />
            </Field>
            <Suspense fallback={<div className="grid h-56 place-items-center rounded-2xl bg-line/40 text-sm text-ink-muted">Loading map…</div>}>
              <DeliveryMap value={location} onChange={setLocation} />
            </Suspense>
            <button type="button" onClick={useMyLocation} className="h-12 rounded-full border-2 border-brand font-bold text-brand-ink">
              📍 {location ? 'Use my current location again' : 'Use my location'}
            </button>
            <p className="text-xs text-ink-muted">Drag the pin (or tap the map) to your door.</p>
            {fields.location && <p className="text-sm font-semibold text-danger">{fields.location}</p>}
            {quote?.delivery && (
              <p className={cn('text-sm font-bold', quote.delivery.in_area ? 'text-success' : 'text-danger')}>
                {quote.delivery.in_area
                  ? `✓ We deliver here · ${(quote.delivery.distance_m / 1000).toFixed(1)} km · ${formatINR(quote.delivery.fee_paise)} delivery`
                  : `✕ Outside our ${(quote.delivery.radius_m / 1000).toFixed(0)} km delivery area`}
              </p>
            )}
            {quote?.problems.includes('below_delivery_minimum') && quote.delivery && (
              <p className="text-sm font-bold text-warning">Delivery needs an order of at least {formatINR(quote.delivery.min_order_paise)}.</p>
            )}
          </section>
        )}

        {quote?.offers_enabled && (
          <section className="flex flex-col gap-2 rounded-3xl bg-card p-4 shadow-card" aria-labelledby="coupon-title">
            <h2 id="coupon-title" className="text-sm font-bold">🎟 Coupon code</h2>
            {coupon ? (
              <div className="flex items-center justify-between gap-3">
                <p className={cn('text-sm font-bold', quote.coupon?.status === 'applied' ? 'text-success' : 'text-danger')} role="status">
                  {quote.coupon?.status === 'applied' ? `✓ ${quote.coupon.message}: − ${formatINR(quote.coupon.discount_paise ?? 0)}` : (quote.coupon?.message ?? 'Checking…')}
                </p>
                <button type="button" onClick={() => setCoupon(undefined)} className="shrink-0 text-sm font-bold text-ink-muted underline">
                  Remove
                </button>
              </div>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (couponInput.trim()) setCoupon(couponInput.trim().toUpperCase());
                }}
              >
                <input
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 20))}
                  placeholder="e.g. SLUSH10"
                  aria-label="Coupon code"
                  autoCapitalize="characters"
                  className={cn(inputCls(), 'uppercase')}
                />
                <button type="submit" disabled={!couponInput.trim()} className="h-12 shrink-0 rounded-full border-2 border-brand px-5 font-bold text-brand-ink disabled:opacity-40">
                  Apply
                </button>
              </form>
            )}
          </section>
        )}

{quote?.loyalty.running && validMobile && <LuckyDraw loyalty={quote.loyalty} />}

        <dl className="flex flex-col gap-1 rounded-3xl bg-card p-4 shadow-card" aria-live="polite">
          {quote ? (
            <>
              <Row label="Item total" value={formatINR(quote.subtotal_paise)} />
              {quote.promo_discount_paise > 0 && <Row label="Happy hour" value={`− ${formatINR(quote.promo_discount_paise)}`} />}
              {quote.order_discount_paise > 0 && <Row label={quote.offer_label ?? `Coupon ${quote.coupon?.code ?? ''}`} value={`− ${formatINR(quote.order_discount_paise)}`} />}
              {quote.delivery_fee_paise > 0 && <Row label="Delivery fee" value={formatINR(quote.delivery_fee_paise)} />}
              {quote.tax_paise > 0 && <Row label="GST" value={formatINR(quote.tax_paise)} />}
              <Row label="To pay" value={formatINR(quote.total_paise)} strong />
              {quote.eta_minutes > 0 && <p className="text-xs text-ink-muted">Ready in about {quote.eta_minutes} minutes after the shop accepts.</p>}
            </>
          ) : (
            <p className="text-sm text-ink-muted">Checking prices…</p>
          )}
        </dl>
        {quote && !quote.ordering_open && <p className="rounded-2xl bg-warning-tint px-4 py-3 text-sm text-warning">We’re not taking orders right now. You can still browse the menu.</p>}
        {error && (
          <p role="alert" className="rounded-2xl bg-danger-tint px-4 py-3 text-sm text-danger">
            {error}
          </p>
        )}
      </main>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 pt-3 backdrop-blur">
        <div className="mx-auto max-w-lg">
          <button
            type="button"
            onClick={() => void pay()}
            disabled={busy || !quote || !quote.ordering_open}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-brand font-display text-lg font-black text-white shadow-glow transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? 'Please wait…' : !quote ? 'Pay with UPI' : quote.total_paise === 0 ? 'Place order · nothing to pay ▸' : `Pay ${formatINR(quote.total_paise)} with UPI ▸`}
          </button>
          <p className="mt-2 text-center text-xs text-ink-muted">
            🔒 Secured by Razorpay · GPay, PhonePe, Paytm or any UPI app ·{' '}
            <a href="/privacy" className="underline">
              Privacy
            </a>
          </p>
        </div>
      </div>

      {changed && <ChangedDialog quote={changed} onClose={() => setChanged(undefined)} />}
      {demoPay && <DemoPaySheet token={demoPay.token} amount={demoPay.options.amount} />}
    </div>
  );
}

const inputCls = (error?: string) =>
  cn('h-12 w-full rounded-2xl border bg-card px-4 text-base outline-none focus-within:border-brand focus:border-brand', error ? 'border-danger' : 'border-line');

function Field({ label, error, hint, children }: { label: string; error?: string | undefined; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-bold">{label}</span>
      {children}
      {error ? <span className="text-sm font-semibold text-danger">{error}</span> : hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </label>
  );
}

/** "Something changed" (Phase 6 C10): price changes or items that ran out since they were added. */
function ChangedDialog({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const bad = quote.lines.filter((l) => l.problems.length);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 backdrop-blur-sm sm:items-center">
      <div role="alertdialog" aria-modal="true" aria-labelledby="changed-title" className="w-full max-w-md rounded-t-[var(--radius-sheet)] bg-card p-6 shadow-dialog sm:rounded-3xl">
        <h2 id="changed-title" className="font-display text-xl font-black">
          Something changed
        </h2>
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {bad.map((l) => (
            <li key={l.line_id}>
              <b>{l.name}</b>: {problemText(l.problems[0]!)}
            </li>
          ))}
          {bad.length === 0 && <li>Some prices were updated. The new total is {formatINR(quote.total_paise)}.</li>}
        </ul>
        <button
          type="button"
          onClick={() => {
            if (bad.length) cart.removeMany(bad.map((l) => l.line_id));
            onClose();
          }}
          className="mt-5 h-12 w-full rounded-full bg-brand font-bold text-white"
        >
          {bad.length ? 'Remove and continue' : 'OK, continue'}
        </button>
      </div>
    </div>
  );
}

/** Demo mode only: stands in for the UPI app. No money moves. */
function DemoPaySheet({ token, amount }: { token: string; amount: number }) {
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    setBusy(true);
    const { demoPay } = await import('../demo/demoApi');
    demoPay(token);
    cart.clear();
    navigate(`/order/${token}`);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-label="Demo payment" className="w-full max-w-md rounded-t-[var(--radius-sheet)] bg-card p-6 text-center shadow-dialog">
        <p className="text-xs font-bold tracking-widest text-ink-muted uppercase">Demo UPI · {env.demo ? 'simulated' : ''}</p>
        <p className="mt-2 font-display text-4xl font-black">{formatINR(amount)}</p>
        <p className="mt-1 text-sm text-ink-muted">In the live site this is where GPay / PhonePe / Paytm opens.</p>
        <button type="button" disabled={busy} onClick={() => void pay()} className="mt-5 h-14 w-full rounded-full bg-success font-display text-lg font-black text-white">
          {busy ? 'Paying…' : 'Simulate successful payment'}
        </button>
        <button type="button" onClick={() => navigate(`/order/${token}?unpaid=1`)} className="mt-2 h-12 w-full rounded-full font-bold text-ink-muted">
          Close without paying
        </button>
      </div>
    </div>
  );
}

/**
 * The Lucky Draw, as the customer sees it at checkout: how much of their spending counts, what
 * this order adds, and whether paying for it wins them their one entry.
 */
function LuckyDraw({ loyalty }: { loyalty: Extract<Loyalty, { running: true }> }) {
  if (loyalty.token) {
    return (
      <section className="flex flex-col gap-1 rounded-3xl bg-lagoon-tint p-4" aria-labelledby="draw-title">
        <h2 id="draw-title" className="font-bold text-lagoon-ink">
          🎟️ Your Lucky Draw token: <span className="font-mono">{loyalty.token}</span>
        </h2>
        <p className="text-sm text-lagoon-ink">
          You’re already in the draw. Keep ordering — your spending is still recorded — but one token is all anyone gets.
        </p>
      </section>
    );
  }
  if (loyalty.tokens_left === 0) {
    return (
      <section className="flex flex-col gap-1 rounded-3xl bg-lagoon-tint p-4">
        <p className="text-sm text-lagoon-ink">All the Lucky Draw tokens have been given out. Thanks for ordering with us!</p>
      </section>
    );
  }
  const pct = Math.min(100, Math.round((loyalty.after_paise / loyalty.threshold_paise) * 100));
  return (
    <section className="flex flex-col gap-2 rounded-3xl bg-lagoon-tint p-4" aria-labelledby="draw-title">
      <h2 id="draw-title" className="font-bold text-lagoon-ink">
        {loyalty.earns_token ? '🎉 This order wins your Lucky Draw token!' : 'Your Lucky Draw progress'}
      </h2>
      <div className="h-3 overflow-hidden rounded-full bg-white/60" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-lagoon transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-lagoon-ink">
        {formatINR(loyalty.after_paise)} of {formatINR(loyalty.threshold_paise)}
        {loyalty.adds_paise > 0 && ` (this order adds ${formatINR(loyalty.adds_paise)})`}
      </p>
      <p className="text-xs text-lagoon-ink">
        {loyalty.earns_token
          ? 'Pay and your token appears on the next screen.'
          : `${formatINR(loyalty.remaining_paise)} more to earn your Lucky Draw token. GST and delivery don’t count.`}
      </p>
    </section>
  );
}
