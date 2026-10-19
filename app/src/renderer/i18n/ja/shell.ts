import type { Messages } from '../index'

export const shellI18n: Messages['shellI18n'] = {
  rail: {
    library: 'ライブラリ',
    studio: 'Studio（ハイライト＋プロジェクト）',
    studioLabel: 'Studio',
    queue: '分析キュー',
    shortcuts: 'ショートカット (?)',
    shortcutsLabel: 'ショートカット',
    settings: '設定',
    mainNav: 'メインナビゲーション'
  },
  settings: { title: '設定' },
  shortcutsDialog: {
    title: 'ショートカット一覧',
    close: '閉じる',
    hint: 'Esc で閉じます。入力欄に文字を入力している間は、ショートカットは発動しません。',
    keysLabel: 'キー'
  },
  toastHost: { label: '通知' },
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
      global: '全体',
      studio: 'Studio',
      source: 'ソースタイムライン',
      hl: 'ハイライト一覧',
      proj: 'プロジェクトトラック',
      library: 'ライブラリ',
      settings: '設定'
    },
    cmd: {
      play: '再生／一時停止',
      speed: '再生速度を切り替え',
      prevEvent: '前のイベント',
      nextEvent: '次のイベント',
      seekBack: '5 秒戻る',
      seekFwd: '5 秒進む',
      zoomIn: 'タイムラインを拡大',
      zoomOut: 'タイムラインを縮小',
      zoomReset: 'タイムライン全体を表示',
      quickOrSplit: 'ブレードモードを切り替え（プロジェクトプレビュー中は再生ヘッドの位置で分割）',
      blade: 'ブレードモードを切り替え（クイッククリップ）',
      addEvent: 'イベントを追加',
      setStart: '現在のクリップの開始を再生ヘッドに設定',
      setEnd: '現在のクリップの終了を再生ヘッドに設定',
      addAllToProject: 'プロジェクトに追加（すべての提案）',
      acceptSuggestion: '現在の提案を追加',
      skipSuggestion: '現在の提案をスキップ',
      deleteProjectItem: '選択したクリップを削除',
      duplicateItem: '選択したクリップを複製',
      moveItemLeft: '選択したクリップを前へ移動',
      moveItemRight: '選択したクリップを後ろへ移動',
      playItem: 'そのクリップを再生',
      undo: '元に戻す',
      redo: 'やり直す',
      openExport: '書き出しドロワーを開く',
      toggleAside: 'サイドバーの表示／非表示',
      backToSource: 'ソースモードに戻る',
      closeOverlay: 'オーバーレイを閉じる',
      showShortcuts: 'ショートカット一覧',
      focusToast: '最新の通知にフォーカス（「元に戻す」 を押せます）',
      focusSearch: '検索にフォーカス',
      toggleFavoriteFilter: 'お気に入りのみ表示を切り替え',
      selectPrevItem: '前のクリップを選択',
      selectNextItem: '次のクリップを選択',
      listPrev: '前の項目',
      listNext: '次の項目'
    }
  }
}
