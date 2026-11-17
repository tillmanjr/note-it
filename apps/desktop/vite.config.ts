import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed dev port and must not have Vite clear its console output.
  clearScreen: false,
  server: { port: 5318, strictPort: true },
  // The SQLite WASM build (browser dev mode) loads its .wasm relative to its own module.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
})
