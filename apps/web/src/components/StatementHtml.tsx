import { useMemo } from 'react';
import { sanitizeHtml } from '../utils/sanitizeHtml';

export function StatementHtml({ html }: { html: string }) {
  const clean = useMemo(() => sanitizeHtml(html), [html]);
  return <div className="statement" dangerouslySetInnerHTML={{ __html: clean }} />;
}
