import {
  linkTarget,
  MarkdownError,
  type MessageEntity,
  parseMarkdownV2,
} from '../src/format/markdown_v2.ts';
import {
  chatReference,
  maxTextLength,
  render,
  SendError,
  sendRequest,
} from '../src/model/messages.ts';
import { assert, equal } from './assert.ts';
import { parts, source } from './post.ts';

const parse = parseMarkdownV2;

function refused(markup: string) {
  try {
    parse(markup);
  } catch (error) {
    assert(error instanceof MarkdownError, `Unexpected error for ${markup}`);
    equal(error.message, "can't parse entities");

    return;
  }

  throw new Error(`Accepted malformed markup: ${JSON.stringify(markup)}`);
}

function sendFailure(action: () => unknown): [number, string] {
  try {
    action();
  } catch (error) {
    assert(error instanceof SendError, `Not a SendError: ${error}`);

    return [error.status, error.description];
  }

  throw new Error('Expected a rejected send');
}

const e = (
  type: MessageEntity['type'],
  offset: number,
  length: number,
  extra: Partial<MessageEntity> = {},
): MessageEntity => ({ type, offset, length, ...extra });

Deno.test('MarkdownV2 escapes every reserved character and nothing else', () => {
  const reserved = '_*[]()~`>#+-=|{}.!';

  for (const c of reserved) {
    refused(`a${c}b`);
    equal(parse(`a\\${c}b`), { text: `a${c}b`, entities: [] });
  }

  // Any character from 1 to 126 may be escaped; others keep the backslash.
  equal(parse('\\a\\\\\\ \\"'), { text: 'a\\ "', entities: [] });
  equal(parse('\\é\\😀'), { text: '\\é\\😀', entities: [] });
  equal(parse('end\\'), { text: 'end\\', entities: [] });
  equal(parse('\\\n'), { text: '\n', entities: [] });
  equal(parse('plain, text: 100% "ok" @user $5 & <tag\\>'), {
    text: 'plain, text: 100% "ok" @user $5 & <tag>',
    entities: [],
  });
  equal(parse(''), { text: '', entities: [] });
});

Deno.test('MarkdownV2 formatting entities', () => {
  equal(parse('*b* _i_ __u__ ~s~ ||p||'), {
    text: 'b i u s p',
    entities: [
      e('bold', 0, 1),
      e('italic', 2, 1),
      e('underline', 4, 1),
      e('strikethrough', 6, 1),
      e('spoiler', 8, 1),
    ],
  });
  equal(parse('*bold \\*text*'), {
    text: 'bold *text',
    entities: [e('bold', 0, 10)],
  });

  // Empty entities disappear without an error.
  equal(parse('a**b____c||||d'), { text: 'abcd', entities: [] });

  for (
    const malformed of [
      '*open',
      'close*',
      '_a',
      '__a_',
      '~a',
      '||a',
      '|a|',
      '*a _b* c_',
      '*a ~b* c~',
    ]
  ) {
    refused(malformed);
  }
});

Deno.test('MarkdownV2 nesting, including the documented example', () => {
  equal(
    parse(
      '*bold _italic bold ~italic bold strikethrough ||italic bold strikethrough spoiler||~ __underline italic bold___ bold*',
    ),
    {
      text:
        'bold italic bold italic bold strikethrough italic bold strikethrough spoiler underline italic bold bold',
      entities: [
        e('bold', 0, 103),
        e('italic', 5, 93),
        e('strikethrough', 17, 59),
        e('spoiler', 43, 33),
        e('underline', 77, 21),
      ],
    },
  );

  // `__` binds greedily; an empty bold separates italic from underline.
  equal(parse('___italic underline_**__'), {
    text: 'italic underline',
    entities: [e('underline', 0, 16), e('italic', 0, 16)],
  });
  refused('___italic underline___');

  // Same spans list the outer entity first.
  equal(parse('_*both*_'), {
    text: 'both',
    entities: [e('italic', 0, 4), e('bold', 0, 4)],
  });
  equal(parse('*a `code` b*'), {
    text: 'a code b',
    entities: [e('bold', 0, 8), e('code', 2, 4)],
  });
});

Deno.test('MarkdownV2 inline and fenced code', () => {
  equal(parse('`a\\`b\\\\c *d* _e_ [f](g) > !`'), {
    text: 'a`b\\c *d* _e_ [f](g) > !',
    entities: [e('code', 0, 24)],
  });
  equal(parse('```\npre *x*\n```'), {
    text: 'pre *x*\n',
    entities: [e('pre', 0, 8)],
  });
  equal(parse('```python\nprint(1)\n```'), {
    text: 'print(1)\n',
    entities: [e('pre', 0, 9, { language: 'python' })],
  });
  // A fence closed on its own line keeps no language.
  equal(parse('```inline```'), {
    text: 'inline',
    entities: [e('pre', 0, 6)],
  });
  equal(parse('```\r\nwin\r\n```'), {
    text: 'win\r\n',
    entities: [e('pre', 0, 5)],
  });
  equal(parse('``````'), { text: '', entities: [] });

  for (const malformed of ['`open', '```\nopen', '```\na`b\n```', '`a``']) {
    refused(malformed);
  }
});

Deno.test('MarkdownV2 links resolve their targets like Telegram', () => {
  equal(parse('[inline URL](http://www.example.com/)'), {
    text: 'inline URL',
    entities: [e('text_link', 0, 10, { url: 'http://www.example.com/' })],
  });
  equal(parse('[a](https://x.y/a_\\(b\\)?q=1\\\\)'), {
    text: 'a',
    entities: [e('text_link', 0, 1, { url: 'https://x.y/a_(b)?q=1\\' })],
  });
  equal(parse('[a](example.com/p)'), {
    text: 'a',
    entities: [e('text_link', 0, 1, { url: 'http://example.com/p' })],
  });
  // Without a target the text is the URL.
  equal(parse('[example\\.com]'), {
    text: 'example.com',
    entities: [e('text_link', 0, 11, { url: 'http://example.com/' })],
  });
  equal(parse('[*bold* link](https://x.y)'), {
    text: 'bold link',
    entities: [
      e('text_link', 0, 9, { url: 'https://x.y/' }),
      e('bold', 0, 4),
    ],
  });
  equal(parse('*[a](https://x.y) b*'), {
    text: 'a b',
    entities: [e('bold', 0, 3), e('text_link', 0, 1, { url: 'https://x.y/' })],
  });

  // An unreadable target drops the link but keeps its text.
  equal(parse('[kept](not a url)'), { text: 'kept', entities: [] });
  equal(parse('[](https://x.y)'), { text: '', entities: [] });

  for (
    const malformed of [
      '[a](https://x.y',
      '[a',
      'a]',
      '[a [b](https://x.y)](https://x.y)',
      '[*a](https://x.y)*',
      '[a](tg://user?id=1)',
      '[a](mailto:a@x.y)',
      '[a](ftp://x.y)',
      '![👍](tg://emoji?id=5368324170671202286)',
    ]
  ) {
    refused(malformed);
  }

  equal(linkTarget('HTTPS://Example.com'), 'https://example.com/');
  equal(linkTarget('http://'), null);
});

Deno.test('MarkdownV2 block quotations', () => {
  equal(parse('>one\n>two *b*\nafter'), {
    text: 'one\ntwo b\nafter',
    entities: [e('blockquote', 0, 9), e('bold', 8, 1)],
  });
  equal(parse('before\n>quote'), {
    text: 'before\nquote',
    entities: [e('blockquote', 7, 5)],
  });
  // The documented expandable form, right after an ordinary quotation.
  equal(parse('>plain\n**>hidden\n>more||\ntail'), {
    text: 'plain\nhidden\nmore\ntail',
    entities: [
      e('blockquote', 0, 5),
      e('expandable_blockquote', 6, 11),
    ],
  });
  equal(parse('>a ||s||'), {
    text: 'a s',
    entities: [e('blockquote', 0, 3), e('spoiler', 2, 1)],
  });
  equal(parse('>*a\n>b*'), {
    text: 'a\nb',
    entities: [e('blockquote', 0, 3), e('bold', 0, 3)],
  });
  equal(parse('>\n>x'), {
    text: '\nx',
    entities: [e('blockquote', 0, 2)],
  });

  for (
    const malformed of [
      '>>nested',
      'a>b',
      '*a\n>b*',
      '>*a\nb*',
      '>`a\n>b`',
      '>```\n>x\n>```',
    ]
  ) {
    refused(malformed);
  }
});

Deno.test('MarkdownV2 offsets count UTF-16 code units of rendered text', () => {
  equal(parse('😀 *𝒳* _é_'), {
    text: '😀 𝒳 é',
    entities: [e('bold', 3, 2), e('italic', 6, 1)],
  });
  equal(parse('[👍🏽](https://x.y) \\*'), {
    text: '👍🏽 *',
    entities: [e('text_link', 0, 4, { url: 'https://x.y/' })],
  });
});

Deno.test('the length limit counts rendered UTF-16 units after parsing', () => {
  equal(render('a'.repeat(maxTextLength), null).text.length, maxTextLength);
  equal(
    sendFailure(() => render('a'.repeat(maxTextLength + 1), null)),
    [400, 'Bad Request: message is too long'],
  );

  // Escapes, delimiters and link targets do not count.
  const escaped = '\\.'.repeat(maxTextLength);

  equal(render(escaped, 'MarkdownV2').text.length, maxTextLength);
  equal(
    sendFailure(() => render(`${escaped}\\.`, 'MarkdownV2')),
    [400, 'Bad Request: message is too long'],
  );
  equal(
    render(`*${'a'.repeat(4094)}*[b](https://example.com/long)c`, 'MarkdownV2')
      .text.length,
    maxTextLength,
  );

  // Astral characters are two units each.
  equal(render('😀'.repeat(2048), 'MarkdownV2').text.length, maxTextLength);
  equal(
    sendFailure(() => render(`${'😀'.repeat(2048)}a`, 'MarkdownV2')),
    [400, 'Bad Request: message is too long'],
  );

  // Malformed markup is reported before the length.
  equal(
    sendFailure(() => render(`${'a'.repeat(5000)}.`, 'MarkdownV2')),
    [400, "Bad Request: can't parse entities"],
  );
  // Without a parse mode, markup is ordinary text.
  equal(render('*a*.', null), { text: '*a*.', entities: [] });

  for (const empty of ['', '**', '[](https://x.y)']) {
    equal(
      sendFailure(() => render(empty, 'MarkdownV2')),
      [400, 'Bad Request: message text is empty'],
    );
  }
});

Deno.test('the pinned md-to-telegram post parses part by part', () => {
  assert(parts.length > 2, 'The post was not split');
  assert(source.length > maxTextLength, 'The post fits one message');

  const types = new Set<string>();

  for (const part of parts) {
    const { text, entities } = render(part, 'MarkdownV2');

    for (const entity of entities) {
      types.add(entity.type);

      const end = entity.offset + entity.length;

      assert(end <= text.length, 'Entity past the text');

      // No entity boundary cuts a surrogate pair.
      for (const at of [entity.offset, end]) {
        const code = text.charCodeAt(at);

        assert(!(code >= 0xdc00 && code <= 0xdfff), 'Split surrogate pair');
      }
    }
  }

  equal([...types].sort(), [
    'blockquote',
    'bold',
    'code',
    'expandable_blockquote',
    'italic',
    'pre',
    'spoiler',
    'strikethrough',
    'text_link',
    'underline',
  ]);

  const first = render(parts[0]!, 'MarkdownV2');

  assert(first.text.startsWith('Weekly digest 🚀\n\nSome bold, italic, both,'));
  assert(
    first.entities.some((entity) =>
      entity.type === 'text_link' &&
      entity.url === 'https://example.com/a_(b)?q=1' &&
      first.text.slice(entity.offset, entity.offset + entity.length) ===
        'link'
    ),
    'Link with parentheses lost',
  );
  assert(
    first.entities.some((entity) =>
      entity.type === 'pre' && entity.language === 'typescript' &&
      first.text.slice(entity.offset).startsWith(
        'const a = `x` + \'\\\\\' + "*not bold*";',
      )
    ),
    'Fenced code lost',
  );
});

Deno.test('sendMessage fields: supported values, explicit refusals', () => {
  equal(
    sendRequest({
      chat_id: -1001,
      text: 'x',
      parse_mode: 'MarkdownV2',
      disable_notification: true,
      link_preview_options: { is_disabled: false },
    }),
    { chat: { id: -1001 }, source: 'x', parseMode: 'MarkdownV2' },
  );
  equal(
    sendRequest({ chat_id: '@News', text: 'x', parse_mode: 'markdownv2' }),
    {
      chat: { username: 'news' },
      source: 'x',
      parseMode: 'MarkdownV2',
    },
  );
  equal(
    sendRequest({
      chat_id: '-1001',
      text: 'x',
      parse_mode: '',
      disable_notification: false,
      link_preview_options: {},
    }),
    { chat: { id: -1001 }, source: 'x', parseMode: null },
  );

  const unsupported = [501, 'Not Implemented: parameter is not emulated'];

  for (
    const extra of [
      { reply_markup: {} },
      { entities: [] },
      { message_thread_id: 1 },
      { disable_web_page_preview: true },
      { protect_content: true },
      { link_preview_options: { is_disabled: true } },
      { link_preview_options: { is_disabled: false, url: 'https://x.y' } },
    ]
  ) {
    equal(
      sendFailure(() => sendRequest({ chat_id: -1001, text: 'x', ...extra })),
      unsupported,
    );
  }

  for (
    const [params, expected] of [
      [{ text: 'x', parse_mode: 'HTML' }, [
        501,
        'Not Implemented: parse mode is not emulated',
      ]],
      [{ text: 'x', parse_mode: 'Markdown' }, [
        501,
        'Not Implemented: parse mode is not emulated',
      ]],
      [{ text: 'x', parse_mode: 'Plain' }, [
        400,
        'Bad Request: unsupported parse_mode',
      ]],
      [{ text: 'x', disable_notification: 'yes' }, [
        400,
        'Bad Request: invalid parameter value',
      ]],
      [{ text: 'x', link_preview_options: null }, [
        400,
        'Bad Request: invalid parameter value',
      ]],
      [{ text: 7 }, [400, 'Bad Request: invalid parameter value']],
      [{ text: '' }, [400, 'Bad Request: message text is empty']],
      [{}, [400, 'Bad Request: message text is empty']],
    ] as const
  ) {
    equal(
      sendFailure(() => sendRequest({ chat_id: -1001, ...params })),
      expected,
    );
  }

  equal(sendFailure(() => sendRequest({ text: 'x' })), [
    400,
    'Bad Request: chat_id is empty',
  ]);

  for (const chat of ['@', 'news', '01', 1.5, true, null, '-1001.0']) {
    equal(chatReference(chat), null);
  }

  equal(chatReference('-1001234567890'), { id: -1001234567890 });
  equal(chatReference('@Local_News'), { username: 'local_news' });
});
