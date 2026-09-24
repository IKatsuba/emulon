import { createStripe, type Plugin } from './plugin.ts';
import { dahlia } from './versions/dahlia/mod.ts';

export type { ApiVersion, Options } from './plugin.ts';

const stripe: Plugin = createStripe([dahlia], dahlia.id);

export default stripe;
