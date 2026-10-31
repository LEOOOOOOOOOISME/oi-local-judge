import type { ReactNode } from 'react';
import { Breadcrumb } from 'antd';
import { Link } from 'react-router-dom';

export interface Crumb {
  label: string;
  to?: string;
}

export function PageHead({
  breadcrumb,
  title,
  subtitle,
  tags,
  extra,
}: {
  breadcrumb?: Crumb[];
  title: ReactNode;
  subtitle?: ReactNode;
  tags?: ReactNode;
  extra?: ReactNode;
}) {
  const items = (breadcrumb ?? []).map((crumb) => ({
    title: crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : crumb.label,
  }));

  return (
    <div className="page-head">
      {items.length > 0 ? <Breadcrumb className="page-breadcrumb" items={items} /> : null}
      <div className="page-head-row">
        <div className="page-head-main">
          <h1 className="page-title">{title}</h1>
          {tags ? <div className="page-title-tags">{tags}</div> : null}
        </div>
        {extra ? <div className="page-head-extra">{extra}</div> : null}
      </div>
      {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
    </div>
  );
}
