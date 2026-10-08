import { Alert, Button, Spinner, TextField } from '@slush/ui';
import { useEffect, useState } from 'react';
import { useSession } from '../lib/session';
import { authClient } from '../lib/supabase';
import { AuthLayout } from './LoginPage';

/** Enter a 2FA code, or set up an authenticator app (required for Owners). */
export function MfaPage({ mode }: { mode: 'challenge' | 'enroll' }) {
  const { refresh, signOut } = useSession();
  const [factorId, setFactorId] = useState<string>();
  const [qr, setQr] = useState<string>();
  const [secret, setSecret] = useState<string>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authClient) return;
    void (async () => {
      const { data } = await authClient.auth.mfa.listFactors();
      if (mode === 'challenge') {
        setFactorId(data?.totp.find((f) => f.status === 'verified')?.id);
        return;
      }
      // Remove half-finished enrolments so the owner always gets a fresh QR code.
      for (const f of data?.all ?? []) if (f.status === 'unverified') await authClient.auth.mfa.unenroll({ factorId: f.id });
      const { data: enrolled, error: e } = await authClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Slush Admin ${new Date().toISOString().slice(0, 10)}` });
      if (e || !enrolled) return setError('Couldn’t start 2FA setup. Refresh the page to try again.');
      setFactorId(enrolled.id);
      setQr(enrolled.totp.qr_code);
      setSecret(enrolled.totp.secret);
    })();
  }, [mode]);

  const verify = async () => {
    if (!authClient || !factorId) return;
    setBusy(true);
    setError(undefined);
    const { error: e } = await authClient.auth.mfa.challengeAndVerify({ factorId, code });
    setBusy(false);
    if (e) return setError('That code didn’t work. Codes change every 30 seconds. Try the current one.');
    await refresh();
  };

  return (
    <AuthLayout title={mode === 'enroll' ? 'Protect your account' : 'Two-step verification'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
      >
        {mode === 'enroll' ? (
          <>
            <p className="text-sm text-ink-muted">
              Owner accounts need an authenticator app (Google Authenticator, Microsoft Authenticator or similar). Scan this code,
              then type the 6-digit number it shows.
            </p>
            <div className="grid place-items-center rounded-2xl bg-surface p-4">
              {qr ? <img src={qr} alt="QR code to add The Slush Bar to your authenticator app" className="size-48" /> : <Spinner className="size-8 text-brand" />}
            </div>
            {secret && (
              <p className="text-center text-xs text-ink-muted">
                Can’t scan? Enter this key: <code className="font-bold break-all text-ink">{secret}</code>
              </p>
            )}
            <Alert tone="warning" title="Tip">
              Add the same code to a second phone (a family member’s or a spare) so you’re never locked out.
            </Alert>
          </>
        ) : (
          <p className="text-sm text-ink-muted">Open your authenticator app and enter the 6-digit code for The Slush Bar.</p>
        )}
        <TextField
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" size="lg" block loading={busy} disabled={code.length !== 6 || !factorId}>
          {mode === 'enroll' ? 'Turn on 2FA' : 'Verify'}
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          Use a different account
        </Button>
      </form>
    </AuthLayout>
  );
}
