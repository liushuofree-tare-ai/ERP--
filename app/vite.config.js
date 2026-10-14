import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import react from '@vitejs/plugin-react';

// 两种构建形态（环境变量 SINGLE_FILE 控制，默认单机单文件）：
// · SINGLE_FILE=1（默认）：单 HTML——用户双击即可用，沿用单机用法
// · SINGLE_FILE=0：服务器模式——代码分割 + 资源 hash，配合
//   server/（Fastify + node:sqlite）与 Nginx，首屏与缓存显著更好
const single = process.env.SINGLE_FILE !== '0';

export default defineConfig({
  plugins: [react(), ...(single ? [viteSingleFile()] : [])],
  base: './',
  build: {
    assetsInlineLimit: single ? 100000000 : 4096,
    chunkSizeWarningLimit: 100000,
    rollupOptions: single ? undefined : { output: { manualChunks: undefined } },
  },
  server: {
    proxy: { '/api': 'http://localhost:3100' },
  },
});
