import type { HelpDoc } from './types';

const CATEGORY_ORDER = ['开始', '出题', '比赛', '评测', '团队', '系统', '维护', 'FAQ'];

export function searchHelpDocs(docs: readonly HelpDoc[], query: string): HelpDoc[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...docs];
  return docs.filter((doc) =>
    [doc.title, doc.category, doc.plainText].some((value) => value.toLowerCase().includes(q)),
  );
}

export function groupHelpDocs(docs: readonly HelpDoc[]): Array<{ category: string; docs: HelpDoc[] }> {
  const groups = new Map<string, HelpDoc[]>();
  for (const doc of docs) {
    const bucket = groups.get(doc.category);
    if (bucket) {
      bucket.push(doc);
    } else {
      groups.set(doc.category, [doc]);
    }
  }

  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };

  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([category, categoryDocs]) => ({ category, docs: categoryDocs }));
}
