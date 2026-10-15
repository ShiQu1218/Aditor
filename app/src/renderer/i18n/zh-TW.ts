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
    importFolder: '匯入資料夾',
    searchPlaceholder: '依檔名搜尋',
    chips: {
      all: '全部',
      favorite: '收藏',
      knock: '含擊倒',
      assist: '含助攻',
      hl: '有精華',
      isNew: '新'
    },
    date: {
      today: '今天',
      yesterday: '昨天',
      /** 其他日期：2026 年 10 月 13 日 */
      header: '{y} 年 {m} 月 {d} 日'
    },
    videoCount: '{n} 支影片',
    empty: {
      title: '把 Apex 錄影拖進來',
      desc: '支援 mp4 / mkv / mov / webm。新影片會自動排入分析，一次分析一支。',
      step1Title: '匯入',
      step1Desc: '拖放檔案，或指定監看資料夾',
      step2Title: '自動分析',
      step2Desc: '標出擊倒、助攻與多殺精華',
      step3Title: '挑選匯出',
      step3Desc: '確認精華、微調、匯出',
      openSettings: '設定監看資料夾'
    },
    noResults: {
      title: '沒有符合條件的影片',
      desc: '請嘗試調整搜尋關鍵字或篩選條件。'
    },
    drop: {
      title: '放開滑鼠以匯入影片',
      desc: '將加入影片庫並自動排入分析'
    },
    card: {
      noThumb: '無縮圖',
      waiting: '等待分析',
      waitingQueue: '排在佇列中',
      analyzing: '分析中',
      progressText: '分析中 {n}%',
      openBlocked: '分析完成後才能開啟',
      error: '分析失敗',
      retry: '重試',
      remove: '從影片庫移除',
      more: '更多動作',
      reanalyze: '重新分析',
      favoriteAdd: '加入收藏',
      favoriteRemove: '取消收藏',
      hlCount: '{n} 精華',
      knockBadge: '擊倒 {n}',
      assistBadge: '助攻 {n}',
      av1: 'AV1 · 建議代理檔',
      proxySuggest: '建議代理檔',
      removeConfirm: '確定要從影片庫移除「{name}」嗎？（不會刪除影片檔案）'
    }
  },
  timeline: {
    densityHint: '密度檢視 · {n} 個事件 · 放大（Ctrl +／滾輪）顯示個別圖示',
    spectating: '觀戰（不計入）',
    clipAi: 'AI',
    types: {
      knock: '擊倒',
      assist_knock: '助攻擊倒',
      assist_elim: '助攻消滅',
      elim: '已消滅',
      squad_wipe: '小隊抹殺'
    },
    counted: '計入',
    uncounted: '不計入',
    reasons: {
      first: '首次',
      duplicate: '重複敵人',
      spectating: '觀戰中',
      not_counting_type: '小隊抹殺不計',
      manual: '手動'
    },
    forced: '強制',
    densityTip: '{n} 個事件 · {time}（計入 {c}）',
    clusterTip: '{n} 個事件 · {from}–{to} · 點擊放大'
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
  keymap: {
    scope: {
      global: '全域',
      studio: '工作室',
      source: '來源時間軸',
      hl: '精華清單',
      ev: '事件清單',
      proj: '專案軌',
      library: '影片庫',
      settings: '設定'
    },
    cmd: {
      play: '播放／暫停',
      speed: '切換播放速度',
      prevEvent: '上一個事件',
      nextEvent: '下一個事件',
      seekBack: '倒退 5 秒',
      seekFwd: '前進 5 秒',
      zoomIn: '時間軸放大',
      zoomOut: '時間軸縮小',
      zoomReset: '時間軸縮放重設',
      quickOrSplit: '快速剪輯（專案模式：在播放頭分割）',
      addEvent: '新增事件',
      setStart: '目前片段起點＝播放頭',
      setEnd: '目前片段終點＝播放頭',
      supercut: '選取事件建立合輯',
      addAllToProject: '加入專案（全部建議）',
      acceptSuggestion: '加入目前建議',
      skipSuggestion: '略過目前建議',
      deleteSelectedEvents: '刪除選取事件',
      deleteProjectItem: '刪除選取片段',
      duplicateItem: '複製選取片段',
      moveItemLeft: '選取片段往前移',
      moveItemRight: '選取片段往後移',
      playItem: '播放該片段',
      undo: '復原',
      redo: '重做',
      saveProjectFile: '另存專案檔',
      openExport: '開啟匯出抽屜',
      toggleAside: '顯示／隱藏側欄',
      backToSource: '返回來源模式',
      closeOverlay: '關閉浮層／清除選取',
      showShortcuts: '快捷鍵說明',
      focusSearch: '聚焦搜尋',
      toggleFavoriteFilter: '切換只顯示收藏',
      seekSelectedEvent: '跳到選取事件',
      selectPrevItem: '選取上一個片段',
      selectNextItem: '選取下一個片段',
      listPrev: '上一項',
      listNext: '下一項'
    }
  },
  legacyEditor: '舊專案編輯'
}
