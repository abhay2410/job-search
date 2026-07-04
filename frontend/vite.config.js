import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // SSE endpoint — must have no buffering and no timeout
      '/api/logs': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
        timeout: 0,          // no proxy timeout — keep SSE alive indefinitely
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Disable response buffering so SSE events stream immediately
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        }
      },
      // All other API routes
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
