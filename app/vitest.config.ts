import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    globals: true,
    // Real-ffmpeg tests take several seconds on slow CI runners; the 5s default flaked there.
    testTimeout: 30_000,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}']
  }
})
