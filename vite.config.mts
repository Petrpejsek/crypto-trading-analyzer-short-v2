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
    host: '127.0.0.1',
    port: 4203,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3081',
        changeOrigin: true
      },
      '/__proxy': {
        target: 'http://127.0.0.1:3081',
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
    host: '127.0.0.1',
    port: 4203,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3081',
        changeOrigin: true
      },
      '/__proxy': {
        target: 'http://127.0.0.1:3081',
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

