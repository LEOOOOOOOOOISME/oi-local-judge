/**
 * 轻量题面净化：题面由服务端生成 HTML，但 Phase 1A 尚未接入服务端白名单清洗。
 * 前端在插入前移除脚本、内嵌对象、事件属性和 javascript: 链接，避免本地判题器
 * 在浏览器环境执行不可信内容。
 */

const BLOCKED_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'link',
  'style',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
]);

export function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
    return html;
  }
  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = parsed.body.firstElementChild;
  if (!root) return '';

  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (BLOCKED_TAGS.has(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      const isScriptUrl =
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        (value.startsWith('javascript:') || value.startsWith('vbscript:') || value.startsWith('data:text/html'));
      if (name.startsWith('on') || name === 'srcdoc' || isScriptUrl) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName.toLowerCase() === 'a') {
      const target = element.getAttribute('target');
      if (target === '_blank') {
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  return root.innerHTML;
}
