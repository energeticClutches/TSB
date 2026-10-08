import { useState } from 'react';
import { useSession } from '../lib/session';

/** Demo-mode toolbar: pretend a customer ordered, or start the practice shop again. */
export function DemoBar() {
  const { signOut } = useSession();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setNote(undefined);
    try {
      await fn();
      setNote(done);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That didn’t work.');
    } finally {
      setBusy(undefined);
    }
  };
  const order = () =>
    run('order', async () => (await (await import('../demo/backend')).backend()).simulateCustomerOrder({}), 'A customer just paid: see Live orders.');
  const regular = () =>
    run('regular', async () => (await (await import('../demo/backend')).backend()).simulateRegular(), 'A regular customer earned a Lucky Draw number: see Lucky Draw.');
  const reset = () =>
    run(
      'reset',
      async () => {
        if (!window.confirm('Start the practice shop again? All demo orders and changes are wiped.')) return;
        await (await import('../demo/backend')).resetDemo();
        await signOut();
        window.location.assign('/login');
      },
      '',
    );

  const btn = 'rounded-full bg-white/20 px-3 py-1 font-bold hover:bg-white/30 disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-2 bg-lagoon-ink px-5 py-2 text-sm text-white" role="region" aria-label="Demo controls">
      <b>DEMO</b>
      <span className="text-white/80">Practice copy running in this browser.</span>
      <button type="button" className={btn} disabled={Boolean(busy)} onClick={() => void order()}>
        {busy === 'order' ? 'Ordering…' : '+ Customer order'}
      </button>
      <button type="button" className={btn} disabled={Boolean(busy)} onClick={() => void regular()}>
        {busy === 'regular' ? 'Ordering…' : '+ Regular customer (earns a Lucky Draw number)'}
      </button>
      <button type="button" className={btn} disabled={Boolean(busy)} onClick={() => void reset()}>
        Reset demo
      </button>
      {note && <span className="text-white/90" role="status">{note}</span>}
    </div>
  );
}
