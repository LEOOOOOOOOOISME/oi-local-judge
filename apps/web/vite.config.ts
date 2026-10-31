import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Windows 上系统临时目录可能被安全软件占用，esbuild 清理临时文件时报 EACCES，
// 导致构建在最后阶段失败。把 esbuild 临时目录固定到工程内，保证构建可重复。
if (process.platform === 'win32') {
  const esbuildTmp = join(process.cwd(), '.vite-tmp');
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
  },
});
