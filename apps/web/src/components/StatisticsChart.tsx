import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';

// 按需注册：只把统计页真正用到的图表类型打进该路由 chunk。
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface StatisticsChartProps {
  option: EChartsCoreOption;
  height?: number;
  className?: string;
  /** Fired after `setOption` so print mode can wait for the canvas. */
  onRendered?: () => void;
}

/**
 * Thin ECharts wrapper: initialises once per mount, keeps the chart in sync
 * with the option and resizes with its container via `ResizeObserver`.
 */
export function StatisticsChart({
  option,
  height = 300,
  className,
  onRendered,
}: StatisticsChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const renderedCallback = useRef(onRendered);
  renderedCallback.current = onRendered;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = echarts.init(container, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option, true);
    chart.resize();
    const frame = requestAnimationFrame(() => renderedCallback.current?.());
    return () => cancelAnimationFrame(frame);
  }, [option]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height }} />;
}
