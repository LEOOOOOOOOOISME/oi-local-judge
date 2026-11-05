import { describe, expect, it } from 'vitest';
import type { HelpDoc } from './types';
import { groupHelpDocs, searchHelpDocs } from './search';

function makeDoc(
  slug: string,
  title: string,
  category: string,
  plainText = '',
): HelpDoc {
  return {
    slug,
    title,
    category,
    path: `docs/help/${slug}.md`,
    html: `<h1>${title}</h1>`,
    plainText,
    headings: [],
  };
}

const docs: HelpDoc[] = [
  makeDoc('authoring/data-plan', '数据计划', '出题', '配置子任务、测试点与分值。'),
  makeDoc('contest/ranking', '排名与赛制', '比赛', '罚时、封榜和正式分。'),
  makeDoc('index', 'OiJudge 帮助中心', '开始', '从这里开始使用 OiJudge。'),
];

describe('searchHelpDocs', () => {
  it('returns every doc for an empty query', () => {
    expect(searchHelpDocs(docs, '')).toEqual(docs);
    expect(searchHelpDocs(docs, '   ')).toEqual(docs);
  });

  it('matches the title case-insensitively', () => {
    expect(searchHelpDocs(docs, '数据')).toEqual([docs[0]]);
    expect(searchHelpDocs(docs, 'oijudge')).toEqual([docs[2]]);
  });

  it('matches the category', () => {
    expect(searchHelpDocs(docs, '比赛')).toEqual([docs[1]]);
  });

  it('matches body text', () => {
    expect(searchHelpDocs(docs, '罚时')).toEqual([docs[1]]);
    expect(searchHelpDocs(docs, '子任务')).toEqual([docs[0]]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(searchHelpDocs(docs, '不存在的关键词')).toEqual([]);
  });
});

describe('groupHelpDocs', () => {
  it('orders known categories and keeps docs inside each group', () => {
    const extra = makeDoc('authoring/ai-prompts', 'AI 提示词库', '出题', '提示词。');
    const groups = groupHelpDocs([docs[1], extra, docs[2], docs[0]]);

    expect(groups.map((group) => group.category)).toEqual(['开始', '出题', '比赛']);
    expect(groups[1].docs.map((doc) => doc.slug)).toEqual([
      'authoring/ai-prompts',
      'authoring/data-plan',
    ]);
  });

  it('places unknown categories after known ones', () => {
    const groups = groupHelpDocs([
      makeDoc('misc/other', '其他', '其他'),
      makeDoc('index', 'OiJudge 帮助中心', '开始'),
    ]);

    expect(groups.map((group) => group.category)).toEqual(['开始', '其他']);
  });
});
