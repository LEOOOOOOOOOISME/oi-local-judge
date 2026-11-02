import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Button, Empty, Input, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { PageHead } from '../components/PageHead';
import { HELP_DOCS } from '../help/generated-help';
import { groupHelpDocs, searchHelpDocs } from '../help/search';
import type { HelpDoc } from '../help/types';
import '../styles/help.css';

const DEFAULT_DOC_SLUG = 'index';

function findDoc(docs: readonly HelpDoc[], slug: string | null): HelpDoc | null {
  if (slug) {
    const match = docs.find((doc) => doc.slug === slug);
    if (match) return match;
  }
  return docs.find((doc) => doc.slug === DEFAULT_DOC_SLUG) ?? docs[0] ?? null;
}

export function HelpPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');

  const filteredDocs = useMemo(() => searchHelpDocs(HELP_DOCS, query), [query]);
  const groups = useMemo(() => groupHelpDocs(filteredDocs), [filteredDocs]);

  const selectedDoc = useMemo(
    () => findDoc(HELP_DOCS, searchParams.get('doc')),
    [searchParams],
  );
  const selectedSlug = selectedDoc?.slug ?? null;
  const hasQuery = query.trim().length > 0;
  const noMatches = hasQuery && filteredDocs.length === 0;

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [selectedSlug]);

  const selectDoc = (slug: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('doc', slug);
    setSearchParams(next);
  };

  // 文档里的相对 .md 链接已在构建期重写为 /help?doc=<slug>；
  // 这里拦截站内链接，走客户端路由，避免整页刷新。
  const handleDocClick = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const element = event.target instanceof Element ? event.target : null;
    const anchor = element?.closest('a');
    if (!anchor || anchor.target === '_blank') return;
    const href = anchor.getAttribute('href');
    if (!href) return;

    let url: URL;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin || url.pathname !== '/help') return;
    const targetSlug = url.searchParams.get('doc');
    if (!targetSlug) return;

    event.preventDefault();
    selectDoc(targetSlug);

    if (url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      window.setTimeout(() => {
        document.getElementById(id)?.scrollIntoView();
      }, 0);
    }
  };

  return (
    <div className="help-page">
      <PageHead
        breadcrumb={[{ label: '帮助' }]}
        title="帮助中心"
        subtitle="出题、比赛、评测与排名说明；支持搜索，也可以用 ?doc= 直接打开某一篇。"
        tags={<Tag color="blue">离线文档</Tag>}
      />

      <div className="help-layout">
        <aside className="help-sidebar" aria-label="帮助文档目录">
          <Input
            className="help-search"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索标题、分类或正文"
            aria-label="搜索帮助文档"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {groups.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={hasQuery ? '没有匹配的文档' : '暂无文档'}
            />
          ) : (
            groups.map((group) => (
              <section className="help-nav-group" key={group.category}>
                <h2 className="help-nav-title">{group.category}</h2>
                <ul className="help-nav-list">
                  {group.docs.map((doc) => {
                    const active = doc.slug === selectedSlug;
                    return (
                      <li key={doc.slug}>
                        <button
                          type="button"
                          className={active ? 'help-nav-link is-active' : 'help-nav-link'}
                          aria-current={active ? 'page' : undefined}
                          title={doc.title}
                          onClick={() => selectDoc(doc.slug)}
                        >
                          {doc.title}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </aside>

        <div className="help-main">
          {noMatches ? (
            <div className="help-doc help-doc-empty">
              <Empty
                description={
                  <>
                    没有找到与 <strong>{query.trim()}</strong> 相关的文档
                  </>
                }
              >
                <Button onClick={() => setQuery('')}>清空搜索</Button>
              </Empty>
            </div>
          ) : selectedDoc ? (
            <article className="help-doc">
              <div className="help-doc-meta">
                <Tag color="blue">{selectedDoc.category}</Tag>
                <span className="help-doc-path mono">{selectedDoc.path}</span>
              </div>
              <h2 className="help-doc-title">{selectedDoc.title}</h2>
              <div
                className="help-doc-body"
                onClick={handleDocClick}
                dangerouslySetInnerHTML={{ __html: selectedDoc.html }}
              />
            </article>
          ) : (
            <div className="help-doc help-doc-empty">
              <Empty description="暂无帮助文档" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
