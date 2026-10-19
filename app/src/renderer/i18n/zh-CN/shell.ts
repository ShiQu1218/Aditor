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
