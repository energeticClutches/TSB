import { normalizeMobile } from '@slush/core';
import { Logo } from '@slush/ui';
import { useEffect, useState } from 'react';
import { Header } from '../components/Chrome';
import { ApiError, type PublicOrder, getApi } from '../lib/api';
import { recentOrders, rememberOrder, setOrderingContext } from '../lib/ordering';
import { Link, navigate } from '../lib/router';
import { getTurnstileToken } from '../lib/scripts';

/** A scanned QR code: remember the table/counter, then open the menu (Phase 2 §1.1). */
export function QrEntryPage({ slug }: { slug: string }) {
  const [error, setError] = useState<ApiError>();
  useEffect(() => {
    void getApi()
      .then((api) => api.qr(slug))
      .then(
        (q) => {
          setOrderingContext({ branchSlug: q.branch_slug, qrSlug: slug, kind: q.kind, tableLabel: q.table_label });
          navigate('/menu', { replace: true });
        },
        (e: unknown) => setError(e instanceof ApiError ? e : new ApiError('NETWORK', 'No connection. Check your internet and try again.')),
      );
  }, [slug]);

  if (!error) return <Splash />;
  return (
    <StatePage
      title={error.code === 'QR_DISABLED' ? 'This table’s code isn’t active' : error.code === 'NOT_FOUND' ? 'We don’t recognise this QR code' : 'Can’t open the menu'}
      body={error.code === 'QR_DISABLED' || error.code === 'NOT_FOUND' ? 'Please order at the counter. Sorry about that!' : error.message}
    >
      <Link to="/menu" className="font-bold text-brand-ink underline">
        Browse the menu anyway
      </Link>
    </StatePage>
  );
}

export function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-gradient-to-b from-brand-tint to-surface" role="status" aria-label="Loading">
      <div className="flex flex-col items-center gap-3">
        <Logo size={96} className="animate-pulse" />
        <p className="font-display font-black text-brand-ink">Cool down. Sip. Smile. Repeat.</p>
      </div>
    </div>
  );
}

export function StatePage({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-gradient-to-b from-brand-tint to-surface px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <Logo size={80} />
        <h1 className="font-display text-2xl font-black">{title}</h1>
        <p className="text-ink-muted">{body}</p>
        {children}
      </div>
    </div>
  );
}

/** Orders placed from this phone in the last 12 hours. */
export function OrdersPage() {
  const [orders, setOrders] = useState<{ token: string; order: PublicOrder | null }[]>();
  useEffect(() => {
    void getApi().then(async (api) =>
      setOrders(await Promise.all(recentOrders().map(async (r) => ({ token: r.token, order: await api.order(r.token).catch(() => null) })))),
    );
  }, []);
  return (
    <div className="min-h-dvh">
      <Header back="/menu" title="Your orders" />
      <main className="mx-auto flex max-w-lg flex-col gap-3 px-4 pt-4">
        {orders?.filter((o) => o.order?.order_number).map(({ token, order }) => (
          <Link key={token} to={`/order/${token}`} className="flex items-center justify-between rounded-3xl bg-card p-4 shadow-card">
            <span>
              <b className="font-display text-lg">{order!.order_number}</b>
              <span className="block text-sm text-ink-muted capitalize">{order!.status.replace(/_/g, ' ')}</span>
            </span>
            <span className="font-display text-2xl font-black text-brand-ink">#{order!.pickup_number}</span>
          </Link>
        ))}
        {orders && !orders.some((o) => o.order?.order_number) && <p className="py-6 text-center text-ink-muted">No recent orders on this phone.</p>}
        <Link to="/find" className="mt-2 text-center font-bold text-brand-ink underline">
          Find an order with your mobile number
        </Link>
      </main>
    </div>
  );
}

/** Lost the confirmation? Mobile + order number opens the tracker (FR-25). */
export function FindPage() {
  const [mobile, setMobile] = useState('');
  const [number, setNumber] = useState('SL-');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const find = async () => {
    if (!normalizeMobile(mobile)) return setError('Enter the 10-digit mobile number you ordered with.');
    setBusy(true);
    setError(undefined);
    try {
      const api = await getApi();
      const token = await getTurnstileToken();
      const r = await api.find(mobile, number.trim(), token);
      rememberOrder(r.public_token);
      navigate(`/order/${r.public_token}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Couldn’t check right now. Please ask at the counter.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh">
      <Header back="/menu" title="Find my order" />
      <form
        className="mx-auto flex max-w-lg flex-col gap-4 px-4 pt-6"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Mobile number</span>
          <input value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="numeric" autoComplete="tel-national" className="h-12 rounded-2xl border border-line bg-card px-4 text-base" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Order number (on your receipt, e.g. SL-1025)</span>
          <input value={number} onChange={(e) => setNumber(e.target.value.toUpperCase())} className="h-12 rounded-2xl border border-line bg-card px-4 text-base" />
        </label>
        {error && (
          <p role="alert" className="rounded-2xl bg-danger-tint px-4 py-3 text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="h-14 rounded-full bg-brand font-display text-lg font-black text-white shadow-glow disabled:opacity-50">
          {busy ? 'Looking…' : 'Find my order'}
        </button>
      </form>
    </div>
  );
}

/** Short privacy notice (Phase 8 §3.5, DPDP Act 2023). Contact details are filled in once provided. */
export function PrivacyPage() {
  return (
    <div className="min-h-dvh">
      <Header back="/menu" title="Privacy" />
      <main className="mx-auto flex max-w-lg flex-col gap-3 px-4 pt-6 pb-10 text-sm leading-relaxed">
        <h1 className="font-display text-2xl font-black">How we use your details</h1>
        <p>
          <b>What we collect:</b> your name and mobile number to prepare your order and keep track of your reward tokens; your address and
          location only for delivery orders. Payments are handled by Razorpay: we never see your bank or card details. To prevent fraud we keep a
          scrambled (hashed) form of the UPI ID that paid, and show only a masked version to our staff.
        </p>
        <p>
          <b>What we don’t do:</b> no marketing messages without asking you first, no selling or sharing your details, no tracking across other sites.
        </p>
        <p>
          <b>How long:</b> customer details are anonymised after 3 years without an order. Order and payment records are kept as long as Indian
          tax law requires.
        </p>
        <p>
          <b>Your rights:</b> you can ask us what we hold about you, correct it, or ask us to delete it (unused reward tokens are then lost). Ask
          at the counter at Shop No. 140, Sector-6 Market, Bahadurgarh.
        </p>
      </main>
    </div>
  );
}
