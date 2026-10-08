/** Browser storage that never throws (private mode, blocked storage, previews). */
type Area = 'local' | 'session';

const area = (a: Area): Storage | null => {
  try {
    return a === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
};

export function load<T>(key: string, fallback: T, a: Area = 'local'): T {
  try {
    const raw = area(a)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown, a: Area = 'local'): void {
  try {
    if (value === undefined || value === null) area(a)?.removeItem(key);
    else area(a)?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the app still works, it just won't remember */
  }
}

/** A random id for this phone (not personal data), used for rate limits and fraud signals. */
export function deviceId(): string {
  let id = load<string | null>('slush-device', null);
  if (!id) {
    id = crypto.randomUUID();
    save('slush-device', id);
  }
  return id;
}
