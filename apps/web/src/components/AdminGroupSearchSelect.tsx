import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { AdminGroupSummary, TrainingPlanGroupKind } from '../api/types';
import { adminGroupOptionLabel, adminGroupsPath } from '../utils/trainingPlans';

export interface AdminGroupSearchOption {
  value: number;
  label: string;
}

export interface AdminGroupSearchSelectProps {
  /** Form.Item 注入的控件 id，用于 label 关联。 */
  id?: string;
  value?: number | null;
  onChange?: (value: number | null) => void;
  /** 只搜索某一类组；省略时同时搜索班级与团队。 */
  kind?: TrainingPlanGroupKind;
  limit?: number;
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
  disabled?: boolean;
  allowClear?: boolean;
  /** 当前值不在搜索结果里时展示的名称（否则回退到最近一次搜索到的名称）。 */
  selectedLabel?: string | null;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * 管理员/比赛管理员的全量班级/团队选择器。
 *
 * 通过 `GET /api/admin/groups` 远程搜索任意班级与团队；选项标签带“班级/团队”
 * 前缀。即使之后的搜索不再包含当前已选项，也会保留其标签（`namesRef`），
 * 避免选择器退回裸 id。
 */
export function AdminGroupSearchSelect({
  id,
  value = null,
  onChange,
  kind,
  limit = 20,
  placeholder = '搜索班级或团队名称',
  style,
  className,
  disabled = false,
  allowClear = true,
  selectedLabel = null,
}: AdminGroupSearchSelectProps) {
  const [searchText, setSearchText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [open, setOpen] = useState(false);
  const namesRef = useRef(new Map<number, string>());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchText.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const searchQuery = useQuery({
    queryKey: ['admin-group-search', kind ?? 'all', debouncedQuery, limit],
    queryFn: () =>
      apiGet<AdminGroupSummary[]>(
        adminGroupsPath({ kind, query: debouncedQuery, limit }),
      ),
    enabled: open,
    staleTime: 10_000,
    retry: false,
  });

  useEffect(() => {
    for (const group of searchQuery.data ?? []) {
      namesRef.current.set(group.id, adminGroupOptionLabel(group));
    }
  }, [searchQuery.data]);

  const options = useMemo(() => {
    const seen = new Set<number>();
    const result: AdminGroupSearchOption[] = [];
    for (const group of searchQuery.data ?? []) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      result.push({ value: group.id, label: adminGroupOptionLabel(group) });
    }
    if (value !== null && !seen.has(value)) {
      result.unshift({
        value,
        label:
          selectedLabel ??
          namesRef.current.get(value) ??
          `班级/团队 #${value}`,
      });
    }
    return result;
  }, [searchQuery.data, value, selectedLabel]);

  return (
    <Select<number>
      id={id}
      className={className}
      showSearch
      allowClear={allowClear}
      value={value ?? undefined}
      onChange={(next) => onChange?.(next ?? null)}
      onSearch={(text) => setSearchText(text)}
      onDropdownVisibleChange={(next) => setOpen(next)}
      filterOption={false}
      options={options}
      loading={open && searchQuery.isFetching}
      placeholder={placeholder}
      style={style}
      disabled={disabled}
      notFoundContent={
        <span className="muted">
          {searchQuery.isFetching
            ? '搜索中…'
            : searchQuery.isError
              ? '班级/团队搜索不可用'
              : '没有匹配的班级或团队'}
        </span>
      }
    />
  );
}
