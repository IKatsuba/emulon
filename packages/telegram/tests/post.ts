import { splitMessage, toTelegramMarkdownV2 } from 'md-to-telegram';

/**
 * A post in the shape the declared consumer publishes: Markdown converted by
 * the pinned `md-to-telegram` and split into parts that each fit one message.
 * It exercises every construct that converter emits for MarkdownV2.
 */
export const markdown = `# Weekly digest 🚀

Some **bold**, *italic*, ***both***, ~~gone~~, \`code()\` and a
[link](https://example.com/a_(b)?q=1) to example.com.

## Reading list

- first item costs 1.5 € — really!
- second with **bold [nested link](https://x.y/z)** inside
  - nested _item_ with 𝒳 and 😀 astral characters
1. one {curly} #hash
2. two + three = five

> Quoted line one
> line two with **bold** and \`code\`

> [!expandable]
> hidden text
> more hidden

||spoiler|| and ++underlined++ text; a \\ backslash and [brackets].

\`\`\`ts
const a = \`x\` + '\\\\' + "*not bold*";
\`\`\`

| name | value |
|------|-------|
| a    | 1     |

---

${
  Array.from(
    { length: 120 },
    (_, i) =>
      `Paragraph ${i} has **bold**, _italic_ and 😀 emoji (see [docs](https://example.com/docs/${i})).`,
  ).join('\n\n')
}

A single paragraph longer than one message, cut at a space with its marks
reopened: **${'bold and 😀 words, '.repeat(300)}end**.
`;

export const source: string = toTelegramMarkdownV2(markdown).text;

export const parts: string[] = splitMessage(source, { format: 'markdownv2' });
