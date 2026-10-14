import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 构建成单个 HTML：用户双击即可打开，不需要服务器（沿用旧项目的打开方式）
// 两种形态：
//  · 单机模式（file:// 打开）：所有存储走浏览器本地（localStorage + IndexedDB）
//  · 云端模式（http(s) 打开且 /api/health 通）：本地镜像 + 服务器事实源
// dev 服务器把 /api 代理到后端（server/），npm run dev + npm run dev(server) 联调
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: { assetsInlineLimit: 100000000, chunkSizeWarningLimit: 100000 },
  server: {
    proxy: { '/api': 'http://localhost:3100' },
  },
});
