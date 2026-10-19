import type { Messages } from '../index'

export const shellI18n: Messages['shellI18n'] = {
  rail: {
    library: '视频库',
    studio: '工作室（精华＋项目）',
    studioLabel: '工作室',
    queue: '分析队列',
    shortcuts: '快捷键 (?)',
    shortcutsLabel: '快捷键',
    settings: '设置',
    mainNav: '主要导航'
  },
  settings: { title: '设置' },
  shortcutsDialog: {
    title: '快捷键说明',
    close: '关闭',
    hint: '按 Esc 关闭。输入框内输入的字符不会触发快捷键。',
    keysLabel: '按键'
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
      global: '全局',
      studio: '工作室',
      source: '来源时间轴',
      hl: '精华列表',
      proj: '项目轨',
      library: '视频库',
      settings: '设置'
    },
    cmd: {
      play: '播放／暂停',
      speed: '切换播放速度',
      prevEvent: '上一个事件',
      nextEvent: '下一个事件',
      seekBack: '后退 5 秒',
      seekFwd: '前进 5 秒',
      zoomIn: '时间轴放大',
      zoomOut: '时间轴缩小',
      zoomReset: '时间轴全览缩放',
      quickOrSplit: '切换刀片模式（项目预览中：在播放头分割）',
      blade: '切换刀片模式（快速剪辑）',
      addEvent: '添加事件',
      setStart: '当前片段起点＝播放头',
      setEnd: '当前片段终点＝播放头',
      addAllToProject: '加入项目（全部建议）',
      acceptSuggestion: '加入当前建议',
      skipSuggestion: '跳过当前建议',
      deleteProjectItem: '删除选中片段',
      duplicateItem: '复制选中片段',
      moveItemLeft: '选中片段前移',
      moveItemRight: '选中片段后移',
      playItem: '播放该片段',
      undo: '撤销',
      redo: '重做',
      openExport: '打开导出抽屉',
      toggleAside: '显示／隐藏侧栏',
      backToSource: '返回来源模式',
      closeOverlay: '关闭浮层',
      showShortcuts: '快捷键说明',
      focusToast: '聚焦最新通知（可按“撤销”）',
      focusSearch: '聚焦搜索',
      toggleFavoriteFilter: '切换只显示收藏',
      selectPrevItem: '选中上一个片段',
      selectNextItem: '选中下一个片段',
      listPrev: '上一项',
      listNext: '下一项'
    }
  }
}
