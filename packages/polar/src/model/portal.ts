// Polar request fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { type ValidationIssue, validationIssue } from './errors.ts';
import type { Metadata } from './license_keys.ts';

/**
 * Request validation for the public customer-portal license-key routes.
 *
 * Issue types and messages follow Pydantic, which validates these bodies
 * upstream, but every issue is a projection: no `input`, no `ctx`, no metadata
 * member name and no parser suffix that quotes a character, because any of
 * them may carry the license key or a caller condition.
 */

export interface ActivateRequest {
  key: string;
  organization_id: string;
  label: string;
  conditions: Metadata;
  meta: Metadata;
}

export interface ValidateRequest {
  key: string;
  organization_id: string;
  activation_id: string | null;
  benefit_id: string | null;
  customer_id: string | null;
  increment_usage: number | null;
  conditions: Metadata;
}

export interface DeactivateRequest {
  key: string;
  organization_id: string;
  activation_id: string;
}

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

type Body = Record<string, unknown>;

const uuidPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/** The canonical lowercase hyphenated form, as Python's `UUID` compares. */
export function canonicalUuid(value: string): string {
  const hex = value.replaceAll('-', '').toLowerCase();

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Reads the request text; an empty body is a missing body, as in FastAPI. */
export function parseJson(text: string): Parsed<Body> {
  if (text.trim() === '') {
    return {
      ok: false,
      issues: [validationIssue(['body'], 'Field required', 'missing')],
    };
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      issues: [validationIssue(['body'], 'JSON decode error', 'json_invalid')],
    };
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      issues: [
        validationIssue(
          ['body'],
          'Input should be a valid dictionary or object to extract fields from',
          'model_attributes_type',
        ),
      ],
    };
  }

  return { ok: true, value: body as Body };
}

/**
 * Collects every issue, as Pydantic does. A rejected field reads as a
 * placeholder; the placeholder is never used because any issue fails the body.
 */
class Reader {
  readonly issues: ValidationIssue[] = [];

  constructor(private readonly body: Body) {}

  private fail(field: string, msg: string, type: string): null {
    this.issues.push(validationIssue(['body', field], msg, type));

    return null;
  }

  string(field: string): string {
    const value = this.body[field];

    if (typeof value === 'string') {
      return value;
    }

    if (Object.hasOwn(this.body, field)) {
      this.fail(field, 'Input should be a valid string', 'string_type');
    } else {
      this.fail(field, 'Field required', 'missing');
    }

    return '';
  }

  uuid(field: string): string {
    if (!Object.hasOwn(this.body, field)) {
      this.fail(field, 'Field required', 'missing');

      return '';
    }

    return this.uuid4(field, this.body[field]) ?? '';
  }

  optionalUuid(field: string): string | null {
    const value = this.body[field];

    return value === undefined || value === null
      ? null
      : this.uuid4(field, value);
  }

  /** Polar's request schemas declare `UUID4`; null is not a UUID. */
  private uuid4(field: string, value: unknown): string | null {
    if (typeof value !== 'string') {
      return this.fail(
        field,
        'UUID input should be a string, bytes or UUID object',
        'uuid_type',
      );
    }

    if (!uuidPattern.test(value)) {
      return this.fail(field, 'Input should be a valid UUID', 'uuid_parsing');
    }

    const uuid = canonicalUuid(value);

    // Python's `UUID.version` is None outside the RFC 4122 variant, so a
    // version digit of 4 counts only with variant bits 10 (8, 9, a or b).
    return uuid[14] === '4' && '89ab'.includes(uuid.charAt(19))
      ? uuid
      : this.fail(field, 'UUID version 4 expected', 'uuid_version');
  }

  optionalCount(field: string): number | null {
    const value = this.body[field];

    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return this.fail(field, 'Input should be a valid integer', 'int_type');
    }

    if (!Number.isInteger(value)) {
      return this.fail(
        field,
        'Input should be a valid integer, got a number with a fractional part',
        'int_from_float',
      );
    }

    return value < 0
      ? this.fail(
        field,
        'Input should be greater than or equal to 0',
        'greater_than_equal',
      )
      : value;
  }

  /** The bounded metadata object; issues name the field, never a member. */
  metadata(field: string): Metadata {
    const value = this.body[field];

    if (value === undefined) {
      return {};
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.fail(field, 'Input should be a valid dictionary', 'dict_type');

      return {};
    }

    const entries = Object.entries(value);
    const before = this.issues.length;

    for (const [name, member] of entries) {
      if (name.length < 1) {
        this.fail(
          field,
          'String should have at least 1 character',
          'string_too_short',
        );
      } else if (name.length > 40) {
        this.fail(
          field,
          'String should have at most 40 characters',
          'string_too_long',
        );
      }

      if (typeof member === 'string') {
        if (member.length < 1) {
          this.fail(
            field,
            'String should have at least 1 character',
            'string_too_short',
          );
        } else if (member.length > 500) {
          this.fail(
            field,
            'String should have at most 500 characters',
            'string_too_long',
          );
        }
      } else if (
        !(typeof member === 'number' && Number.isFinite(member)) &&
        typeof member !== 'boolean'
      ) {
        // Pydantic reports every union member; the first stands for them all.
        this.fail(field, 'Input should be a valid string', 'string_type');
      }
    }

    if (entries.length > 50) {
      this.fail(
        field,
        `Dictionary should have at most 50 items after validation, not ${entries.length}`,
        'too_long',
      );
    }

    return this.issues.length === before ? value as Metadata : {};
  }

  result<T>(value: T): Parsed<T> {
    return this.issues.length === 0
      ? { ok: true, value }
      : { ok: false, issues: this.issues };
  }
}

/** Unknown members are ignored, as by Polar's request schemas. */
export function parseActivate(body: Body): Parsed<ActivateRequest> {
  const read = new Reader(body);

  return read.result({
    key: read.string('key'),
    organization_id: read.uuid('organization_id'),
    label: read.string('label'),
    conditions: read.metadata('conditions'),
    meta: read.metadata('meta'),
  });
}

export function parseValidate(body: Body): Parsed<ValidateRequest> {
  const read = new Reader(body);

  return read.result({
    key: read.string('key'),
    organization_id: read.uuid('organization_id'),
    activation_id: read.optionalUuid('activation_id'),
    benefit_id: read.optionalUuid('benefit_id'),
    customer_id: read.optionalUuid('customer_id'),
    increment_usage: read.optionalCount('increment_usage'),
    conditions: read.metadata('conditions'),
  });
}

export function parseDeactivate(body: Body): Parsed<DeactivateRequest> {
  const read = new Reader(body);

  return read.result({
    key: read.string('key'),
    organization_id: read.uuid('organization_id'),
    activation_id: read.uuid('activation_id'),
  });
}
