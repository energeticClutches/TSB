import { formatINR } from '@slush/core';
import { Alert, Badge, Button, Card, EmptyState, Spinner, TextField } from '@slush/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { Meter, StatTile } from '../components/Charts';
import { ReasonDialog } from '../components/OrderDrawer';
import { PageHeader } from '../components/Shell';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { formatDateTime } from '../lib/orders';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface Overview {
  campaign: { id: string; name: string; threshold_paise: number; starts_on: string | null; ends_on: string | null } | null;
  token_limit: number;
  tokens_issued: number;
  tokens_left: number;
  tokens_void: number;
  customers_with_tokens: number;
  customers_close: number;
  loyalty_customers: number;
  loyalty_spend_paise: number;
  last_issued_at: string | null;
}

interface TokenRow {
  id: string;
  code: string;
  serial: number;
  status: 'issued' | 'void';
  customer_id: string;
  customer_name: string | null;
  mobile_masked: string;
  issued_at: string;
  spend_at_issue_paise: number;
  spend_paise: number;
  frozen: boolean;
  order_number: string | null;
  void_reason: string | null;
}

interface Close {
  customer_id: string;
  customer_name: string | null;
  mobile_masked: string;
  spend_paise: number;
  threshold_paise: number;
  remaining_paise: number;
  order_count: number;
  last_order_at: string | null;
  frozen: boolean;
}

interface Verified {
  valid: boolean;
  status?: string;
  code?: string;
  issued_at?: string;
  void_reason?: string | null;
  customer?: { id: string; name: string | null; mobile_masked: string };
}

/**
 * A11: the Lucky Draw. Numbers are issued by the system the moment a mobile's total spending
 * crosses the line — there is nothing to approve here, only to watch, look up and (rarely) void.
 */
export function LuckyDrawPage() {
  const staff = useStaff();
  const overview = useAsync(() => rpc<Overview>(staff.db, 'lucky_draw_overview'), [staff.db]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const tokens = useAsync(() => rpc<TokenRow[]>(staff.db, 'lucky_draw_tokens_list', { p_q: search || null, p_limit: 500 }), [staff.db, search]);
  const close = useAsync(() => rpc<Close[]>(staff.db, 'loyalty_leaderboard', { p_limit: 20 }), [staff.db]);
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState<Verified>();
  const [verifyError, setVerifyError] = useState<string>();
  const [voiding, setVoiding] = useState<TokenRow | null>(null);
  const [message, setMessage] = useState<string>();
  const isManager = staff.role === 'owner' || staff.role === 'manager';

  const verify = async () => {
    setVerifyError(undefined);
    setVerified(undefined);
    try {
      setVerified(await rpc<Verified>(staff.db, 'verify_token', { p_code: code.trim() }));
    } catch (e) {
      setVerifyError(messageOf(e));
    }
  };

  const o = overview.data;
  const list = tokens.data ?? [];
  return (
    <>
      <PageHeader
        title="Lucky Draw"
        description="Every ₹ a customer spends adds up against their mobile number. Cross the line and they get one number — automatically, once, for ever."
      />
      {message && <div className="mb-4"><Alert tone="success">{message}</Alert></div>}
      {overview.loading && !o && <Spinner className="size-8 text-brand" />}
      {overview.error ? <Alert>{messageOf(overview.error)}</Alert> : null}

      {o && !o.campaign && <EmptyState title="No Lucky Draw is running">Ask your developer to start a campaign.</EmptyState>}
      {o?.campaign && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Numbers given out" value={String(o.tokens_issued)} sub={`of ${o.token_limit}`} />
            <StatTile label="Still to give" value={String(o.tokens_left)} />
            <StatTile label="Customers building up" value={String(o.loyalty_customers)} sub={`${formatINR(o.loyalty_spend_paise)} counted so far`} />
            <StatTile label="Nearly there" value={String(o.customers_close)} sub={`${formatINR(o.campaign.threshold_paise)} earns a number`} />
          </div>
          <Card className="mt-3">
            <Meter label={`${o.campaign.name}: ${o.tokens_issued} of ${o.token_limit} numbers given out`} value={o.tokens_issued} max={o.token_limit} />
            <p className="mt-2 text-sm text-ink-muted">
              {o.tokens_left === 0
                ? 'All the numbers have gone. Customers keep building up their spending, but no more numbers can be given out.'
                : `Last one given ${o.last_issued_at ? formatDateTime(o.last_issued_at) : 'not yet'}.`}
              {o.tokens_void > 0 && ` ${o.tokens_void} number${o.tokens_void === 1 ? ' has' : 's have'} been cancelled and won’t be reused.`}
            </p>
          </Card>
        </>
      )}

      <h2 className="mt-8 mb-3 font-display text-lg font-extrabold">Numbers in the draw</h2>
      <Card className="mb-3">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
          }}
        >
          <div className="min-w-64 flex-1">
            <TextField label="Find by number, name or mobile" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SLB-184, Meera, or 98765 43210" />
          </div>
          <Button type="submit">Search</Button>
          {search && (
            <Button
              variant="ghost"
              onClick={() => {
                setQuery('');
                setSearch('');
              }}
            >
              Show all
            </Button>
          )}
        </form>
      </Card>
      {tokens.loading && !tokens.data && <Spinner className="size-8 text-brand" />}
      {tokens.error ? <Alert>{messageOf(tokens.error)}</Alert> : null}
      {tokens.data && list.length === 0 && (
        <EmptyState title={search ? 'Nothing matches that' : 'No numbers given out yet'}>
          {search ? 'Try the number on the customer’s phone, or their mobile.' : 'The first number goes out as soon as a customer’s spending crosses the line.'}
        </EmptyState>
      )}
      <div className="flex flex-col gap-2">
        {list.map((t) => (
          <Card key={t.id} className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-bold">
                <span className="font-mono text-lg">{t.code}</span>
                {t.status === 'void' && <Badge tone="danger" className="ml-2">Cancelled</Badge>}
                {t.frozen && <Badge tone="danger" className="ml-2">Frozen</Badge>}
              </p>
              <p className="text-sm text-ink-muted">
                {t.customer_name ?? 'Customer'} <span className="font-mono">{t.mobile_masked}</span> · earned {formatDateTime(t.issued_at)} at {formatINR(t.spend_at_issue_paise)}
                {t.order_number && ` · after ${t.order_number}`} · spent {formatINR(t.spend_paise)} in total
              </p>
              {t.void_reason && <p className="mt-1 text-sm text-danger-ink">Cancelled: {t.void_reason}</p>}
            </div>
            <div className="flex gap-2">
              <Link to={`/customers/${t.customer_id}`} className="inline-flex h-11 items-center px-3 text-sm font-bold text-brand-ink underline">
                Profile
              </Link>
              {isManager && t.status === 'issued' && (
                <Button variant="ghost" onClick={() => setVoiding(t)}>
                  Cancel…
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      <h2 className="mt-8 mb-3 font-display text-lg font-extrabold">Closest to a number</h2>
      {close.data && close.data.length === 0 && <EmptyState title="Nobody yet">Spending starts counting from the first completed order.</EmptyState>}
      <div className="flex flex-col gap-2">
        {(close.data ?? []).map((c) => (
          <Card key={c.customer_id} className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-64 flex-1">
              <p className="font-bold">
                {c.customer_name ?? 'Customer'} <span className="font-mono text-sm text-ink-muted">{c.mobile_masked}</span>
                {c.frozen && <Badge tone="danger" className="ml-2">Frozen</Badge>}
              </p>
              <Meter label={`${formatINR(c.spend_paise)} of ${formatINR(c.threshold_paise)}`} value={c.spend_paise} max={c.threshold_paise} />
              <p className="mt-1 text-sm text-ink-muted">
                {formatINR(c.remaining_paise)} more · {c.order_count} orders · last {c.last_order_at ? formatDateTime(c.last_order_at) : '—'}
              </p>
            </div>
            <Link to={`/customers/${c.customer_id}`} className="inline-flex h-11 items-center px-3 text-sm font-bold text-brand-ink underline">
              Profile
            </Link>
          </Card>
        ))}
      </div>

      <h2 className="mt-8 mb-3 font-display text-lg font-extrabold">Check a number</h2>
      <Card>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <div className="min-w-64 flex-1">
            <TextField label="Number on the customer's phone" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="SLB-184" maxLength={12} className="font-mono" />
          </div>
          <Button type="submit" disabled={code.trim().length < 5}>
            Check
          </Button>
        </form>
        {verifyError && <div className="mt-3"><Alert>{verifyError}</Alert></div>}
        {verified && (
          <div className="mt-4">
            {!verified.valid && !verified.status ? (
              <Alert>No Lucky Draw number like that. Check the digits.</Alert>
            ) : (
              <Alert tone={verified.valid ? 'success' : 'warning'} title={verified.valid ? `${verified.code} is in the draw` : `${verified.code} was cancelled`}>
                {verified.customer?.name ?? 'A customer'} ({verified.customer?.mobile_masked}) · earned {formatDateTime(verified.issued_at)}.
                {verified.void_reason && ` Cancelled: ${verified.void_reason}`}
              </Alert>
            )}
          </div>
        )}
      </Card>

      <ReasonDialog
        open={Boolean(voiding)}
        title={`Cancel ${voiding?.code ?? 'this number'}?`}
        intro="It comes out of the draw and the number is never given to anyone else. The customer can't earn a replacement."
        label="Why?"
        placeholder="e.g. Every order was refunded straight after"
        action="Cancel the number"
        danger
        onClose={() => setVoiding(null)}
        onSubmit={async (reason) => {
          await rpc(staff.db, 'void_lucky_draw_token', { p_token_id: voiding!.id, p_reason: reason });
          setMessage(`${voiding!.code} is out of the draw.`);
          setVoiding(null);
          tokens.reload();
          overview.reload();
        }}
      />
    </>
  );
}
