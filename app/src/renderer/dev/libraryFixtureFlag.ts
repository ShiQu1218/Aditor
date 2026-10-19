/**
 * Development only: replace real library data with 500 synthetic entries when the URL contains ?fixture=library500.
 * Keep the flag and data separate: this small file can be statically imported, while libraryFixture.ts is loaded only through `import()`.
 * Callers use library500Requested() (including import.meta.env.DEV), so dead-code elimination removes it from production builds.
 */
export function library500Requested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === 'library500'
}
