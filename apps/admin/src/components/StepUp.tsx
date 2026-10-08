import { Alert, Button, Dialog, TextField } from '@slush/ui';
import { type ReactNode, createContext, useCallback, useContext, useRef, useState } from 'react';
import { ApiError, messageOf } from '../lib/errors';
import { authClient } from '../lib/supabase';

/**
 * Step-up 2FA (Phase 8 S2). Wrap a sensitive action in `run(fn)`: if the database answers
 * "step_up_required", ask for a fresh authenticator code, then retry the action once.
 */
type Run = <T>(fn: () => Promise<T>) => Promise<T>;
const Ctx = createContext<Run | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const askForCode = () =>
    new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setCode('');
      setError(undefined);
      setOpen(true);
    });

  const run: Run = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.needsStepUp)) throw e;
      await askForCode();
      return fn();
    }
  }, []);

  const verify = async () => {
    if (!authClient) return;
    setBusy(true);
    setError(undefined);
    try {
      const { data: factors } = await authClient.auth.mfa.listFactors();
      const factor = factors?.totp.find((f) => f.status === 'verified');
      if (!factor) throw new Error('No authenticator is set up for this account.');
      const { error: verifyError } = await authClient.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
      if (verifyError) throw verifyError;
      setOpen(false);
      pending.current?.resolve();
    } catch (e) {
      setError(e instanceof Error && !(e instanceof ApiError) ? 'That code didn’t work. Check the app and try again.' : messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setOpen(false);
    pending.current?.reject(new ApiError('FORBIDDEN', 'Cancelled: this change needs your 2FA code.'));
  };

  return (
    <Ctx.Provider value={run}>
      {children}
      <Dialog open={open} title="Confirm it’s you" onClose={cancel}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <p className="text-sm text-ink-muted">This change is protected. Enter the 6-digit code from your authenticator app.</p>
          <TextField
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
          />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" block loading={busy} disabled={code.length !== 6}>
            Confirm
          </Button>
        </form>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useStepUp(): Run {
  const run = useContext(Ctx);
  if (!run) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return run;
}
