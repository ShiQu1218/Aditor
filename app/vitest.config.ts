import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Placeholder so telemetry tests see a configured DSN; release builds inject the real one.
  define: { __SENTRY_DSN__: JSON.stringify('https://public@example.ingest.sentry.io/1') },
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
