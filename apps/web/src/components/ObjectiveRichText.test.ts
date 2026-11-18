import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ObjectiveRichText, renderObjectiveRichText } from './ObjectiveRichText';

describe('renderObjectiveRichText', () => {
  it('renders markdown bold and inline code as block HTML', () => {
    const html = renderObjectiveRichText('**加粗** 与 `code`');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<p>');
  });

  it('renders inline and display LaTeX with KaTeX', () => {
    const html = renderObjectiveRichText('公式 $a^2+b^2=c^2$\n\n$$\\sum_{i=1}^n i$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('$a^2');
    expect(html).not.toContain('$$');
  });

  it('keeps plain legacy text readable', () => {
    const html = renderObjectiveRichText('1 + 1 = ?');
    expect(html).toContain('1 + 1 = ?');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('class="katex"');
  });

  it('renders fenced code blocks and markdown images', () => {
    const html = renderObjectiveRichText(
      '```\ncode block\n```\n\n![示意图](https://example.com/a.png)',
    );
    expect(html).toContain('<pre><code>');
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('alt="示意图"');
  });

  it('strips scripts, event handlers and javascript: links', () => {
    const html = renderObjectiveRichText(
      '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)" onclick="x()">点我</a>',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders inline markdown without a <p> wrapper for options', () => {
    const html = renderObjectiveRichText('**粗** 和 $x$', { inline: true });
    expect(html).not.toContain('<p>');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('class="katex"');
  });

  it('returns an empty string for blank text', () => {
    expect(renderObjectiveRichText('   ')).toBe('');
    expect(renderObjectiveRichText('')).toBe('');
  });
});

describe('ObjectiveRichText component', () => {
  it('server-renders sanitized rich html into a block wrapper', () => {
    const html = renderToStaticMarkup(
      createElement(ObjectiveRichText, {
        text: '**粗体** $x+1$',
        className: 'demo-rich-text',
      }),
    );
    expect(html).toContain('class="demo-rich-text"');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('<script');
  });

  it('server-renders inline mode as a span for options', () => {
    const html = renderToStaticMarkup(
      createElement(ObjectiveRichText, { text: '**A**', inline: true }),
    );
    expect(html).toMatch(/^<span/);
    expect(html).toContain('<strong>A</strong>');
    expect(html).not.toContain('<p>');
  });
});
