/**
 * 視窗縮到系統匣（main 隱藏視窗）時暫停頁面上所有影音，避免在背景繼續播放。
 * 各播放器都以 pause 事件同步自己的播放狀態，這裡只需呼叫 pause()。
 */
export function installPauseOnHide(onHidden: (callback: () => void) => () => void, doc: Document = document): () => void {
  return onHidden(() => {
    doc.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => media.pause())
  })
}
