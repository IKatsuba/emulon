/**
 * Telegram MarkdownV2 parsing, modelled on the TDLib parser the Bot API uses:
 * one left-to-right pass over the source with a stack of open entities, so
 * nesting, escaping and delimiter ambiguity resolve the way Telegram resolves
 * them. Offsets and lengths are UTF-16 code units of the rendered text, which
 * is exactly how a JavaScript string counts.
 */

export type EntityType =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'spoiler'
  | 'code'
  | 'pre'
  | 'text_link'
  | 'blockquote'
  | 'expandable_blockquote';

/** A Bot API `MessageEntity` limited to the types this parser produces. */
export interface MessageEntity {
  type: EntityType;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface ParsedText {
  text: string;
  entities: MessageEntity[];
}

/**
 * Malformed or unsupported markup. It carries no detail: Telegram's own
 * message names the offending character, which would echo caller input.
 */
export class MarkdownError extends Error {
  constructor() {
    super("can't parse entities");
  }
}

/** Characters that are markup outside code and must otherwise be escaped. */
const reserved = new Set('_*[]()~`>#+-=|{}.!');

interface Open {
  type: Exclude<EntityType, 'blockquote' | 'expandable_blockquote'>;
  offset: number;
  order: number;
  language?: string;
}

interface Quote {
  offset: number;
  order: number;
}

/** Any character from 1 to 126 may follow a backslash to stand for itself. */
function escapable(source: string, index: number): boolean {
  const code = source.charCodeAt(index);

  return code >= 1 && code <= 126;
}

/**
 * Link targets are unescaped verbatim. Telegram adds `http://` to a target
 * without a scheme and silently drops a link it cannot read as a URL; mention,
 * custom emoji, mail and other schemes are outside this emulator's scope and
 * are refused rather than rendered differently.
 */
export function linkTarget(raw: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) {
      throw new MarkdownError();
    }
  } else if (/^(tg|ton|tonsite|mailto|tel):/i.test(raw)) {
    throw new MarkdownError();
  } else {
    raw = `http://${raw}`;
  }

  if (/\s/.test(raw)) {
    return null;
  }

  try {
    const url = new URL(raw);

    return url.hostname === '' ? null : url.href;
  } catch {
    return null;
  }
}

export function parseMarkdownV2(source: string): ParsedText {
  let text = '';
  const entities: (MessageEntity & { order: number })[] = [];
  const open: Open[] = [];
  let quote: Quote | null = null;
  let order = 0;
  let lineStart = true;

  const push = (entity: MessageEntity, at: number) => {
    // An empty entity is dropped, as Telegram drops `**` or `[](url)`.
    if (entity.length > 0) {
      entities.push({ ...entity, order: at });
    }
  };

  // Entities opened inside a quotation must close inside it.
  const closeQuote = (expandable: boolean) => {
    if (open.length > 0) {
      throw new MarkdownError();
    }

    push({
      type: expandable ? 'expandable_blockquote' : 'blockquote',
      offset: quote!.offset,
      length: text.length - quote!.offset,
    }, quote!.order);

    quote = null;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const top = open.at(-1);
    const inCode = top?.type === 'code' || top?.type === 'pre';
    const atLineStart = lineStart;

    lineStart = false;

    if (c === '\\' && escapable(source, i + 1)) {
      text += source[++i];

      continue;
    }

    if (atLineStart && !inCode) {
      const marker = source.startsWith('**>', i)
        ? 3
        : source[i] === '>'
        ? 1
        : 0;

      if (marker > 0) {
        // Quotations cannot nest in other entities or in each other.
        if (!quote && open.length > 0) {
          throw new MarkdownError();
        }

        quote ??= { offset: text.length, order: order++ };
        i += marker - 1;

        continue;
      }
    }

    if (c === '\n') {
      if (quote) {
        if (inCode) {
          // Code spanning quoted lines would need prefix rules Telegram
          // does not document; refuse instead of guessing them.
          throw new MarkdownError();
        }

        if (source[i + 1] !== '>') {
          closeQuote(false);
        }
      }

      text += c;
      lineStart = true;

      continue;
    }

    if (inCode ? c !== '`' : !reserved.has(c)) {
      text += c;

      continue;
    }

    // The expandability mark: `||` ending a quoted line outside a spoiler.
    if (
      quote && c === '|' && source[i + 1] === '|' && top?.type !== 'spoiler' &&
      (i + 2 === source.length || source[i + 2] === '\n')
    ) {
      closeQuote(true);
      i++;

      continue;
    }

    const ends = top !== undefined && (() => {
      switch (top.type) {
        case 'bold':
          return c === '*';
        case 'italic':
          return c === '_' && source[i + 1] !== '_';
        case 'underline':
          return c === '_' && source[i + 1] === '_';
        case 'strikethrough':
          return c === '~';
        case 'spoiler':
          return c === '|' && source[i + 1] === '|';
        case 'code':
          return c === '`';
        case 'pre':
          return source.startsWith('```', i);
        case 'text_link':
          return c === ']';
      }
    })();

    if (ends) {
      const entity = open.pop()!;
      const base = {
        type: entity.type,
        offset: entity.offset,
        length: text.length - entity.offset,
      };

      // Skip the rest of a multi-character closing delimiter.
      i += entity.type === 'underline' || entity.type === 'spoiler'
        ? 1
        : entity.type === 'pre'
        ? 2
        : 0;

      if (entity.type === 'text_link') {
        let raw = '';

        if (source[i + 1] === '(') {
          i += 2;

          while (i < source.length && source[i] !== ')') {
            if (source[i] === '\\' && escapable(source, i + 1)) {
              i++;
            }

            raw += source[i++];
          }

          if (i >= source.length) {
            throw new MarkdownError();
          }
        } else {
          raw = text.slice(entity.offset);
        }

        const url = linkTarget(raw);

        if (url !== null) {
          push({ ...base, url }, entity.order);
        }
      } else if (entity.type === 'pre' && entity.language !== undefined) {
        push({ ...base, language: entity.language }, entity.order);
      } else {
        push(base, entity.order);
      }

      continue;
    }

    // A backtick inside code that does not close it cannot open anything.
    if (inCode) {
      throw new MarkdownError();
    }

    const start: Omit<Open, 'offset' | 'order'> = (() => {
      switch (c) {
        case '_':
          if (source[i + 1] === '_') {
            i++;

            return { type: 'underline' };
          }

          return { type: 'italic' };
        case '*':
          return { type: 'bold' };
        case '~':
          return { type: 'strikethrough' };
        case '|':
          if (source[i + 1] === '|') {
            i++;

            return { type: 'spoiler' };
          }

          throw new MarkdownError();
        case '[':
          // Links cannot contain links.
          if (open.some((entity) => entity.type === 'text_link')) {
            throw new MarkdownError();
          }

          return { type: 'text_link' };
        case '`': {
          if (!source.startsWith('```', i)) {
            return { type: 'code' };
          }

          i += 3;

          let end = i;

          while (
            end < source.length && !/\s/.test(source[end]!) &&
            source[end] !== '`'
          ) {
            end++;
          }

          let language: string | undefined;

          if (end !== i && end < source.length && source[end] !== '`') {
            language = source.slice(i, end);
            i = end;
          }

          // One line break after the opening fence is not content.
          if (source[i] === '\n' || source[i] === '\r') {
            const pair = (source[i + 1] === '\n' || source[i + 1] === '\r') &&
              source[i] !== source[i + 1];

            i += pair ? 2 : 1;
          }

          i--;

          return language === undefined
            ? { type: 'pre' }
            : { type: 'pre', language };
        }
        default:
          // Includes `!` before `[`: custom emoji are not emulated.
          throw new MarkdownError();
      }
    })();

    open.push({ ...start, offset: text.length, order: order++ });
  }

  if (open.length > 0) {
    throw new MarkdownError();
  }

  if (quote) {
    closeQuote(false);
  }

  // Outer entities first: by offset, then longer first, then opening order.
  entities.sort((a, b) =>
    a.offset - b.offset || b.length - a.length || a.order - b.order
  );

  return {
    text,
    entities: entities.map(({ order: _, ...entity }) => entity),
  };
}
