import { useEffect } from 'react';
import { env } from './lib/env';
import { matchPath, navigate, usePath } from './lib/router';
import { useOrderingContext } from './lib/ordering';
import { useMenu } from './lib/useMenu';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { MenuPage } from './pages/MenuPage';
import { FindPage, OrdersPage, PrivacyPage, QrEntryPage, Splash, StatePage } from './pages/MiscPages';
import { OrderPage } from './pages/OrderPage';
import { ReceiptPage } from './pages/ReceiptPage';

export function App() {
  const path = usePath();
  const ctx = useOrderingContext();

  const qr = matchPath('/t/:slug', path);
  if (qr) return <QrEntryPage slug={qr.slug!} />;
  const receipt = matchPath('/order/:token/receipt', path);
  if (receipt) return <ReceiptPage token={receipt.token!} />;
  const order = matchPath('/order/:token', path);
  if (order) return <OrderPage token={order.token!} />;
  if (path === '/find') return <FindPage />;
  if (path === '/orders') return <OrdersPage />;
  if (path === '/privacy') return <PrivacyPage />;
  return <MenuRoutes path={path} branchSlug={ctx.branchSlug} />;
}

function MenuRoutes({ path, branchSlug }: { path: string; branchSlug: string }) {
  const { menu, offline, error } = useMenu(branchSlug);

  useEffect(() => {
    if (!['/menu', '/cart', '/checkout'].includes(path)) navigate('/menu', { replace: true });
  }, [path]);

  if (!menu) {
    return error ? (
      <StatePage title="Can’t load the menu" body="Check your internet connection and try again.">
        <button type="button" onClick={() => window.location.reload()} className="h-12 rounded-full bg-brand px-6 font-bold text-white">
          Retry
        </button>
      </StatePage>
    ) : (
      <Splash />
    );
  }
  if (path === '/cart') return <CartPage menu={menu} />;
  if (path === '/checkout') return offline && !env.demo ? <StatePage title="You’re offline" body="Checkout needs an internet connection." /> : <CheckoutPage menu={menu} />;
  return <MenuPage menu={menu} offline={offline} />;
}
