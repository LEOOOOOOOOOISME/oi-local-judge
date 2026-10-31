import type { ReactNode } from 'react';

export interface MetaItem {
  label: ReactNode;
  value: ReactNode;
}

/** 紧凑的键值信息列表（替代 Descriptions，控制密度）。 */
export function MetaList({ items }: { items: MetaItem[] }) {
  return (
    <dl className="meta-list">
      {items.map((item, index) => (
        <div className="meta-row" key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
