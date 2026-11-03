import type { AwardConfig, AwardCounts, AwardLevel, AwardRow } from '../api/types';

/** 奖项排序固定为金、银、铜，供统计与筛选项复用。 */
export const AWARD_LEVELS: readonly AwardLevel[] = ['gold', 'silver', 'bronze'] as const;

export const AWARD_LABELS: Record<AwardLevel, string> = {
  gold: '金牌',
  silver: '银牌',
  bronze: '铜牌',
};

/** AntD Tag 颜色：金牌用 gold，银牌用默认，铜牌用 orange。 */
export const AWARD_COLORS: Record<AwardLevel, string> = {
  gold: 'gold',
  silver: 'default',
  bronze: 'orange',
};

export function awardLabel(award: AwardLevel | null): string {
  return award === null ? '未获奖' : AWARD_LABELS[award];
}

export function awardColor(award: AwardLevel | null): string {
  return award === null ? 'default' : AWARD_COLORS[award];
}

/**
 * 与后端 `computeAwardCounts` 保持一致的前端镜像，用于管理员调整比例时
 * 在保存前即时预览人数。非零比例至少分配 1 人，且三段累计不超过总人数。
 */
export function computeAwardCounts(n: number, config: AwardConfig): AwardCounts {
  const total = Math.max(0, Math.floor(n));
  const allocate = (percent: number, remaining: number): number => {
    if (!(percent > 0) || remaining <= 0) return 0;
    return Math.min(Math.max(1, Math.round((total * percent) / 100)), remaining);
  };
  const gold = allocate(config.goldPercent, total);
  const silver = allocate(config.silverPercent, total - gold);
  const bronze = allocate(config.bronzePercent, total - gold - silver);
  return { gold, silver, bronze, total: gold + silver + bronze };
}

/** 奖项配置是否合法：三项均在 0..100，且总和不超过 100。 */
export function isValidAwardConfig(config: AwardConfig): boolean {
  const values = [config.goldPercent, config.silverPercent, config.bronzePercent];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    return false;
  }
  return values.reduce((sum, value) => sum + value, 0) <= 100;
}

export type AwardFilterValue = AwardLevel | 'none' | 'all';

export interface AwardRowFilter {
  keyword?: string;
  award?: AwardFilterValue;
  className?: string | null;
}

/** 奖项表筛选：关键字匹配用户名/姓名/班级/证书编号，可再按奖项与班级过滤。 */
export function filterAwardRows(rows: readonly AwardRow[], filter: AwardRowFilter): AwardRow[] {
  const keyword = filter.keyword?.trim().toLowerCase() ?? '';
  const award = filter.award ?? 'all';
  const className = filter.className ?? null;
  return rows.filter((row) => {
    if (award !== 'all') {
      if (award === 'none' ? row.award !== null : row.award !== award) return false;
    }
    if (className !== null && row.className !== className) return false;
    if (keyword === '') return true;
    const haystack = [
      row.username,
      row.realName ?? '',
      row.className ?? '',
      row.certificateNo,
    ]
      .join('\n')
      .toLowerCase();
    return haystack.includes(keyword);
  });
}

function escapeCsvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出奖项成绩单 CSV（UTF-8 BOM + CRLF），可用 Excel 直接打开。 */
export function buildAwardsCsv(rows: readonly AwardRow[]): string {
  const header = ['名次', '用户名', '姓名', '班级', '总分', '解出题数', '奖项', '证书编号'];
  const lines = [
    header.map(escapeCsvCell).join(','),
    ...rows.map((row) =>
      [
        row.rank,
        row.username,
        row.realName,
        row.className,
        row.totalScore,
        row.solved,
        awardLabel(row.award),
        row.certificateNo,
      ]
        .map(escapeCsvCell)
        .join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 文件名中不允许出现的字符替换为下划线。 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'awards';
}

/** 触发浏览器下载 CSV；仅用于浏览器环境。 */
export function downloadCsvFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 证书日期：优先使用比赛结束时间，缺失时退回当前时间。 */
export function formatCertificateDate(
  value: number | null | undefined,
  now = Date.now(),
): string {
  const time = value ?? now;
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
