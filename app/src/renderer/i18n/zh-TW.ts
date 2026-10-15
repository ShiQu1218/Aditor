export const i18n = {
  appTitle: 'Apex Highlighter',
  nav: {
    library: '影片庫',
    viewer: '檢視器',
    editor: '剪輯專案'
  },
  library: {
    title: '影片庫',
    importFiles: '匯入影片',
    importFolder: '選擇資料夾',
    watchFolder: '設定監看資料夾',
    searchPlaceholder: '搜尋影片名稱 (Ctrl+F)',
    favoriteFilter: '只顯示收藏 (Ctrl+D)',
    filterAll: '全部事件',
    filterKnock: '含擊倒',
    filterAssist: '含助攻',
    emptyTitle: '尚未匯入任何影片',
    emptyDesc: '拖放 Apex Legends 錄影檔到此處，或點擊上方按鈕匯入。',
    status: {
      pending: '等待分析',
      analyzing: '分析中',
      done: '分析完成',
      error: '分析失敗'
    },
    badges: {
      knock: '擊倒',
      assist: '助攻'
    }
  },
  viewer: {
    back: '返回影片庫',
    events: '事件清單',
    clips: '片段清單',
    noEvents: '無偵測事件',
    noClips: '無建立片段',
    autoClip: 'AI 自動剪輯',
    createSupercut: '建立合輯',
    sendToProject: '傳送至專案 (Ctrl+E)',
    addEvent: '新增事件 (M)',
    quickClip: '快速剪輯 (Ctrl+Q)',
    speed: '速度',
    zoomIn: '放大 (Ctrl +)',
    zoomOut: '縮小 (Ctrl -)',
    zoomReset: '重設縮放 (Ctrl 0)',
    overrideCount: '計入統計',
    overrideUncount: '不計入',
    overrideAuto: '自動判定',
    deleteEvent: '刪除事件',
    suggestProxyTitle: '播放可能不流暢',
    suggestProxyDesc: '偵測到您的系統解碼效能較低，建議產生代理檔以獲得更流暢的預覽。',
    generateProxy: '產生代理檔'
  },
  editor: {
    title: '剪輯專案',
    empty: '專案內尚無片段，請在檢視器中選取片段後按 Ctrl+E 加入。',
    export: '匯出影片',
    split: '分割片段',
    delete: '刪除',
    duplicate: '複製',
    undo: '復原 (Ctrl+Z)',
    redo: '重做 (Ctrl+Y)',
    saveProject: '儲存專案',
    loadProject: '載入專案'
  },
  export: {
    title: '匯出專案',
    mode: '匯出模式',
    modeSeparate: '每段各一檔',
    modeConcat: '串成一支合輯',
    quality: '品質模式',
    qualityCopy: '快速無損 (-c copy)',
    qualityPrecise: '精準重新編碼',
    extraSecondsNotice: '快速無損會從關鍵影格切除，片段可能多出約 {sec} 秒。',
    fallbackReencodeNotice: '來源影片參數不一致，已自動改用精準重新編碼。',
    outputDir: '輸出資料夾',
    baseName: '輸出檔名',
    startExport: '開始匯出',
    cancel: '取消',
    exporting: '匯出中...',
    complete: '匯出完成！'
  }
}

export const shellI18n = {
  rail: {
    library: '影片庫',
    studio: '工作室（精華＋專案）',
    studioLabel: '工作室',
    queue: '分析佇列',
    shortcuts: '快捷鍵 (?)',
    shortcutsLabel: '快捷鍵',
    settings: '設定',
    mainNav: '主要導覽'
  },
  settings: { title: '設定', placeholder: '設定頁面即將推出。' },
  legacyEditor: '舊專案編輯'
}
