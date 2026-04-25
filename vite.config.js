import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/partvault-admin/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})