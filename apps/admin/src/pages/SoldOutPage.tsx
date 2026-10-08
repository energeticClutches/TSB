import { Alert, Card, Spinner, Switch, TextField } from '@slush/ui';
import { useState } from 'react';
import { PageHeader } from '../components/Shell';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { loadAdminMenu } from '../lib/menuAdmin';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

/** Quick "86" list for the counter: the only menu control Cashiers get (Phase 2 decision 9). */
export function SoldOutPage() {
  const staff = useStaff();
  const menu = useAsync(() => loadAdminMenu(staff.db), [staff.db]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();

  const toggle = async (fn: string, id: string, soldOut: boolean) => {
    setError(undefined);
    try {
      await rpc(staff.db, fn, { p_id: id, p_sold_out: soldOut });
      menu.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  if (menu.loading && !menu.data) return <Spinner className="size-8 text-brand" />;
  if (menu.error) return <Alert>{messageOf(menu.error)}</Alert>;
  const q = query.trim().toLowerCase();
  const products = menu.data!.products.filter((p) => p.is_active && p.name.toLowerCase().includes(q));
  const options = menu.data!.groups.flatMap((g) => g.options.map((o) => ({ ...o, group: g.name }))).filter((o) => o.name.toLowerCase().includes(q));

  return (
    <>
      <PageHeader title="Sold out" description="Ran out of something? Switch it off here. Customers see it as sold out within a minute." />
      <div className="mb-4 max-w-sm">
        <TextField label="Search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. jamun, boba" />
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-display text-lg font-extrabold">Items</h2>
          <ul className="flex flex-col gap-3">
            {products.map((p) => (
              <li key={p.id}>
                <Switch checked={p.is_sold_out} onChange={(v) => void toggle('set_product_sold_out', p.id, v)} label={p.name} description={p.is_sold_out ? 'Sold out' : 'Available'} />
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="mb-3 font-display text-lg font-extrabold">Add-ons & choices</h2>
          <ul className="flex flex-col gap-3">
            {options.map((o) => (
              <li key={o.id}>
                <Switch checked={Boolean(o.is_sold_out)} onChange={(v) => void toggle('set_option_sold_out', o.id!, v)} label={o.name} description={o.group} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
