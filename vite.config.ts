import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/chess-trainer/' : '/',
  plugins: [react()],
  server: {
    // Cloudflare Tunnel assigns a different subdomain each time.
    allowedHosts: ['.trycloudflare.com'],
  },
}))
