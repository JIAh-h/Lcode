import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 渲染进程构建（D3：React + Vite）。产物在 dist/renderer。
// root 用绝对路径（相对 CWD 无关，从任何目录启动都能找到入口）。
const rendererRoot = fileURLToPath(new URL('./renderer', import.meta.url))

export default defineConfig({
  root: rendererRoot,
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': rendererRoot,
    },
  },
})
