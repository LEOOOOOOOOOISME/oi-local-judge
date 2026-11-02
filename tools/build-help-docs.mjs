#!/usr/bin/env node
// Generates apps/web/src/help/generated-help.ts from the Markdown sources in
// docs/help (plus docs/ranking.md and docs/batch-import.md).
//
// Rendering happens at build time so the web app never ships a Markdown or
// KaTeX runtime. Everything is offline: no network access is required.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP_DIR = resolve(ROOT, 'docs', 'help');
const OUTPUT_FILE = resolve(ROOT, 'apps', 'web', 'src', 'help', 'generated-help.ts');
const HELP_README = 'docs/help/README.md';

const CATEGORY_BY_DIR = new Map([
  ['getting-started', '开始'],
  ['authoring', '出题'],
  ['contest', '比赛'],
  ['judging', '评测'],
  ['team', '团队'],
  ['system', '系统'],
  ['faq', 'FAQ'],
]);
const DEFAULT_CATEGORY = '开始';

// Keep this allowlist aligned with apps/server/src/services/rich-text.ts.
// `style` is intentionally not allowed: documents must not carry inline CSS.
const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'strong',
  'em',
  'del',
  'br',
  'hr',
  'img',
  'span',
  'div',
  'sup',
  'sub',
  // MathML emitted by KaTeX.
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
];

const SANITIZE_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    div: ['class'],
    math: ['xmlns', 'display'],
    mrow: ['displaystyle'],
    mstyle: ['displaystyle', 'scriptlevel'],
    annotation: ['encoding'],
    '*': ['class', 'id'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
};

function toPosixPath(value) {
  return value.split(sep).join('/');
}

function comparePaths(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function walkMarkdown(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(absolutePath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(absolutePath);
    }
  }
  return files.sort(comparePaths);
}

function sourcePathFor(absolutePath) {
  return toPosixPath(relative(ROOT, absolutePath));
}

function slugForHelpDoc(path) {
  const relativePath = path.slice('docs/help/'.length);
  const withoutExtension = relativePath.replace(/\.md$/i, '');
  if (withoutExtension === 'README') return 'index';
  return withoutExtension;
}

function categoryForSlug(slug) {
  if (!slug.includes('/')) return DEFAULT_CATEGORY;
  return CATEGORY_BY_DIR.get(slug.split('/')[0]) ?? DEFAULT_CATEGORY;
}

function collectSources() {
  const helpDocs = walkMarkdown(HELP_DIR)
    .map(sourcePathFor)
    .sort(comparePaths)
    .map((path) => {
      const slug = slugForHelpDoc(path);
      return { path, slug, category: categoryForSlug(slug) };
    });

  const readme = helpDocs.filter((source) => source.path === HELP_README);
  const rest = helpDocs.filter((source) => source.path !== HELP_README);

  return [
    ...readme,
    ...rest,
    { path: 'docs/ranking.md', slug: 'contest/ranking', category: '比赛' },
    { path: 'docs/batch-import.md', slug: 'contest/batch-import', category: '比赛' },
  ];
}

function inlineText(token) {
  if (!token) return '';
  const children = token.children ?? [];
  const text = children
    .filter((child) =>
      ['text', 'code_inline', 'image', 'math_inline'].includes(child.type),
    )
    .map((child) => child.content)
    .join('')
    .trim();
  return text || token.content.trim();
}

function headingId(text) {
  const id = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return id || 'section';
}

function isRewritableHref(href) {
  if (!href) return false;
  if (href.startsWith('#') || href.startsWith('/') || href.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

function splitHref(href) {
  const hashIndex = href.indexOf('#');
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const pathPart = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  return { pathPart, hash };
}

function createMarkdown(sourceSlugByPath) {
  const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false }).use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { throwOnError: false },
  });

  markdown.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const text = inlineText(tokens[idx + 1]);
    const baseId = headingId(text);
    const seen = (env.headingCounts.get(baseId) ?? 0) + 1;
    env.headingCounts.set(baseId, seen);
    const id = seen === 1 ? baseId : `${baseId}-${seen}`;

    token.attrSet('id', id);
    env.headings.push({ id, text, level: Number(token.tag.slice(1)) });
    return self.renderToken(tokens, idx, options);
  };

  markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href');
    if (isRewritableHref(href)) {
      const { pathPart, hash } = splitHref(href);
      if (/\.md$/i.test(pathPart)) {
        const target = posix.normalize(posix.join(posix.dirname(env.sourcePath), pathPart));
        const targetSlug = sourceSlugByPath.get(target);
        if (targetSlug) {
          token.attrSet('href', `/help?doc=${targetSlug}${hash}`);
        }
      }
    }
    return self.renderToken(tokens, idx, options);
  };

  return markdown;
}

function titleFor(source, slug) {
  const match = /^#\s+(.+)$/m.exec(source);
  if (!match) return slug;
  return match[1].replace(/\s+#+\s*$/, '').trim() || slug;
}

function renderDoc(markdown, source, sourcePath, slug, category) {
  const env = { sourcePath, headings: [], headingCounts: new Map() };
  const rendered = markdown.render(source, env);
  const html = sanitizeHtml(rendered, SANITIZE_OPTIONS);

  return {
    slug,
    title: titleFor(source, slug),
    category,
    path: sourcePath,
    html,
    plainText: sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }),
    headings: env.headings,
  };
}

function main() {
  const sources = collectSources();
  const sourceSlugByPath = new Map(sources.map((source) => [source.path, source.slug]));
  const markdown = createMarkdown(sourceSlugByPath);

  const docs = sources.map((source) => {
    const absolutePath = resolve(ROOT, source.path);
    const text = readFileSync(absolutePath, 'utf8');
    return renderDoc(markdown, text, source.path, source.slug, source.category);
  });

  const generated = [
    '// Generated by tools/build-help-docs.mjs. Do not edit by hand.',
    "import type { HelpDoc } from './types';",
    '',
    `export const HELP_DOCS: HelpDoc[] = ${JSON.stringify(docs, null, 2)};`,
    '',
  ].join('\n');

  writeFileSync(OUTPUT_FILE, generated, 'utf8');
  console.log(`Generated ${docs.length} help docs -> ${sourcePathFor(OUTPUT_FILE)}`);
}

main();
