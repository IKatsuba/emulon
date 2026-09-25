/**
 * The pinned official client. Its `debug` dependency enumerates the whole
 * environment when it loads, which the suite does not grant, so the import
 * sees an empty one; only `DEBUG` itself is readable.
 */
const environment = Deno.env.toObject;

Deno.env.toObject = () => ({});

export const { Bot, GrammyError } = await import('grammy').finally(() => {
  Deno.env.toObject = environment;
});
