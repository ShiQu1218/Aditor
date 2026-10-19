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
