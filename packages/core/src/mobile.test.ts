import { describe, expect, it } from 'vitest';
import { maskMobile, normalizeMobile } from './mobile.ts';

describe('normalizeMobile', () => {
  it.each([
    ['9812345678', '+919812345678'],
    ['98123 45678', '+919812345678'],
    ['+91-9812345678', '+919812345678'],
    ['919812345678', '+919812345678'],
    ['09812345678', '+919812345678'],
    ['(981) 234-5678', '+919812345678'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeMobile(input)).toBe(expected);
  });

  it.each(['12345', '5812345678', '98123456789', 'abcdefghij', '', '+1 9812345678'])('rejects %s', (input) => {
    expect(normalizeMobile(input)).toBeNull();
  });
});

describe('maskMobile', () => {
  it('masks the middle five digits', () => {
    expect(maskMobile('+919812345678')).toBe('98xxxxx678');
    expect(maskMobile('9812345678')).toBe('98xxxxx678');
  });

  it('never leaks a malformed value', () => {
    expect(maskMobile('+91123')).toBe('xxxxxxxxxx');
  });
});
