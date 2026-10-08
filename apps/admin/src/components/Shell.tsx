import { Badge, Button, Logo, cn } from '@slush/ui';
import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { env } from '../lib/env';
import { type StaffRole, useSession, useStaff } from '../lib/session';
import { DemoBar } from './DemoBar';

interface NavItem {
  to: string;
  label: string;
  roles: StaffRole[];
}

// Grows milestone by milestone (Phase 6 §3 navigation table).
export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', roles: ['owner', 'manager'] },
  { to: '/board', label: 'Live orders', roles: ['owner', 'manager', 'cashier'] },
  { to: '/orders', label: 'Orders', roles: ['owner', 'manager', 'cashier'] },
  { to: '/refunds', label: 'Refunds', roles: ['owner', 'manager'] },
  { to: '/lucky-draw', label: 'Lucky Draw', roles: ['owner', 'manager', 'cashier'] },
  { to: '/customers', label: 'Customers', roles: ['owner', 'manager', 'cashier'] },
  { to: '/kitchen', label: 'Kitchen screen', roles: ['owner', 'manager', 'kitchen'] },
  { to: '/menu', label: 'Menu', roles: ['owner', 'manager'] },
  { to: '/sold-out', label: 'Sold out', roles: ['owner', 'manager', 'cashier'] },
  { to: '/offers', label: 'Offers', roles: ['owner', 'manager'] },
  { to: '/reports', label: 'Reports', roles: ['owner', 'manager'] },
  { to: '/risk', label: 'Risk & checks', roles: ['owner', 'manager'] },
  { to: '/approvals', label: 'Approvals', roles: ['owner'] },
  { to: '/qr', label: 'QR codes', roles: ['owner', 'manager'] },
  { to: '/hours', label: 'Hours & closures', roles: ['owner', 'manager'] },
  { to: '/staff', label: 'Staff', roles: ['owner'] },
  { to: '/devices', label: 'Devices', roles: ['owner'] },
  { to: '/settings', label: 'Settings', roles: ['owner'] },
  { to: '/audit', label: 'Audit log', roles: ['owner'] },
];

const IDLE_LOCK_MS = 5 * 60_000; // Phase 8 S3

export function Shell() {
  const staff = useStaff();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const items = NAV.filter((n) => n.roles.includes(staff.role));

  // Shop devices lock after 5 minutes without a touch, and when the session expires.
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (staff.kind !== 'pin') return;
    const lock = () => void signOut().then(() => navigate('/device', { replace: true }));
    const arm = () => {
      window.clearTimeout(timer.current);
      const untilExpiry = new Date(staff.expiresAt).getTime() - Date.now();
      timer.current = window.setTimeout(lock, Math.max(0, Math.min(IDLE_LOCK_MS, untilExpiry)));
    };
    const events = ['pointerdown', 'keydown', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => {
      window.clearTimeout(timer.current);
      events.forEach((e) => window.removeEventListener(e, arm));
    };
  }, [staff, signOut, navigate]);

  const leave = () => void signOut().then(() => navigate(staff.kind === 'pin' ? '/device' : '/login', { replace: true }));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-b border-line bg-card lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-b-0">
        <div className="flex items-center gap-3 px-5 py-4">
          <Logo size={40} />
          <div className="leading-tight">
            <p className="font-display font-black text-brand-ink">SLUSH ADMIN</p>
            <p className="text-xs text-ink-muted">Sector-6, Bahadurgarh</p>
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'shrink-0 rounded-full px-4 py-2.5 text-sm font-bold transition',
                  isActive ? 'bg-brand text-white shadow-glow' : 'text-ink-muted hover:bg-brand-tint hover:text-ink',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col">
        {__DEMO__ && <DemoBar />}
        <header className="flex items-center justify-end gap-3 border-b border-line bg-card/80 px-5 py-3 backdrop-blur">
          <span className="text-sm">
            Signed in: <b>{staff.name}</b>
          </span>
          <Badge tone="brand" className="capitalize">
            {staff.role}
          </Badge>
          <Button size="sm" variant="secondary" onClick={leave}>
            {staff.kind === 'pin' ? 'Switch' : 'Sign out'}
          </Button>
        </header>
        <main className={cn('mx-auto w-full flex-1 px-5', pathname === '/board' ? 'max-w-none py-5' : 'max-w-5xl py-8')}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl font-black tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-ink-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
