/** Error codes and envelope shared by every API (Phase 7 §1.5–1.6). */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  SIGNATURE_INVALID: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  BOT_CHECK_FAILED: 403,
  ORDER_NOT_ALLOWED: 403,
  DEVICE_NOT_REGISTERED: 403,
  NOT_FOUND: 404,
  SHOP_CLOSED: 409,
  PRICE_CHANGED: 409,
  ITEM_UNAVAILABLE: 409,
  COUPON_EXHAUSTED: 409,
  TOKENS_UNAVAILABLE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  ORDER_ON_HOLD: 409,
  QR_DISABLED: 410,
  VALIDATION_FAILED: 422,
  COUPON_INVALID: 422,
  BELOW_MINIMUM: 422,
  OUT_OF_DELIVERY_AREA: 422,
  TOO_MANY_TOKENS: 422,
  ACCOUNT_LOCKED: 423,
  NEEDS_OWNER_APPROVAL: 202,
  RATE_LIMITED: 429,
  PAYMENTS_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    request_id: string;
  };
}

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        request_id: requestId,
      },
    };
  }
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_STATUS, value);
}
