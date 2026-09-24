import type { StripeError } from '../errors.ts';
import type { Params } from '../http/form.ts';
import type { EventFact, Resolver } from '../model/core.ts';
import type { Inputs, OperationId } from '../operations.ts';

/** A request a version module decoded: canonical input and expansion paths. */
export interface Parsed<Input> {
  input: Input;
  expand: string[];
}

/** A provider event envelope as one API version shows it. */
export type StripeEvent = { id: string; object: 'event'; type: string } & {
  [key: string]: unknown;
};

/**
 * One Stripe API version. It owns everything the wire format decides:
 * parameter names and validation, object and event shapes, and which
 * properties expand. Routing, authentication, idempotency, resource rules and
 * state are shared, so every version sees the same resources.
 */
export interface StripeVersionModule {
  readonly id: string;
  parse<Op extends OperationId>(
    operation: Op,
    params: Params,
  ): Parsed<Inputs[Op]>;
  /** Project a canonical result, expanding through `resolve`. */
  project(
    result: unknown,
    expand: readonly string[],
    resolve: Resolver,
  ): Promise<unknown>;
  projectEvent(type: string, fact: EventFact): StripeEvent;
  /** Validate a provider event in this version and normalize it to a fact. */
  parseEvent(type: string, input: unknown): EventFact;
  /** Name version-specific parameters in an error raised by shared rules. */
  error(operation: OperationId | undefined, error: StripeError): StripeError;
}
