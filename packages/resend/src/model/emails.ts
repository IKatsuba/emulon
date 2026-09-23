// Resend API email fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import type { Destination, PluginContext } from 'emulon';

const address = z.string().min(3).refine((value) => {
  const mailbox = /^(?:[^<>\r\n]+ <)?([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>?$/.exec(
    value,
  );

  return mailbox !== null && !/[\r\n]/.test(value) &&
    (value.includes('<') === value.endsWith('>'));
});

const recipients = z.union([address, z.array(address).min(1).max(50)]);
export const sendInput: z.ZodType<SendInput> = z.strictObject({
  from: address,
  to: recipients,
  subject: z.string(),
  html: z.string().optional(),
  text: z.string().optional(),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  reply_to: recipients.optional(),
}).refine((value) => value.html !== undefined || value.text !== undefined);
export const emailSchema: z.ZodType<Email> = z.object({
  object: z.literal('email'),
  id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  html: z.string().nullable(),
  text: z.string().nullable(),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  reply_to: z.array(z.string()),
  created_at: z.string(),
  last_event: z.literal('sent'),
});

export interface SendInput {
  from: string;
  to: string | string[];
  subject: string;
  html?: string | undefined;
  text?: string | undefined;
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  reply_to?: string | string[] | undefined;
}
export interface Email {
  object: 'email';
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  cc: string[];
  bcc: string[];
  reply_to: string[];
  created_at: string;
  last_event: 'sent';
}
export type Options = {
  destinations?: Destination[];
  fixtures?: { emails?: (SendInput & { id?: string })[] };
};
type Store = PluginContext['store'];

function addresses(value?: string | string[]): string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

export function makeEmail(input: SendInput, id: string, now: string): Email {
  return {
    object: 'email',
    id,
    from: input.from,
    to: addresses(input.to),
    subject: input.subject,
    html: input.html ?? null,
    text: input.text ?? null,
    cc: addresses(input.cc),
    bcc: addresses(input.bcc),
    reply_to: addresses(input.reply_to),
    created_at: now,
    last_event: 'sent',
  };
}

export function fixtures(
  options?: Options,
): { collection: string; id: string; value: Email }[] {
  const ids = new Set<string>();

  return (options?.fixtures?.emails ?? []).map(
    ({ id = crypto.randomUUID(), ...input }) => {
      if (!z.uuid().safeParse(id).success || ids.has(id)) {
        throw new Error('Invalid fixture email ID.');
      }

      ids.add(id);

      return {
        collection: 'emails',
        id,
        value: makeEmail(sendInput.parse(input), id, new Date().toISOString()),
      };
    },
  );
}

export function sendEmail(store: Store, input: SendInput): Promise<Email> {
  const email = makeEmail(input, crypto.randomUUID(), new Date().toISOString());

  return store.transaction(async (tx) => {
    await tx.put({ collection: 'emails', id: email.id, value: email });
    await tx.record({
      type: 'email.sent',
      occurredAt: email.created_at,
      origin: 'service',
      payload: {
        email_id: email.id,
        from: email.from,
        to: email.to,
        subject: email.subject,
      },
    });

    return email;
  });
}

export function listEmails(store: Store): Promise<Email[]> {
  return store.transaction(async (tx) =>
    (await tx.list('emails')).map((row) => emailSchema.parse(row.value))
  );
}

export function getEmail(store: Store, id: string): Promise<Email | null> {
  return store.transaction(async (tx) => {
    const value = await tx.get('emails', id);

    return value === undefined ? null : emailSchema.parse(value);
  });
}

export function clearEmails(store: Store): Promise<{ deleted: number }> {
  return store.transaction(async (tx) => {
    const rows = await tx.list('emails');

    for (const row of rows) {
      await tx.delete('emails', row.id);
    }

    return { deleted: rows.length };
  });
}
