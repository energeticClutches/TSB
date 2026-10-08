/**
 * Staff-screen sounds (Phase 6 A3): a two-tone chime for a new order and a low buzz for a
 * payment problem. Generated with Web Audio, so there are no sound files to load.
 */
let ctx: AudioContext | undefined;

function audio(): AudioContext | undefined {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return undefined;
  }
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = 'sine', volume = 0.25) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = a.currentTime + start;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

export function chime() {
  tone(880, 0, 0.35);
  tone(1320, 0.22, 0.5);
}

export function buzz() {
  tone(110, 0, 0.5, 'sawtooth', 0.12);
}

/** Browsers only allow sound after a tap; call this from any click to unlock it early. */
export function unlockAudio() {
  audio();
}
