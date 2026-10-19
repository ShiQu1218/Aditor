// The only allowlist for color literals (used by noRawColors.test.ts).
// Design rule: TSX/TS must not contain #hex, rgb(), rgba(), or hsl() literals; colors come from CSS variables in tokens.css.
// (The canvas theme is read from CSS variables at runtime by readTheme in timeline/draw.ts.)
// Add { file, reason } here only when an exception is needed; each listed file must contain a color literal or the test fails for a stale entry.
export interface RawColorException {
/** Path relative to app/src/renderer, using /. */
  file: string
  reason: string
}

export const RAW_COLOR_ALLOWLIST: readonly RawColorException[] = []
