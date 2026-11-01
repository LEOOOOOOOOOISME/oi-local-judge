import { useMemo } from 'react';
import { sanitizeHtml } from '../utils/sanitizeHtml';

export function StatementHtml({
  html,
  className = 'statement',
}: {
  html: string;
  className?: string;
}) {
  const clean = useMemo(() => sanitizeHtml(html), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
}
