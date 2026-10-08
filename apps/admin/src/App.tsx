import { Alert, Spinner } from '@slush/ui';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { NAV, Shell } from './components/Shell';
import { StepUpProvider } from './components/StepUp';
import { env } from './lib/env';
import { type StaffRole, SessionProvider, useSession } from './lib/session';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { AuditPage } from './pages/AuditPage';
import { DevicePage } from './pages/DevicePage';
import { DevicesPage } from './pages/DevicesPage';
import { BoardPage } from './pages/BoardPage';
import { CustomersPage } from './pages/CustomersPage';
import { HoursPage } from './pages/HoursPage';
import { KitchenPage } from './pages/KitchenPage';
import { AuthLayout, LoginPage } from './pages/LoginPage';
import { MenuPage } from './pages/MenuPage';
import { MfaPage } from './pages/MfaPage';
import { OffersPage } from './pages/OffersPage';
import { OrdersPage } from './pages/OrdersPage';
import { OverviewPage } from './pages/OverviewPage';
import { QrPage } from './pages/QrPage';
import { ReportsPage } from './pages/ReportsPage';
import { RiskPage } from './pages/RiskPage';
import { RefundsPage } from './pages/RefundsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SoldOutPage } from './pages/SoldOutPage';
import { StaffPage } from './pages/StaffPage';
import { LuckyDrawPage } from './pages/LuckyDrawPage';

export function App() {
  if (!env.configured && !__DEMO__) return <NotConfigured />;
  return (
    <SessionProvider>
      <StepUpProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/device" element={__DEMO__ ? <Navigate to="/login" replace /> : <PublicOnly><DevicePage /></PublicOnly>} />
            <Route path="/kitchen" element={<RequireSession><Allow page="/kitchen"><KitchenPage /></Allow></RequireSession>} />
            <Route element={<RequireSession><Shell /></RequireSession>}>
              <Route index element={<Allow page="/"><OverviewPage /></Allow>} />
              <Route path="board" element={<Allow page="/board"><BoardPage /></Allow>} />
              <Route path="orders" element={<Allow page="/orders"><OrdersPage /></Allow>} />
              <Route path="refunds" element={<Allow page="/refunds"><RefundsPage /></Allow>} />
              <Route path="qr" element={<Allow page="/qr"><QrPage /></Allow>} />
              <Route path="lucky-draw" element={<Allow page="/lucky-draw"><LuckyDrawPage /></Allow>} />
              <Route path="customers" element={<Allow page="/customers"><CustomersPage /></Allow>} />
              <Route path="customers/:id" element={<Allow page="/customers"><CustomersPage /></Allow>} />
              <Route path="offers" element={<Allow page="/offers"><OffersPage /></Allow>} />
              <Route path="reports" element={<Allow page="/reports"><ReportsPage /></Allow>} />
              <Route path="risk" element={<Allow page="/risk"><RiskPage /></Allow>} />
              <Route path="menu" element={<Allow page="/menu"><MenuPage /></Allow>} />
              <Route path="sold-out" element={<Allow page="/sold-out"><SoldOutPage /></Allow>} />
              <Route path="approvals" element={<Allow page="/approvals"><ApprovalsPage /></Allow>} />
              <Route path="hours" element={<Allow page="/hours"><HoursPage /></Allow>} />
              <Route path="staff" element={<Allow page="/staff"><StaffPage /></Allow>} />
              <Route path="devices" element={<Allow page="/devices"><DevicesPage /></Allow>} />
              <Route path="settings" element={<Allow page="/settings"><SettingsPage /></Allow>} />
              <Route path="audit" element={<Allow page="/audit"><AuditPage /></Allow>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </StepUpProvider>
    </SessionProvider>
  );
}

function Loading() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Spinner className="size-10 text-brand" />
    </div>
  );
}

const HOME: Record<StaffRole, string> = { owner: '/', manager: '/', cashier: '/board', kitchen: '/kitchen' };

function RequireSession({ children }: { children: ReactNode }) {
  const { state } = useSession();
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'signed_out') return <Navigate to="/login" replace />;
  if (state.status === 'needs') {
    if (state.need === 'mfa_challenge') return <MfaPage mode="challenge" />;
    if (state.need === 'mfa_enroll') return <MfaPage mode="enroll" />;
    return <NotStaff email={state.email} />;
  }
  return children;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { state } = useSession();
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'ready') return <Navigate to={HOME[state.role]} replace />;
  if (state.status === 'needs') return <Navigate to="/" replace />;
  return children;
}

/** Hide pages a role can't use. The database enforces the same rules regardless. */
function Allow({ page, children }: { page: string; children: ReactNode }) {
  const { state } = useSession();
  if (state.status !== 'ready') return null;
  const allowed = NAV.find((n) => n.to === page)?.roles.includes(state.role);
  return allowed ? children : <Navigate to={HOME[state.role]} replace />;
}

function NotStaff({ email }: { email: string }) {
  const { signOut } = useSession();
  return (
    <AuthLayout title="No staff access">
      <p className="text-sm text-ink-muted">
        <b>{email}</b> isn’t set up as staff at The Slush Bar. Ask the owner to invite you.
      </p>
      <button type="button" className="mt-6 font-bold text-brand-ink underline" onClick={() => void signOut()}>
        Sign out
      </button>
    </AuthLayout>
  );
}

function NotConfigured() {
  return (
    <AuthLayout title="Almost there">
      <Alert tone="warning" title="Not connected to the database yet">
        Copy <code>apps/admin/.env.example</code> to <code>.env.local</code> and add the Supabase project URL and publishable key.
      </Alert>
    </AuthLayout>
  );
}
