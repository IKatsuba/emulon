import { DomainError } from 'emulon';

/** Validation locations never echo supplied values; a location is a path only. */
export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/**
 * A caller-safe Polar failure. The code doubles as the provider `error` field
 * and as the command error code exposed through the CLI and SDK.
 */
export class PolarError extends DomainError {
  constructor(
    readonly status: number,
    code:
      | 'ResourceNotFound'
      | 'UnsupportedOperation'
      | 'Unauthorized'
      | 'CustomerAlreadyExists'
      | 'NotPermitted',
    detail: string,
  ) {
    super(code, detail);
  }
}

export class PolarValidationError extends DomainError {
  readonly status = 422;

  constructor(readonly issues: ValidationIssue[]) {
    super('ValidationError', 'Invalid request payload.');
  }
}

export function validationIssue(
  loc: (string | number)[],
  msg: string,
  type: string,
): ValidationIssue {
  return { loc, msg, type };
}
