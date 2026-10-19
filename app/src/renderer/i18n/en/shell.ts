import type { Messages } from '../index'

export const shellI18n: Messages['shellI18n'] = {
  rail: {
    library: 'Library',
    studio: 'Studio (highlights and projects)',
    studioLabel: 'Studio',
    queue: 'Analysis queue',
    shortcuts: 'Keyboard shortcuts (?)',
    shortcutsLabel: 'Shortcuts',
    settings: 'Settings',
    mainNav: 'Main navigation'
  },
  settings: { title: 'Settings' },
  shortcutsDialog: {
    title: 'Keyboard shortcuts',
    close: 'Close',
    hint: 'Press Esc to close. Characters typed in input fields do not trigger shortcuts.',
    keysLabel: 'Keys'
  },
  toastHost: { label: 'Notifications' },
  onboarding: {
    progress: '第 {n} 步，共 {total} 步',
    skip: '稍後再說',
    back: '上一步',
    next: '下一步',
    finish: '開始使用',
    saving: '儲存中…',
    welcome: {
      title: '歡迎使用 Apex Highlighter',
      body: '只要幾個簡單的設定就能開始：選擇介面語言、決定檔案存放的位置、挑選錄影方式。之後都可以在「設定」修改。',
      languageLabel: '介面語言',
      languageAuto: '跟隨系統'
    },
    storage: {
      title: '檔案要存在哪裡？',
      body: '錄影與剪輯輸出會放在同一個資料夾底下，方便整批備份或搬移。',
      current: '儲存位置',
      choose: '選擇資料夾…',
      loading: '正在取得建議位置…'
    },
    recording: {
      title: '錄影設定',
      body: '這些設定之後都能在「設定」的「錄影」分頁調整。',
      modeLabel: '錄影模式',
      modeSessionDesc: 'Apex 開著到關閉，存成一支完整的影片。',
      modeMatchDesc: '每一局存成一支影片；大廳只暫存最近約 15 秒，不佔硬碟。',
      resolution: '解析度',
      fps: '影格率',
      bitrate: '位元率（kbps）'
    },
    done: {
      title: '都設定好了',
      summaryStorage: '儲存位置：{dir}',
      summaryMode: '錄影模式：{mode}',
      summaryQuality: '畫質：{height}、{fps} fps、{bitrate} kbps',
      nextHeading: '接下來會發生的事',
      next1: '開啟 Apex Legends 後會自動開始錄影。',
      next2: '錄影結束後會自動分析，找出精彩片段。',
      next3: '到「工作室」挑選片段並輸出。'
    }
  },
  keymap: {
    scope: {
      global: 'Global',
      studio: 'Studio',
      source: 'Source timeline',
      hl: 'Highlight list',
      proj: 'Project track',
      library: 'Library',
      settings: 'Settings'
    },
    cmd: {
      play: 'Play / pause',
      speed: 'Change playback speed',
      prevEvent: 'Previous event',
      nextEvent: 'Next event',
      seekBack: 'Back 5 seconds',
      seekFwd: 'Forward 5 seconds',
      zoomIn: 'Zoom in timeline',
      zoomOut: 'Zoom out timeline',
      zoomReset: 'Reset timeline to full view',
      quickOrSplit: 'Toggle blade mode (in project preview: split at playhead)',
      blade: 'Toggle blade mode (quick clip)',
      addEvent: 'Add event',
      setStart: 'Set current clip start to playhead',
      setEnd: 'Set current clip end to playhead',
      addAllToProject: 'Add to project (all suggestions)',
      acceptSuggestion: 'Add current suggestion',
      skipSuggestion: 'Skip current suggestion',
      deleteProjectItem: 'Delete selected clip',
      duplicateItem: 'Duplicate selected clip',
      moveItemLeft: 'Move selected clip earlier',
      moveItemRight: 'Move selected clip later',
      playItem: 'Play this clip',
      undo: 'Undo',
      redo: 'Redo',
      openExport: 'Open export drawer',
      toggleAside: 'Show / hide sidebar',
      backToSource: 'Return to source mode',
      closeOverlay: 'Close overlay',
      showShortcuts: 'Keyboard shortcuts',
      focusToast: 'Focus latest notification (press Undo if available)',
      focusSearch: 'Focus search',
      toggleFavoriteFilter: 'Toggle favorites-only filter',
      selectPrevItem: 'Select previous clip',
      selectNextItem: 'Select next clip',
      listPrev: 'Previous item',
      listNext: 'Next item'
    }
  }
}
