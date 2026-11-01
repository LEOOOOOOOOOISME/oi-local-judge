import { describe, expect, it } from 'vitest';
import { renderRichText, renderStatementHtml } from '../src/services/rich-text.js';

describe('rich text renderer', () => {
  it('renders markdown, tables and raw HTML', () => {
    const html = renderRichText(
      '# 标题\n\n**加粗**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<table><tr><td>raw</td></tr></table>',
    );
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('raw');
  });

  it('renders inline and display latex with katex', () => {
    const html = renderRichText('行内 $a^2+b^2=c^2$ 和显示：\n\n$$\\sum_{i=1}^n i$$');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$a^2');
    expect(html).not.toContain('$$');
  });

  it('strips scripts, event handlers and javascript links', () => {
    const html = renderRichText(
      '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('treats legacy rendered HTML as HTML and plain source as markdown', () => {
    expect(renderStatementHtml('<p>legacy <b>html</b></p><script>x</script>')).toBe(
      '<p>legacy <b>html</b></p>',
    );
    expect(renderStatementHtml('## 新题面\n\n公式 $x+1$')).toContain('<h2>新题面</h2>');
    expect(renderStatementHtml('## 新题面\n\n公式 $x+1$')).toContain('class="katex"');
  });
});
