import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { cspPlugin } from './src/shared/csp'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { loadEnv } from 'vite'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }
// The ignored file lets a separate build process use a token configured in another shell.
const sentryBuildEnv = loadEnv('sentry-build-plugin', __dirname, 'SENTRY_')
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || sentryBuildEnv.SENTRY_AUTH_TOKEN

// Explicit build-time opt-in: maps embed application source and require a private upload token.
const uploadMaps = process.env.SENTRY_UPLOAD_SOURCEMAPS === '1'
if (uploadMaps && !sentryAuthToken) throw new Error('SENTRY_AUTH_TOKEN is required for source-map upload')
const sentryPlugins = (target: string) => uploadMaps ? [sentryVitePlugin({
  org: 'luis12182', project: 'aditor-desktop', authToken: sentryAuthToken,
  telemetry: false,
  release: { name: `aditor@${pkg.version}`, create: false, finalize: false },
  sourcemaps: { assets: [`./out/${target}/**/*.js`, `./out/${target}/**/*.map`] }
})] : []

export default defineConfig({
  main: {
    build: { sourcemap: 'hidden' },
    plugins: [externalizeDepsPlugin(), ...sentryPlugins('main')],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    build: { sourcemap: 'hidden' },
    plugins: [externalizeDepsPlugin(), ...sentryPlugins('preload')],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    build: { sourcemap: 'hidden' },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    // Used by the version row in Settings; when undefined in tests, the row shows only the name.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [react(), cspPlugin(), ...sentryPlugins('renderer')]
  }
})
