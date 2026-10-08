import { describe, expect, it } from 'vitest';
import { PIN_PROBLEM_MESSAGE, checkPin } from './pin.ts';

describe('checkPin', () => {
  it.each([
    ['482', 'format'],
    ['48219', 'format'],
    ['48a1', 'format'],
    ['0000', 'repeated'],
    ['7777', 'repeated'],
    ['1234', 'sequence'],
    ['6789', 'sequence'],
    ['8901', 'sequence'], // wraps around
    ['4321', 'sequence'],
    ['1098', 'sequence'], // descending wrap
    ['1987', 'year'],
    ['2026', 'year'],
    ['2580', 'common'],
    ['1212', 'common'],
  ])('rejects %s as %s', (pin, problem) => {
    expect(checkPin(pin)).toBe(problem);
  });

  it.each(['4821', '9315', '0472', '1949', '2036'])('accepts %s', (pin) => {
    expect(checkPin(pin)).toBeNull();
  });

  it('has a message for every problem', () => {
    for (const message of Object.values(PIN_PROBLEM_MESSAGE)) expect(message.length).toBeGreaterThan(0);
  });
});
