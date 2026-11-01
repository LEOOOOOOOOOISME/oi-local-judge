import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'del',
  'ins',
  'span',
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mo',
  'mn',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mstyle',
  'mspace',
  'mtext',
  'munder',
  'mover',
  'munderover',
  'mtable',
  'mtr',
  'mtd',
  'menclose',
  'mpadded',
  'mphantom',
  'merror',
  'mfenced',
]);

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: ['class'],
    pre: ['class'],
    span: ['class', 'style', 'aria-hidden'],
    math: ['xmlns', 'display'],
    mrow: ['displaystyle'],
    mstyle: ['displaystyle', 'scriptlevel'],
    annotation: ['encoding'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
  },
};

function createMarkdown(html: boolean, breaks: boolean) {
  return new MarkdownIt({ html, linkify: true, breaks })
    .use(texmath, {
      engine: katex,
      delimiters: 'dollars',
      katexOptions: { throwOnError: false, output: 'htmlAndMathml' },
    });
}

const markdown = createMarkdown(true, true);
const markdownNoHtml = createMarkdown(false, true);

function normalizeMathDelimiters(value: string): string {
  return value
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `\n$$${body}$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`);
}

export function renderRichText(
  source: string,
  options: { allowHtml?: boolean; breaks?: boolean } = {},
): string {
  const allowHtml = options.allowHtml !== false;
  const renderer = allowHtml ? markdown : markdownNoHtml;
  const rendered = renderer.render(normalizeMathDelimiters(source ?? ''));
  return sanitizeHtml(rendered, SANITIZE_OPTIONS);
}

/**
 * Problem statements are stored as either legacy HTML or Markdown source.
 * Rendered HTML is detected and only sanitized; plain source goes through the
 * Markdown + KaTeX pipeline. This keeps existing problems working while new
 * statements can be authored as Markdown.
 */
export function renderStatementHtml(value: string): string {
  const source = value ?? '';
  if (source.trim() === '') return '';
  if (/^\s*</.test(source) && /<(p|h[1-6]|div|table|ul|ol|pre|blockquote|span)\b/i.test(source)) {
    return sanitizeHtml(source, SANITIZE_OPTIONS);
  }
  return renderRichText(source, { allowHtml: true });
}
