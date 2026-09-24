import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { billingCases } from './billing_cases.ts';
import { customerCases } from './customer_cases.ts';
import { basilFlavor } from './flavors.ts';
import { webhookCases } from './webhook_cases.ts';

/**
 * The whole declared slice again, through stripe@18.0.0 and its pinned
 * 2025-03-31.basil. The suites are the dahlia ones; the flavor supplies what
 * basil spells differently.
 */
export const { cases, register } = caseRegistry(
  'packages/stripe/tests/basil_cases.ts',
);

customerCases(basilFlavor, register);
webhookCases(basilFlavor, register);
billingCases(basilFlavor, register);
