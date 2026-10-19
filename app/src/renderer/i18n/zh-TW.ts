/** Traditional Chinese (source language): defines keys and placeholders for other languages. */
const i18n = {
  lowPerf: {
    askText: '偵測到此電腦沒有硬體解碼，要開啟低效能模式嗎？',
    enable: '開啟',
    dismiss: '不用了'
  },
  appTitle: 'Aditor',
  nav: {
    library: '影片庫',
    viewer: '檢視器',
    editor: '剪輯專案'
  },
  /** Main-process native dialogs (titles and file type filters) */
  dialog: {
    selectFilesTitle: '選擇 Apex Legends 錄影檔案',
    videoFilter: '影片檔案',
    selectFolderTitle: '選擇包含錄影的資料夾',
    addWatchFolderTitle: '選擇要監看的資料夾（新影片自動匯入）',
    selectOutDirTitle: '選擇匯出目標資料夾'
  },
  library: {
    title: '影片庫',
    corruptNotice: '影片庫檔案已損毀，已備份為 {path}，並建立新的影片庫。',
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
      /** Other dates: October 13, 2026 */
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
      notAnalyzed: '尚未分析',
      notAnalyzedHint: '按〔分析〕後才會排入佇列',
      analyze: '分析',
      notAnalyzedToast: '這支影片尚未分析，請先按卡片上的〔分析〕',
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
  queue: {
    title: '分析佇列',
    oneAtATime: '一次分析一支',
    analyzing: '正在分析 {i}/{n}',
    queuedOnly: '等待分析 {n} 支',
    analyzingPct: '分析中 {n}%',
    view: '檢視佇列',
    cancel: '取消',
    empty: '沒有進行中的分析',
    waiting: '等待分析'
  },
  timeline: {
    zoomToolbar: '來源時間軸縮放',
    zoomModes: { full: '全覽縮放', detail: '細節縮放', custom: '自訂縮放' },
    zoomTips: {
      full: '整部影片填滿時間軸（Ctrl+0）',
      detail: '以播放頭為中心顯示 30 秒，播放時跟隨',
      custom: '以播放頭為中心縮放；拖曳滑桿、滾輪或 Ctrl+＋／－ 調整，Shift+滾輪左右平移'
    },
    customZoom: '自訂縮放倍率',
    scrollbar: '來源時間軸水平捲動',
    bladeHint: '刀片模式（B）：點兩下決定片段起訖並加入專案；Esc 取消標記，再按一次離開',
    bladeTooShort: '片段至少需要 0.5 秒，請重新選擇終點',
    densityHint: '密度檢視 · {n} 個事件 · 放大（滾輪／Ctrl +）顯示個別圖示',
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
    clips: '片段清單',
    noEvents: '無偵測事件',
    noClips: '無建立片段',
    autoClip: 'AI 自動剪輯',
    sendToProject: '傳送至專案 (Ctrl+E)',
    addEvent: '新增事件 (M)',
    quickClip: '快速剪輯 (Ctrl+Q)',
    speed: '速度',
    zoomIn: '放大 (Ctrl +)',
    zoomOut: '縮小 (Ctrl -)',
    zoomReset: '重設縮放 (Ctrl 0)',
    suggestProxyTitle: '播放可能不流暢',
    suggestProxyDesc: '偵測到您的系統解碼效能較低，建議產生代理檔以獲得更流暢的預覽。',
    generateProxy: '產生代理檔'
  },
  studio: {
    back: '返回影片庫',
    empty: '尚未有影片，先到影片庫加入或錄一場',
    libraryReadFailed: '無法讀取影片庫，請稍後重試。',
    sameDay: {
      label: '同日影片',
      count: '{n} 部影片',
      collapse: '收合同日影片',
      expand: '展開同日影片',
      saveFailed: '收合偏好儲存失敗，請稍後再試。'
    },
    openBlocked: '分析完成後才能開啟',
    statusDone: '分析完成',
    autoClip: 'AI 自動剪輯',
    quickClip: '快速剪輯',
    quickClipKey: 'B',
    export: '匯出',
    exportCount: '匯出 ({n})',
    asideToggle: '切換側欄',
    asideShow: '顯示側欄',
    asideHide: '隱藏側欄',
    mode: {
      source: '來源',
      project: '專案預覽',
      item: '片段 {i}/{n}',
      spectating: '觀戰中'
    },
    recentCounted: '近 90 秒計入 {n}',
    notices: {
      engineErrorTitle: '分析引擎異常結束',
      engineErrorText: '分析引擎異常結束（代碼 {code}）。不會遺失已完成進度，可接續分析。',
      resume: '接續分析',
      copyError: '複製錯誤訊息',
      proxyTitle: '播放可能不流暢',
      proxyText: '此影片非硬體解碼或格式支援有限，建議產生代理檔以獲得流暢預覽。',
      proxyGenerate: '產生代理檔',
      proxyGenerating: '產生中… {n}%',
      proxyBusy: '正在產生代理檔…',
      proxyLater: '稍後再說',
      videoMissingTitle: '影片無法播放',
      videoMissingText: '找不到或無法播放此影片檔案，請重新連結或返回影片庫。',
      relink: '重新連結檔案',
      back: '返回影片庫',
      noEventsTitle: '這支影片沒有偵測到擊倒／助攻',
      noEventsText: '可按 M 手動新增；若錄影是舊版遊戲或 HUD 縮放很小，偵測可能找不到橫幅。'
    },
    toast: {
      added: '已加入專案',
      alreadyInProject: '專案已有此片段',
      relinkHint: '已回到影片庫：請移除失效的項目後，重新匯入檔案所在的位置。',
      projectRestoreCorrupt: '上次的專案檔已損毀，已保留備份並建立新專案。備份保留在專案自動儲存目錄。',
      projectRestoreUnsupported: '上次的專案檔來自較新的版本，無法開啟；已建立新專案，原檔未被變更。',
      addedProject: '已加入專案（{sec} 秒）',
      skipped: '已略過這段建議',
      removedFromProject: '已移出專案片段',
      undo: '復原',
      copied: '已複製錯誤訊息',
      deletedItem: '已刪除專案片段',
      addExternalFailed: '加入外部影片失敗，請稍後重試',
      externalVideoIncomplete: '影片已保留於影片庫，但無法排入分析或取得長度：{names}',
      analysisRefreshFailed: '無法更新分析結果，請重新開啟影片',
      sourceSaveFailed: '來源編輯儲存失敗，請稍後再切換影片',
      newProject: '已建立新專案；舊專案已保留在自動儲存目錄',
      noSuggestions: '沒有待加入的片段',
      splitHint: '請先在專案軌選取片段，並把播放頭移到片段內部',
      sourceOnlyEdit: '回到來源後才能編輯事件'
    },
    meta: {
      events: '{n} 個事件'
    },
    live: {
      event: '{type} · {time}',
      playhead: '播放頭 {time}',
      zoomIn: '時間軸放大',
      zoomOut: '時間軸縮小',
      zoomReset: '時間軸顯示全部'
    },
    loading: '載入分析結果…',
    loadFailed: {
      title: '無法載入分析結果',
      text: '找不到可用的分析結果（代碼 {code}）。可重試，或返回影片庫。',
      retry: '重試'
    },
    tabs: {
      hl: '精華',
      asideLabel: '精華'
    },
    hl: {
      title: '{n} 殺精華',
      quickTitle: '快速剪輯',
      genericTitle: '精華片段',
      badgeSuggested: 'AI 建議',
      badgeAccepted: 'AI 精華',
      badgeManual: '手動',
      pending: '{n} 項待確認',
      focusHint: '焦點清單時：Enter 加入、Delete 略過、↑↓ 移動',
      compact: '精簡',
      large: '大圖',
      preview: '預覽',
      accept: '加入',
      accepted: '已加入',
      skip: '略過',
      restore: '復原',
      remove: '移出',
      stale: '來源事件已更新',
      empty: '找不到符合條件的精華',
      emptyHint: '可調整 AI 參數，或使用快速剪輯。',
      tuneParams: '調整 AI 參數',
      projectSummary: '專案已有 {n} 段 · 總長 {time}'
    },
    eventReasons: {
      reasonDeleted: '已刪除',
      reasonForced: '強制計入',
      reasonForcedOff: '強制不計入'
    },
    autoClipPopover: {
      title: 'AI 自動剪輯',
      desc: '只會在時間軸上放「建議框」，由你確認後才加入專案。',
      n: '最少殺敵數 n',
      gap: '相鄰最大間隔 gap（秒）',
      before: '首殺前 before（秒）',
      after: '末殺後 after（秒）',
      maxLen: '片段最長 max_len（秒）',
      estimate: '預計產生 {n} 段 · 共 {time}',
      estimating: '計算中…',
      slider: '（滑桿）',
      reset: '重設預設值',
      cancel: '取消',
      apply: '套用（取代現有建議）'
    },
    transport: {
      play: '播放',
      pause: '暫停',
      prevEvent: '上一個事件',
      nextEvent: '下一個事件',
      addEvent: '＋事件',
      filterLabel: '事件類型篩選'
    },
    track: {
      title: '專案',
      itemCount: '{n} 段',
      total: '總長 {time}',
      empty: '尚無片段，從精華或快速剪輯加入',
      addFromSource: '從來源加入',
      addKey: 'Ctrl E',
      addAll: '全部加入',
      addAllKey: 'Ctrl E',
      sources: '來自 {n} 支影片',
      nameLabel: '專案名稱',
      collapse: '展開或收合專案軌',
      split: '分割',
      splitTitle: '在播放頭分割（專案模式 Ctrl+Q）',
      duplicate: '複製片段 (Ctrl+D)',
      delete: '刪除片段 (Delete，可復原)',
      undo: '復原 (Ctrl+Z)',
      redo: '重做 (Ctrl+Y)',
      newProject: '新專案',
      addExternalVideo: '加入外部影片',
      saved: '已自動儲存',
      pending: '尚待儲存',
      saving: '儲存中…',
      saveError: '儲存失敗',
      itemAria: '片段 {i} {label} {time}',
      missing: '來源影片不存在',
      missingToast: '來源影片不存在，無法預覽',
      restMissingToast: '後續片段的來源檔案不存在',
      missingHint: '無法預覽',
      stepperStart: '起點',
      stepperEnd: '終點',
      stepperDec: '−0.5 秒',
      stepperInc: '+0.5 秒'
    },
    newProjectDlg: {
      title: '建立新專案？',
      confirm: '建立新專案',
      body: '目前專案「{name}」有 {n} 段，建立新專案前會先儲存在專案自動儲存目錄。',
      cancel: '取消'
    },
    addEvent: {
      title: '新增事件（{time}）',
      type: '事件類型',
      cancel: '取消',
      confirm: '新增',
      hint: 'Enter 確認'
    },
    shelves: {
      empty: '尚無資料',
      hlPlaceholder: '精華清單將顯示 AI 建議與手動片段'
    },
    sideHints: {
      hlCount: '精華 {n}'
    },
    search: {
      clips: '搜尋精華'
    }
  },
  export: {
    title: '匯出專案',
    close: '關閉',
    mode: '匯出模式',
    modeSeparate: '每段各一檔',
    modeSeparateDesc: '產生 {n} 個檔案，檔名加上序號',
    modeConcat: '串成一支合輯',
    modeConcatDesc: '依專案順序合併成單一檔案',
    quality: '品質',
    qualityCopy: '快速無損',
    qualityCopyDesc: '從關鍵影格切，速度最快、畫質不變。',
    qualityCopyExtra: '片段起點平均會多出約 {sec} 秒。',
    qualityCopyUnavailable: '來源參數不一致時停用。',
    unavailable: '不可用',
    qualityPrecise: '精準重新編碼',
    qualityPreciseDesc: '起訖點精準到畫格；速度取決於編碼器',
    encoder: '編碼器',
    encoderAuto: '自動（依 NVENC、QSV、AMF 順序）',
    encoderCopyNote: '編碼器只在「精準重新編碼」時使用；快速無損不重新編碼。',
    encoderDetected: '{name}（偵測到）',
    encoderOpenh264: 'OpenH264（CPU，畫質較低）',
    encoderOpenh264Missing: 'OpenH264（尚未下載）',
    encoderHint: '沒有硬體編碼器時會詢問是否下載 Cisco OpenH264。',
    extraSecondsNotice: '快速無損會從關鍵影格切除，片段可能多出約 {sec} 秒。',
    fallbackReencodeNotice: '來源影片參數不一致，已自動改用精準重新編碼',
    summaryClips: '片段',
    summaryDuration: '總長度',
    summarySources: '來源影片',
    output: '輸出',
    outputDir: '輸出資料夾',
    outputDirPlaceholder: '尚未選擇',
    browse: '瀏覽',
    baseName: '檔名',
    estimate: '預估大小約 {size}',
    diskFree: '{path} 可用 {size}',
    diskLow: '剩餘空間不足：預估需要約 {need}，目前只有 {free}。',
    blockEmpty: '專案沒有任何片段，無法匯出',
    blockMissingSource: '找不到來源影片：{path}',
    blockNoEncoder: '找不到可用的視訊編碼器（已安裝 OpenH264 但無法使用），請改用快速無損',
    blockNoOutDir: '請先選擇輸出資料夾',
    blockOutDirInvalid: '輸出資料夾不存在或路徑不正確',
    blockersTitle: '無法匯出',
    needOpenh264: '精準重新編碼需要編碼器：請同意下載 OpenH264，或改用快速無損。',
    startExport: '開始匯出',
    cancel: '取消',
    running: '匯出中',
    runningDetail: '處理片段 {i}/{n}（{sec} 秒）· {enc}',
    runningLocked: '編輯區已鎖定，避免匯出中修改專案。可隨時取消；取消會刪除未完成的檔案，已完成的檔案保留。',
    cancelExport: '取消匯出',
    minimize: '縮小為進度徽章',
    doneTitle: '匯出完成',
    cancelledTitle: '已取消匯出',
    cancelledDesc: '未完成的檔案已刪除，已完成的檔案保留如下。',
    cancelledNone: '沒有已完成的檔案。',
    doneSummary: '共 {dur}　·　耗時 {took}',
    outputFiles: '輸出檔案',
    openFolder: '開啟資料夾',
    finish: '完成',
    failedTitle: '匯出失敗',
    failedDesc: '未完成的檔案已清除，已完成的檔案仍保留。',
    stderrTitle: '錯誤摘要',
    failedCauses: '常見原因：磁碟空間不足、輸出檔被其他程式占用、編碼器不可用。',
    copyError: '複製錯誤訊息',
    copied: '已複製',
    retry: '重試',
    closeBtn: '關閉',
    h264Title: '需要下載 Cisco OpenH264',
    h264Why: '這台電腦沒有可用的硬體編碼器（NVENC／QSV／AMF），「精準重新編碼」需要 OpenH264。',
    h264License: '為符合授權，本程式不隨附 OpenH264。同意後，會從 Cisco 官方網址 ciscobinary.openh264.org 下載官方 DLL（約 0.4 MB）。畫質會略低於硬體編碼。',
    h264Alt: '你也可以改選「快速無損」，不需要任何編碼器。',
    h264Decline: '改用快速無損',
    h264Accept: '同意並下載',
    h264Downloading: '下載中 {pct}%',
    h264Failed: '下載 OpenH264 失敗：{msg}',
    h264NotDetected: '下載完成但仍偵測不到 OpenH264 編碼器',
    h264Retry: '重新下載',
    sec: '秒',
    badge: '{pct}%',
    badgeLabel: '匯出進行中 {pct}%，按下查看',
    toastDone: '匯出完成',
    toastCancelled: '已取消匯出',
    toastFailed: '匯出失敗',
    view: '查看',
    backBlocked: '匯出進行中，請先取消或等待完成'
  }
}

const shellI18n = {
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
  settings: { title: '設定' },
  shortcutsDialog: {
    title: '快捷鍵說明',
    close: '關閉',
    hint: '按 Esc 關閉。輸入框內輸入的字元不會觸發快捷鍵。',
    keysLabel: '按鍵'
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
      title: '歡迎使用 Aditor',
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
      global: '全域',
      studio: '工作室',
      source: '來源時間軸',
      hl: '精華清單',
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
      zoomReset: '時間軸全覽縮放',
      quickOrSplit: '切換刀片模式（專案預覽中：在播放頭分割）',
      blade: '切換刀片模式（快速剪輯）',
      addEvent: '新增事件',
      setStart: '目前片段起點＝播放頭',
      setEnd: '目前片段終點＝播放頭',
      addAllToProject: '加入專案（全部建議）',
      acceptSuggestion: '加入目前建議',
      skipSuggestion: '略過目前建議',
      deleteProjectItem: '刪除選取片段',
      duplicateItem: '複製選取片段',
      moveItemLeft: '選取片段往前移',
      moveItemRight: '選取片段往後移',
      playItem: '播放該片段',
      undo: '復原',
      redo: '重做',
      openExport: '開啟匯出抽屜',
      toggleAside: '顯示／隱藏側欄',
      backToSource: '返回來源模式',
      closeOverlay: '關閉浮層',
      showShortcuts: '快捷鍵說明',
      focusToast: '聚焦最新通知（可按〔復原〕）',
      focusSearch: '聚焦搜尋',
      toggleFavoriteFilter: '切換只顯示收藏',
      selectPrevItem: '選取上一個片段',
      selectNextItem: '選取下一個片段',
      listPrev: '上一項',
      listNext: '下一項'
    }
  }
}

/** Settings screen (Task 16): categories, cards, row text, and control labels. */
const settingsI18n = {
  title: '設定',
  searchPlaceholder: '搜尋設定',
  searchLabel: '搜尋設定',
  tablistLabel: '設定分類',
  resultsLabel: '搜尋結果',
  noResults: '沒有符合的設定',
  noResultsHint: '試試其他關鍵字，例如「代理檔」「秒數」「編碼器」。',
  hitCount: '{n} 項符合',
  loading: '正在讀取設定…',
  loadFailed: '無法讀取設定，已顯示預設值。',
  saveFailed: '儲存失敗：這項變更已在目前視窗生效，但沒有寫入磁碟，重新啟動後可能還原。請確認磁碟空間與資料夾權限後再試一次。',
  newTag: '新',
  comingSoon: '此功能將在後續更新提供。',
  cat: {
    general: '一般',
    recording: '錄影',
    analysis: '匯入與分析',
    editing: '剪輯',
    export: '匯出',
    about: '關於'
  },
  catDesc: {
    general: '介面語言、開機啟動與系統匣，以及錄影和剪輯輸出存放的位置。',
    recording: '何時錄、用哪個錄影器、畫質與聲音，以及磁碟空間不足時怎麼處理。',
    analysis: '影片怎麼進到影片庫，以及分析精彩片段的方式。',
    editing: '剪輯工作室的預覽播放與剪輯預設值。',
    export: '輸出影片時使用的編碼器。',
    about: '版本、更新、授權與商標聲明。'
  },
  card: {
    ui: '介面',
    startup: '啟動與視窗',
    storage: '儲存',
    source: '影片來源',
    perf: '分析效能',
    proxy: '預覽與代理檔',
    clip: '剪輯預設值',
    export: '編碼器',
    about: '版本資訊'
  },
  row: {
    language: {
      title: '介面語言',
      desc: '變更後視窗會重新載入以套用；系統匣選單也會一併更新。選「跟隨系統」會依 Windows 的顯示語言決定；系統語言不在支援清單時使用英文。',
      keywords: ['語言', '介面', '翻譯', 'language', 'locale', '中文', 'english', '日本語', '한국어'],
      auto: '跟隨系統'
    },
    watchFolders: {
      title: '監看資料夾',
      desc: '新影片穩定後自動匯入影片庫（是否自動分析見下一項）。',
      keywords: ['資料夾', '監看', '匯入', 'watch', 'folder'],
      add: '新增資料夾',
      remove: '移除',
      removeLabel: '移除監看資料夾 {dir}',
      empty: '尚未設定監看資料夾',
      missing: '找不到此資料夾',
      list: '已設定的監看資料夾'
    },
    autoAnalyze: {
      title: '新影片自動分析',
      desc: '關閉後只匯入，需手動按「分析」。',
      keywords: ['分析', '佇列', '自動']
    },
    decode: {
      title: '解碼方式',
      desc: '強制軟體解碼會在之後開始的分析生效（已在分析中的影片不受影響）；硬體解碼失敗時會自動改用軟體解碼並提示。',
      keywords: ['解碼', '硬體', '軟體', 'gpu', 'decode'],
      auto: '自動（硬體優先）',
      software: '強制軟體解碼'
    },
    cacheLocation: {
      title: '快取位置',
      desc: '預設存在 %APPDATA%\\Aditor\\cache，不寫入 Outplayed 目錄。變更後對之後開始的分析生效；已分析過的影片仍可從原位置開啟。',
      keywords: ['快取', '位置', 'cache', 'appdata'],
      appdata: 'App 資料夾',
      besideVideo: '影片旁（.aditor.json）'
    },
    lowPerfMode: {
      title: '低效能模式',
      desc: '關閉動畫、縮圖改為靜態、時間軸熱度條降為 60 格。',
      keywords: ['低效能', '效能', '動畫', 'performance']
    },
    proxySuggest: {
      title: '播放不流暢時建議產生代理檔',
      desc: '以 mediaCapabilities 判斷；匯出一律使用原始檔。',
      keywords: ['代理檔', '建議', 'proxy', '預覽']
    },
    proxyUsage: {
      title: '代理檔佔用空間',
      desc: '刪除後需要時可重新產生。',
      keywords: ['代理檔', '刪除', '佔用', '空間', 'proxy'],
      summary: '{size}（{count} 個檔案）',
      none: '目前沒有代理檔',
      unknown: '無法取得佔用空間',
      delete: '刪除全部代理檔',
      confirm: '確定刪除？',
      cancel: '取消',
      deleted: '已刪除 {n} 個代理檔',
      failed: '有 {n} 個代理檔無法刪除'
    },
    beforeAfter: {
      title: '事件預覽秒數',
      desc: '跳至事件時提前指定秒數，預設 8 秒；範圍 0–30 秒。後秒數僅保留舊設定，快速剪輯以刀片點選的起訖為準。',
      keywords: ['秒數', '前後', '快速剪輯', '合輯', 'before', 'after'],
      before: '事件前秒數',
      after: '事件後秒數（舊版設定）',
      decrease: '減少{name}',
      increase: '增加{name}',
      unit: '秒'
    },
    autoclip: {
      title: 'AI 自動剪輯預設參數',
      desc: '在「AI 自動剪輯」浮層可臨時調整；這裡是開啟浮層時的起始值。',
      keywords: ['ai', '自動剪輯', '參數', 'gap', 'max_len', '精華'],
      n: '最少殺敵數 n（1–10）',
      gap: '相鄰最大間隔 gap 秒（5–60）',
      before: '首殺前 before 秒（0–30）',
      after: '末殺後 after 秒（0–30）',
      max_len: '片段最長 max_len 秒（15–300）'
    },
    autoSuggestOnOpen: {
      title: '開啟影片時自動產生精華建議',
      desc: '以預設參數執行一次，僅放上建議框，不會自動加入專案。',
      keywords: ['自動', '建議', '精華', '開啟影片']
    },
    projectAutosave: {
      title: '專案自動儲存',
      desc: '每次修改後自動存到 %APPDATA%\\Aditor\\projects\\，「另存檔案」只用於分享。關閉後會恢復「未儲存變更」提示。',
      keywords: ['專案', '自動儲存', 'autosave', '儲存']
    },
    storageRoot: {
      title: '儲存位置',
      desc: '錄影與剪輯輸出都存在這個資料夾底下，方便整批備份或搬移。',
      keywords: ['儲存', '位置', '資料夾', '錄影', '輸出', '匯出', 'storage', 'folder', 'recordings', 'exports'],
      unset: '尚未設定（建議：{dir}）',
      change: '變更…',
      open: '在檔案總管開啟',
      preview: {
        heading: '資料夾結構',
        dayFolder: '日期',
        recordings: '錄影依日期分資料夾',
        merged: '剪輯輸出：合併',
        clips: '剪輯輸出：一段一段'
      }
    },
    encoders: {
      title: '可用編碼器',
      desc: '精準重新編碼會依 NVENC、QSV、AMF 的順序挑選硬體編碼器。',
      keywords: ['編碼器', 'nvenc', 'qsv', 'amf', 'encoder', 'gpu'],
      redetect: '重新偵測',
      detecting: '偵測中…',
      notDetected: '尚未偵測',
      available: '可用',
      unavailable: '不可用'
    },
    openh264: {
      title: 'OpenH264（CPU 編碼）',
      desc: '僅在沒有硬體編碼器、或產生預覽代理檔時使用；依授權不隨附，同意後可從這裡下載。',
      keywords: ['openh264', 'cisco', 'cpu', '編碼'],
      installed: '已安裝',
      notInstalled: '尚未安裝',
      unknown: '狀態未知',
      download: '下載',
      redownload: '重新下載',
      consent: '為符合授權，本程式不隨附 OpenH264。同意後，會從 Cisco 官方網址 ciscobinary.openh264.org 下載官方 DLL（約 0.4 MB）。',
      accept: '同意並下載',
      decline: '取消',
      downloading: '下載中 {pct}%',
      failed: '下載 OpenH264 失敗：{msg}'
    },
    about: {
      title: '版本與授權',
      desc: 'GPL v3 授權。隨附 LGPL 版 ffmpeg。',
      keywords: ['版本', '授權', '關於', 'license', 'version', 'gpl', 'ffmpeg'],
      version: 'Aditor {version}',
      licenses: '第三方授權'
    },
    updateStatus: {
      title: '軟體更新',
      desc: '從 GitHub 下載新版本，結束 Aditor 時自動安裝；也可以立即重新啟動安裝。',
      keywords: ['更新', '新版本', '版本', 'update', 'github', '下載'],
      unsupported: '免安裝版與開發版不支援自動更新',
      idle: '尚未檢查',
      checking: '正在檢查…',
      latest: '已是最新版本',
      downloading: '正在下載 {version}（{pct}%）',
      downloaded: '{version} 已下載，結束 Aditor 時安裝',
      error: '檢查更新失敗：{msg}',
      check: '檢查更新',
      install: '立即重新啟動並更新',
      openReleases: '開啟下載頁面'
    },
    autoUpdate: {
      title: '自動檢查更新',
      desc: '啟動後與每 6 小時檢查一次，有新版本就在背景下載。',
      keywords: ['更新', '自動', 'update', 'github']
    },
    trademark: {
      title: '商標聲明',
      desc: 'Apex Legends 為 Electronic Arts／Respawn 之商標，與本專案無關。',
      keywords: ['商標', 'apex legends', 'ea', 'respawn', '聲明']
    }
  }
} as const

/** Game recording settings and status panel. */
const recordingI18n = {
  title: '錄影',
  card: '遊戲錄影',
  cards: { basics: '基本', recorder: '錄影器', video: '影像', audio: '音訊', disk: '磁碟空間與通知' },
  advanced: '進階選項',
  current: '目前：{value}',
  fit: '適配',
  stretch: '拉伸',
  speed: '速度優先',
  balanced: '平衡',
  quality: '品質優先',
  builtin: '內建錄影器',
  obs: 'OBS Studio',
  obsHint: '請在 OBS 啟用 WebSocket 伺服器（工具 → WebSocket 伺服器設定）。品質與音訊請在 OBS 設定；逐局影片會在錄影結束後剪出。',
  obsTest: '測試連線',
  obsTesting: '測試中…',
  obsPasswordSet: '已設定',
  obsPasswordEmpty: '未設定',
  obsPasswordSave: '儲存密碼',
  obsPasswordClear: '移除密碼',
  obsRecording: '錄影中（OBS）',
  obsStandby: '待命（OBS，等待對局）',
  detectionOnly: '即時偵測中（未錄影）',
  rows: {
    autoRecord: { title: '自動錄影', desc: '偵測到 Apex 啟動後自動開始錄影。' },
    launchAtLogin: { title: '開機啟動並常駐系統匣', desc: '開機時在背景啟動 Aditor。' },
    closeToTray: { title: '關閉視窗時縮到系統匣', desc: '關閉視窗後繼續偵測 Apex 與錄影。' },
    backend: { title: '錄影後端', desc: '選擇負責錄製影片的錄影器，下次開始時生效。' },
    obsHost: { title: 'OBS 主機', desc: 'WebSocket 伺服器的主機名稱或 IP 位址。' },
    obsPort: { title: 'OBS 連接埠', desc: '預設為 4455。' },
    obsPassword: { title: 'OBS 密碼', desc: '密碼由系統加密儲存，無法查看已儲存的密碼。' },
    obsFallbackBuiltin: { title: 'OBS 連不上時改用內建錄影', desc: '關閉後仍繼續即時偵測，但不錄製影片。' },
    mode: { title: '錄影模式', desc: '一局一個檔模式下，OBS 僅在對局期間錄影；內建錄影器整場持續錄影，每局結束後自動剪出該局（前後各留 5 秒），只保留對局，大廳只暫存最近 15 秒，久待大廳不會持續占用磁碟；即時偵測無法運作時保留整段錄影' },
    postAnalysis: { title: '錄後分析', desc: '「每局結束後」只在一局一個檔模式下於每局影片完成後立即分析；從頭錄到尾模式在收尾後分析' },
    diskWarnGb: { title: '磁碟提醒門檻', desc: '剩餘空間低於此值時通知。' },
    diskStopGb: { title: '磁碟停止門檻', desc: '剩餘空間低於此值時停止錄影並收尾；不可高於提醒門檻。' },
    notifyMatch: { title: '對局通知', desc: '對局偵測完成後，通知對局開始與結束；錯誤一律通知。' },
    openOnGameExit: { title: '遊戲結束時開啟 Aditor', desc: '偵測到 Apex 關閉時自動顯示 Aditor 視窗。' },
    height: { title: '解析度', desc: '原生解析度保留遊戲畫面大小。' },
    bitrateKbps: { title: '位元率 (kbps)', desc: '數值越高，檔案越大。' },
    fps: { title: '影格率 (FPS)', desc: '每秒錄製的影格數。' },
    forceAspect: { title: '強制 16:9', desc: '將錄影輸出調整為 16:9，不影響即時分析。' },
    aspectMode: { title: '裁切方式', desc: '適配會保留完整畫面並補上黑邊；拉伸會填滿畫面。' },
    codec: { title: '編碼格式', desc: '僅使用硬體編碼；沒有可用編碼器時不錄影。' },
    encoder: { title: '錄影編碼器', desc: '依目前編碼格式列出錄影器可用的硬體編碼器。' },
    preset: { title: '編碼預設', desc: '品質越高，GPU 使用量越高。' },
    captureMethod: { title: '擷取方式', desc: '視窗擷取（WGC，預設）只錄遊戲視窗，但大廳滑鼠會有延遲；螢幕擷取（DDA）不會造成滑鼠延遲，但會錄下整個螢幕，蓋在遊戲上的視窗也會被錄進去，遊戲不在前景時為黑畫面；遊戲擷取（選用，需另外確認）注入 OBS 官方的擷取元件，不會造成滑鼠延遲，遊戲在背景或最小化時仍可錄到畫面，無法使用時自動改用螢幕擷取。下次開始錄影時生效。' },
    systemAudioEnabled: { title: '錄製系統聲音', desc: '將系統聲音錄進影片。' },
    renderDevice: { title: '系統聲音裝置', desc: '擷取此輸出裝置播放的系統聲音。' },
    systemGain: { title: '系統聲音音量', desc: '100% 為原始音量，最高 200%。' },
    micEnabled: { title: '錄製麥克風', desc: '將麥克風與系統聲音混成一軌。' },
    captureDevice: { title: '麥克風裝置', desc: '選擇錄影使用的麥克風。' },
    micGain: { title: '麥克風音量', desc: '100% 為原始音量，最高 200%。' },
    gameAudioOnly: { title: '系統聲音只錄遊戲', desc: '只錄 Apex 的聲音，YouTube、Discord 等其他程式的聲音不會錄進去；需要 Windows 組建 20348 以後的版本，不支援時自動改錄整個系統聲音。' },
    micMono: { title: '麥克風強制單聲道', desc: '麥克風只有單邊有聲音時開啟。' }
  },
  auto: '自動',
  defaultDevice: '預設',
  session: '從頭錄到尾',
  match: '一局一個檔',
  native: '原生',
  analysisNone: '不分析',
  analysisAfterExit: '關閉 Apex 後',
  analysisPerMatch: '每局結束後',
  captureHook: '遊戲擷取',
  captureWgc: '視窗擷取（WGC）',
  captureDda: '螢幕擷取（DDA）',
  captureHookWarning: {
    title: '使用遊戲擷取前請注意',
    sections: {
      diff: {
        heading: '遊戲擷取與視窗擷取（WGC）的差別',
        items: [
          '視窗擷取（WGC，預設）：使用 Windows 內建的擷取功能錄下遊戲視窗，不會把任何東西放進遊戲程序；但遊戲畫面會改由 Windows 桌面合成器（DWM）處理，大廳等介面的滑鼠可能出現延遲。',
          '遊戲擷取：不會造成滑鼠延遲；遊戲切到背景或最小化時也能持續錄到畫面（例如打完一局切出去排隊時，仍能正確分出兩局）。'
        ]
      },
      how: {
        heading: '運作原理',
        text: '遊戲擷取與 OBS Studio 的「遊戲擷取」使用同一個元件：Aditor 會把 OBS 官方發行、帶有 OBS Project 數位簽章的擷取元件（graphics-hook）載入 Apex Legends 的程序，在遊戲每次輸出畫面時複製一份給 Aditor 錄影。Aditor 未修改這個元件；它只處理畫面輸出，不會讀取角色位置、血量等遊戲狀態。'
      },
      risk: {
        heading: '風險',
        items: [
          '將外部元件載入遊戲程序，可能被 Apex Legends 的反作弊系統（EA Javelin Anticheat）視為可疑行為。',
          'Apex Legends 官方（EA／Respawn）目前並未公開說明是否允許這類擷取方式。OBS 的遊戲擷取雖被廣泛使用，但由 Aditor 載入同一元件，無法保證會被同樣看待；反作弊的偵測規則也可能隨時更新，現在可用不代表日後可用。',
          '可能的結果包括：擷取失敗（Aditor 會自動改用螢幕擷取）、遊戲被反作弊中斷，最嚴重的是帳號遭到停權或封禁。',
          '若不確定，請使用預設的視窗擷取。'
        ]
      },
      disclaimer: {
        heading: '聲明',
        text: '按下「確認」即表示你已閱讀並了解上述內容，並自行承擔使用遊戲擷取的一切風險；若帳號因此遭到停權或封禁，本程式開發者一概不負責。'
      }
    },
    cancel: '取消',
    confirm: '確認',
    confirmCountdown: '確認（{sec}）'
  },
  capabilitiesUnavailable: '無法取得錄影器能力，請確認 aditorrec 已安裝；目前僅提供自動編碼器與預設裝置。',
  capabilitiesLoading: '正在取得錄影器能力…',
  currentUnavailable: '目前設定：{value}（未偵測到）',
  statusTitle: '錄影狀態',
  close: '關閉',
  phases: { idle: '待命', starting: '啟動中', recording: '錄影中', finalizing: '收尾中', error: '錄影錯誤' },
  elapsed: '錄影時間',
  segments: '段落數',
  actualEncoder: '編碼器',
  resolution: '解析度',
  dropped: '丟格數',
  diskFree: '磁碟剩餘',
  unknown: '未知',
  start: '開始錄影',
  stop: '停止錄影',
  pauseAuto: '暫停自動錄影',
  apexNotRunning: '無法開始錄影，請確認 Apex 正在執行。',
  serviceUnavailable: '無法取得錄影狀態，請確認錄影服務已啟動。',
  actionFailed: '錄影操作失敗，請再試一次。',
  watchLive: '觀看當局',
  watchLiveHint: '錄影中才能觀看當局',
  kills: '本局擊殺',
  matchIndex: '對局'
}

/** Playback during recording (phase 3). */
const liveI18n = {
  obsRecording: 'OBS 錄影中，錄影結束後即可播放',
  detectionOnly: '即時偵測中，OBS 未連線，本次未錄影',
  title: '觀看當局',
  back: '返回',
  video: '當局錄影',
  recording: '錄影中',
  match: '第 {n} 局',
  noMatch: '尚未偵測到對局',
  kills: '本局擊殺 {n}',
  play: '播放',
  pause: '暫停',
  back5: '倒退 5 秒',
  forward5: '前進 5 秒',
  jumpLive: '跳到最新',
  atLive: '已是最新',
  time: '{cur} / {end}',
  timeline: '錄影時間軸',
  timelineValue: '{cur}，錄影長度 {end}',
  matchRange: '第 {n} 局：{start}–{end}',
  matchOngoing: '進行中',
  released: '超過 30 分鐘的內容已釋放，收尾後可在工作室觀看',
  events: '即時事件',
  noEvents: '尚無事件；偵測到擊倒或消滅會即時出現。',
  eventItem: '{type} · {time}',
  uncounted: '（不計入）',
  newKill: '新事件：{type} · {time}',
  loading: '正在載入錄影…',
  notRecording: '目前沒有進行中的錄影。',
  unsupported: '此電腦無法播放錄影的編碼（{mime}），事件仍會即時更新。',
  loadFailed: '無法載入錄影段落：{message}',
  waitingInit: '等待錄影開始寫入…',
  ended: '錄影已結束，已加入媒體庫。',
  openStudio: '在工作室開啟',
  openLibrary: '前往媒體庫',
  keys: '空白鍵播放／暫停 · ←／→ 前後 5 秒 · End 跳到最新'
} as const

export const zhTW = { i18n, shellI18n, settingsI18n, recordingI18n, liveI18n }
