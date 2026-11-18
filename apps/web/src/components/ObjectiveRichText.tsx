import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';
import 'katex/dist/katex.min.css';

/**
 * 客观题题干/选项富文本：Markdown + LaTeX（$...$ / $$...$$）。
 *
 * 渲染顺序固定为 markdown-it → sanitize-html → dangerouslySetInnerHTML，
 * 前端永远不直接插入未净化的 HTML。KaTeX 的 HTML + MathML 输出需要保留
 * span/class/style 与 MathML 标签，其余脚本、事件属性、javascript: 链接
 * 都会被 sanitize-html 白名单移除。
 */

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

function createMarkdown() {
  return new MarkdownIt({ html: true, linkify: true, breaks: true }).use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { throwOnError: false, output: 'htmlAndMathml' },
  });
}

const markdown = createMarkdown();

/** 兼容作者从其他 OJ 粘贴的 \[...\] / \(...\) 公式写法。 */
function normalizeMathDelimiters(value: string): string {
  return value
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `\n$$${body}$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`);
}

export interface ObjectiveRichTextOptions {
  /** 行内模式：用于选项，不生成 <p> 等块级标签。 */
  inline?: boolean;
}

/**
 * 纯渲染函数，便于在无 DOM 的测试环境中验证 Markdown / LaTeX / 净化结果。
 * 返回值已经过 sanitize-html 白名单清洗，可以直接插入 dangerouslySetInnerHTML。
 */
export function renderObjectiveRichText(
  source: string,
  options: ObjectiveRichTextOptions = {},
): string {
  const text = source ?? '';
  if (text.trim() === '') return '';
  const normalized = normalizeMathDelimiters(text);
  const rendered = options.inline
    ? markdown.renderInline(normalized)
    : markdown.render(normalized);
  return sanitizeHtml(rendered, SANITIZE_OPTIONS);
}

interface ObjectiveRichTextProps {
  text: string;
  inline?: boolean;
  className?: string;
}

export function ObjectiveRichText({
  text,
  inline = false,
  className,
}: ObjectiveRichTextProps) {
  const html = useMemo(() => renderObjectiveRichText(text, { inline }), [text, inline]);
  if (!html) return null;
  const props = {
    className: className ?? (inline ? 'objective-rich-text-inline' : 'objective-rich-text'),
    dangerouslySetInnerHTML: { __html: html },
  };
  return inline ? <span {...props} /> : <div {...props} />;
}
