import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 构建成单个 HTML：用户双击即可打开，不需要服务器（沿用旧项目的打开方式）
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: { assetsInlineLimit: 100000000, chunkSizeWarningLimit: 100000 }
});
