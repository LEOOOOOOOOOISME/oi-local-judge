import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Windows 上系统临时目录可能被安全软件占用，esbuild 清理临时文件时报 EACCES，
// 导致构建在最后阶段失败。把 esbuild 临时目录固定到工程内，保证构建可重复。
// 隔离发布构建再用 OIJ_VITE_TMP 指向 release/ 下的临时目录：临时 worktree
// 位于系统 %TEMP% 时，esbuild 在 %TEMP% 里删除临时文件会被拒绝。
if (process.platform === 'win32') {
  const esbuildTmp = process.env.OIJ_VITE_TMP || join(process.cwd(), '.vite-tmp');
  try {
    mkdirSync(esbuildTmp, { recursive: true });
    process.env.TMP = esbuildTmp;
    process.env.TEMP = esbuildTmp;
  } catch {
    // 建目录失败时退回系统临时目录。
  }
}

/**
 * 开发服务器把浏览器请求代理到本地后端。
 * 后端默认端口 8790（OIJ_PORT=8790）。
 */
const backendHttp = 'http://127.0.0.1:8790';
const backendWs = 'ws://127.0.0.1:8790';

const proxy = {
  '/api': {
    target: backendHttp,
    changeOrigin: false,
  },
  '/ws': {
    target: backendWs,
    ws: true,
    changeOrigin: false,
  },
};

/**
 * 首屏即用到的 antd 组件（登录页、AppShell、通用状态组件）才放进 antd-vendor。
 * Table/Tabs/Select 等只在懒加载页面里用到的组件交给 Rollup 跟随路由拆包，
 * 否则整个 antd 会被打进首屏，抵消路由懒加载的收益。
 */
const ANTD_CORE_PATHS = [
  '/node_modules/antd/es/_util/',
  '/node_modules/antd/es/app/',
  '/node_modules/antd/es/avatar/',
  '/node_modules/antd/es/button/',
  '/node_modules/antd/es/card/',
  '/node_modules/antd/es/config-provider/',
  '/node_modules/antd/es/divider/',
  '/node_modules/antd/es/dropdown/',
  '/node_modules/antd/es/form/',
  '/node_modules/antd/es/grid/',
  '/node_modules/antd/es/input/',
  '/node_modules/antd/es/locale/',
  '/node_modules/antd/es/message/',
  '/node_modules/antd/es/modal/',
  '/node_modules/antd/es/notification/',
  '/node_modules/antd/es/result/',
  '/node_modules/antd/es/space/',
  '/node_modules/antd/es/spin/',
  '/node_modules/antd/es/style/',
  '/node_modules/antd/es/theme/',
  '/node_modules/antd/es/typography/',
  '/node_modules/@ant-design/',
  '/node_modules/@emotion/',
  '/node_modules/stylis/',
];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      // DSH / 编辑器原子保存会在源码目录生成隐藏临时目录，watcher 打开后会被锁住。
      ignored: ['**/node_modules/**', '**/.git/**', '**/.*.tmpdir/**', '**/.vite-tmp/**'],
    },
    proxy,
  },
  // `vite preview` 也代理到同一后端，方便直接验证 dist 产物。
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        /**
         * vendor 分包：
         * - react / router / query 单独成块，缓存稳定；
         * - antd 的首屏组件单独成块（antd-vendor），懒加载页面才用到的
         *   Table/Tabs/Select 等交给 Rollup 跟随路由自动拆包。
         * 其余 node_modules 交给 Rollup 按真实引用关系自动拆分，避免把所有
         * 懒加载页面才用到的依赖提前打进首屏。
         */
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) return undefined;

          if (
            normalized.includes('/node_modules/react/') ||
            normalized.includes('/node_modules/react-dom/') ||
            normalized.includes('/node_modules/scheduler/') ||
            normalized.includes('/node_modules/react-is/')
          ) {
            return 'react-vendor';
          }
          if (normalized.includes('/node_modules/react-router')) return 'router-vendor';
          if (normalized.includes('/node_modules/@tanstack/')) return 'query-vendor';
          if (ANTD_CORE_PATHS.some((path) => normalized.includes(path))) return 'antd-vendor';
          return undefined;
        },
      },
    },
  },
});
