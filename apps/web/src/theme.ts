import type { ThemeConfig } from 'antd';

export const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

/** 中性灰 + 单一强调色（蓝），紧凑尺寸，无渐变。 */
export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563eb',
    colorLink: '#2563eb',
    colorInfo: '#2563eb',
    colorSuccess: '#16a34a',
    colorWarning: '#d97706',
    colorError: '#dc2626',
    colorText: '#1f2328',
    colorTextSecondary: '#5c6672',
    colorTextTertiary: '#8a94a0',
    colorBorder: '#d9dee5',
    colorBorderSecondary: '#e6e9ee',
    colorBgLayout: '#f4f5f7',
    colorBgContainer: '#ffffff',
    borderRadius: 4,
    fontSize: 13,
    controlHeight: 30,
    fontFamily,
    wireframe: false,
  },
};
