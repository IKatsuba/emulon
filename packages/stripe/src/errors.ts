import { DomainError } from 'emulon';

/**
 * A Stripe API error as the official clients decode it. It is also a caller-safe
 * command error, so CLI and SDK callers see the same reason and code; messages
 * name parameters and resource IDs but never echo other input.
 */
export class StripeError extends DomainError {
  readonly param: string | undefined;
  readonly stripeCode: string | undefined;

  constructor(
    public status: number,
    public type: string,
    message: string,
    options: { code?: string; param?: string } = {},
  ) {
    super(options.code ?? type, message);

    this.stripeCode = options.code;
    this.param = options.param;
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.stripeCode ? { code: this.stripeCode } : {}),
        ...(this.param ? { param: this.param } : {}),
      },
    };
  }
}

export function invalidRequest(
  message: string,
  param?: string,
  code = param ? 'parameter_invalid' : undefined,
): StripeError {
  return new StripeError(400, 'invalid_request_error', message, {
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
  });
}

export function missing(resource: string, id: string, param = 'id') {
  return new StripeError(
    404,
    'invalid_request_error',
    `No such ${resource}: '${id}'`,
    { code: 'resource_missing', param },
  );
}
