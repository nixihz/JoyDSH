import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  optimizeDeps: {
    exclude: ['@joydsh/focus', '@joydsh/input'],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:43127',
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on('proxyReq', proxyRequest => proxyRequest.removeHeader('origin'))
          proxy.on('proxyReqWs', proxyRequest => proxyRequest.removeHeader('origin'))
        },
      },
    },
  },
})
