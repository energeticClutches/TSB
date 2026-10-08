import { describe, expect, it } from 'vitest';
import { AppError, ERROR_STATUS, isErrorCode } from './errors.ts';

describe('AppError', () => {
  it('maps codes to HTTP status', () => {
    expect(new AppError('SHOP_CLOSED', 'Closed').status).toBe(409);
    expect(new AppError('NEEDS_OWNER_APPROVAL', 'Sent').status).toBe(202);
    expect(ERROR_STATUS.ACCOUNT_LOCKED).toBe(423);
  });

  it('renders the standard envelope', () => {
    const err = new AppError('PRICE_CHANGED', 'Some items changed.', { changes: [] });
    expect(err.toBody('req_1')).toEqual({
      error: { code: 'PRICE_CHANGED', message: 'Some items changed.', details: { changes: [] }, request_id: 'req_1' },
    });
    expect(new AppError('INTERNAL', 'Oops').toBody('req_2')).toEqual({
      error: { code: 'INTERNAL', message: 'Oops', request_id: 'req_2' },
    });
  });

  it('recognises codes', () => {
    expect(isErrorCode('VERSION_CONFLICT')).toBe(true);
    expect(isErrorCode('constructor')).toBe(false);
  });
});
