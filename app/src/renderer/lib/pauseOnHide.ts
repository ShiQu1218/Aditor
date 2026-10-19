/**
 * Pause all media on the page when the window is minimized or sent to the system tray, preventing background playback.
 * Each player syncs its playback state through the pause event, so this only needs to call pause().
 */
export function installPauseOnHide(onHidden: (callback: () => void) => () => void, doc: Document = document): () => void {
  return onHidden(() => {
    doc.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => media.pause())
  })
}
