import { clsx } from 'clsx';
import { useCallback, useEffect, useState } from 'react';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

/**
 * Big 4-digit PIN pad for shared shop devices (Phase 6 A1b). Submits automatically on
 * the 4th digit. Works with the on-screen keys and a hardware keyboard.
 */
export function PinPad({
  onComplete,
  disabled = false,
  error,
  resetKey,
}: {
  onComplete: (pin: string) => void;
  disabled?: boolean;
  error?: string | undefined;
  /** Change this value to clear the entered digits (e.g. after a wrong PIN). */
  resetKey?: unknown;
}) {
  const [pin, setPin] = useState('');

  useEffect(() => setPin(''), [resetKey]);

  const press = useCallback(
    (key: string) => {
      if (disabled) return;
      if (key === 'clear') return setPin('');
      if (key === 'back') return setPin(pin.slice(0, -1));
      if (pin.length >= 4) return;
      const next = pin + key;
      setPin(next);
      if (next.length === 4) onComplete(next);
    },
    [disabled, onComplete, pin],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Escape') press('clear');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex gap-4" aria-live="polite" aria-label={`${pin.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={clsx(
              'size-5 rounded-full border-2 transition',
              error ? 'border-danger' : 'border-brand',
              i < pin.length && (error ? 'bg-danger' : 'bg-brand'),
            )}
          />
        ))}
      </div>
      <p className={clsx('min-h-5 text-sm font-semibold', error ? 'text-danger' : 'text-transparent')} role="alert">
        {error ?? '.'}
      </p>
      <div className="grid grid-cols-3 gap-4">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => press(key)}
            aria-label={key === 'back' ? 'Delete last digit' : key === 'clear' ? 'Clear' : key}
            className={clsx(
              'grid size-20 place-items-center rounded-full font-display text-3xl font-bold transition active:scale-95',
              'disabled:opacity-40',
              key === 'clear' || key === 'back' ? 'text-base text-ink-muted' : 'bg-card text-ink shadow-card',
            )}
          >
            {key === 'back' ? '⌫' : key === 'clear' ? 'Clear' : key}
          </button>
        ))}
      </div>
    </div>
  );
}
