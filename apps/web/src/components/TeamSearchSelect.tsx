import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { AdminTeamSummary } from '../api/types';

export interface TeamSearchOption {
  value: number;
  label: string;
}

export interface TeamSearchSelectProps {
  value?: number | null;
  onChange?: (value: number | null) => void;
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
  disabled?: boolean;
  allowClear?: boolean;
  /**
   * 是否启用全量团队搜索（仅 admin / contestmanager 可调用）。
   * 关闭时退回 `fallbackOptions`（通常是当前用户自己的团队）。
   */
  enabled?: boolean;
  fallbackOptions?: TeamSearchOption[];
  /** 当前值不在搜索结果/兜底选项里时展示的名称。 */
  selectedLabel?: string | null;
  /** 搜索词为纯数字时，额外提供“按团队 ID 使用”选项。 */
  allowIdInput?: boolean;
  limit?: number;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * 团队选择器：管理员通过 `GET /api/admin/teams` 按名称搜索任意团队，
 * 非管理员/普通用户则只在 `fallbackOptions`（自己的团队）中本地过滤。
 */
export function TeamSearchSelect({
  value = null,
  onChange,
  placeholder = '搜索团队名称',
  style,
  className,
  disabled = false,
  allowClear = true,
  enabled = true,
  fallbackOptions = [],
  selectedLabel = null,
  allowIdInput = false,
  limit = 20,
}: TeamSearchSelectProps) {
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
    queryKey: ['admin-team-search', debouncedQuery, limit],
    queryFn: () =>
      apiGet<AdminTeamSummary[]>(
        `/api/admin/teams?query=${encodeURIComponent(debouncedQuery)}&limit=${limit}`,
      ),
    enabled: enabled && open,
    staleTime: 10_000,
    retry: false,
  });

  useEffect(() => {
    for (const team of searchQuery.data ?? []) {
      namesRef.current.set(team.id, team.name);
    }
    for (const option of fallbackOptions) {
      if (!namesRef.current.has(option.value)) {
        namesRef.current.set(option.value, option.label);
      }
    }
  }, [searchQuery.data, fallbackOptions]);

  const options = useMemo(() => {
    const seen = new Set<number>();
    const result: TeamSearchOption[] = [];
    if (enabled) {
      for (const team of searchQuery.data ?? []) {
        if (seen.has(team.id)) continue;
        seen.add(team.id);
        result.push({ value: team.id, label: team.name });
      }
    }
    for (const option of fallbackOptions) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      result.push(option);
    }
    if (allowIdInput && /^\d+$/.test(debouncedQuery)) {
      const id = Number(debouncedQuery);
      if (id > 0 && !seen.has(id)) {
        result.unshift({ value: id, label: `使用团队 ID #${id}` });
      }
    }
    if (value !== null && !seen.has(value)) {
      result.unshift({
        value,
        label: selectedLabel ?? namesRef.current.get(value) ?? `团队 #${value}`,
      });
    }
    return result;
  }, [enabled, searchQuery.data, fallbackOptions, allowIdInput, debouncedQuery, value, selectedLabel]);

  return (
    <Select<number>
      className={className}
      showSearch
      allowClear={allowClear}
      value={value ?? undefined}
      onChange={(next) => onChange?.(next ?? null)}
      onSearch={(text) => setSearchText(text)}
      onDropdownVisibleChange={(next) => setOpen(next)}
      filterOption={
        enabled
          ? false
          : (input, option) =>
              String(option?.label ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
      }
      options={options}
      loading={enabled && open && searchQuery.isFetching}
      placeholder={placeholder}
      style={style}
      disabled={disabled}
      notFoundContent={
        <span className="muted">
          {enabled
            ? searchQuery.isFetching
              ? '搜索中…'
              : searchQuery.isError
                ? '团队搜索不可用'
                : '没有匹配的团队'
            : '没有可用团队'}
        </span>
      }
    />
  );
}
