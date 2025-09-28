import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  esbuild: {
    target: 'es2015'
  },
  // Use a frontend-only tsconfig to avoid backend type errors in dev
  optimizeDeps: {
    esbuildOptions: {
      tsconfig: 'tsconfig.frontend.json'
    }
  },
  server: {
    host: '::',
    port: 4302,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8888',
        changeOrigin: true
      },
      '/__proxy': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8888',
        changeOrigin: true
      },
      '/binance': {
        target: 'https://fapi.binance.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/binance/, '')
      }
    }
  },
  preview: {
    host: '::',
    port: 4302,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8888',
        changeOrigin: true
      },
      '/__proxy': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8888',
        changeOrigin: true
      },
      '/binance': {
        target: 'https://fapi.binance.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/binance/, '')
      }
    }
  }
});

