import type { Messages } from '../index'

/** 设置界面：分类、卡片、各行文字与控件标签。 */
export const settingsI18n: Messages['settingsI18n'] = {
  title: '设置',
  searchPlaceholder: '搜索设置',
  searchLabel: '搜索设置',
  tablistLabel: '设置分类',
  resultsLabel: '搜索结果',
  noResults: '没有符合的设置',
  noResultsHint: '试试其他关键字，例如“代理文件”“秒数”“编码器”。',
  hitCount: '{n} 项符合',
  loading: '正在读取设置…',
  loadFailed: '无法读取设置，已显示默认值。',
  saveFailed: '保存失败：这项更改已在当前窗口生效，但没有写入磁盘，重新启动后可能还原。请确认磁盘空间与文件夹权限后再试一次。',
  newTag: '新',
  comingSoon: '此功能将在后续更新提供。',
  cat: {
    a: '视频与分析',
    b: '预览与剪辑',
    c: '导出与关于',
    recording: '录制'
  },
  card: {
    general: '通用',
    source: '视频来源',
    perf: '分析与性能',
    proxy: '预览与代理文件',
    clip: '剪辑默认值',
    export: '导出',
    about: '关于'
  },
  row: {
    language: {
      title: '界面语言',
      desc: '更改后窗口会重新加载以生效；系统托盘菜单也会一并更新。选“跟随系统”会依 Windows 的显示语言决定。',
      keywords: ['语言', '界面', '翻译', 'language', 'locale', '中文', 'english', '日本語', '한국어'],
      auto: '跟随系统'
    },
    watchFolders: {
      title: '监看文件夹',
      desc: '新视频稳定后自动导入视频库（是否自动分析见下一项）。',
      keywords: ['文件夹', '监看', '导入', 'watch', 'folder'],
      add: '新增文件夹',
      remove: '移除',
      removeLabel: '移除监看文件夹 {dir}',
      empty: '尚未设置监看文件夹',
      missing: '找不到此文件夹',
      list: '已设置的监看文件夹'
    },
    autoAnalyze: {
      title: '新视频自动分析',
      desc: '关闭后只导入，需手动点击“分析”。',
      keywords: ['分析', '队列', '自动']
    },
    decode: {
      title: '解码方式',
      desc: '强制软件解码会在之后开始的分析中生效（已在分析中的视频不受影响）；硬件解码失败时会自动改用软件解码并提示。',
      keywords: ['解码', '硬件', '软件', 'gpu', 'decode'],
      auto: '自动（硬件优先）',
      software: '强制软件解码'
    },
    cacheLocation: {
      title: '缓存位置',
      desc: '默认存在 %APPDATA%\\ApexHighlighter\\cache，不写入 Outplayed 目录。更改后对之后开始的分析生效；已分析过的视频仍可从原位置打开。',
      keywords: ['缓存', '位置', 'cache', 'appdata'],
      appdata: 'App 文件夹',
      besideVideo: '视频旁（.apexhl.json）'
    },
    lowPerfMode: {
      title: '低性能模式',
      desc: '关闭动画、缩略图改为静态、时间轴热度条降为 60 格。',
      keywords: ['低性能', '性能', '动画', 'performance']
    },
    proxySuggest: {
      title: '播放不流畅时建议生成代理文件',
      desc: '以 mediaCapabilities 判断；导出一律使用原始文件。',
      keywords: ['代理文件', '建议', 'proxy', '预览']
    },
    proxyUsage: {
      title: '代理文件占用空间',
      desc: '删除后需要时可重新生成。',
      keywords: ['代理文件', '删除', '占用', '空间', 'proxy'],
      summary: '{size}（{count} 个文件）',
      none: '目前没有代理文件',
      unknown: '无法获取占用空间',
      delete: '删除全部代理文件',
      confirm: '确定删除？',
      cancel: '取消',
      deleted: '已删除 {n} 个代理文件',
      failed: '有 {n} 个代理文件无法删除'
    },
    beforeAfter: {
      title: '事件预览秒数',
      desc: '跳至事件时提前指定秒数，默认 8 秒；范围 0–30 秒。后秒数仅保留旧设置，快速剪辑以刀片点选的起止为准。',
      keywords: ['秒数', '前后', '快速剪辑', '合辑', 'before', 'after'],
      before: '事件前秒数',
      after: '事件后秒数（旧版设置）',
      decrease: '减少{name}',
      increase: '增加{name}',
      unit: '秒'
    },
    autoclip: {
      title: 'AI 自动剪辑默认参数',
      desc: '在“AI 自动剪辑”浮层可临时调整；这里是打开浮层时的起始值。',
      keywords: ['ai', '自动剪辑', '参数', 'gap', 'max_len', '精华'],
      n: '最少杀敌数 n（1–10）',
      gap: '相邻最大间隔 gap 秒（5–60）',
      before: '首杀前 before 秒（0–30）',
      after: '末杀后 after 秒（0–30）',
      max_len: '片段最长 max_len 秒（15–300）'
    },
    autoSuggestOnOpen: {
      title: '打开视频时自动生成精华建议',
      desc: '以默认参数运行一次，仅放上建议框，不会自动加入项目。',
      keywords: ['自动', '建议', '精华', '打开视频']
    },
    projectAutosave: {
      title: '项目自动保存',
      desc: '每次修改后自动存到 %APPDATA%\\ApexHighlighter\\projects\\，“另存文件”只用于分享。关闭后会恢复“未保存更改”提示。',
      keywords: ['项目', '自动保存', 'autosave', '保存']
    },
    defaultOutDir: {
      title: '默认输出文件夹',
      desc: '导出抽屉的起始文件夹；未设置时每次询问。',
      keywords: ['导出', '输出', '文件夹', 'export'],
      choose: '选择文件夹',
      clear: '清除',
      unset: '每次询问',
      current: '当前：{dir}'
    },
    encoders: {
      title: '可用编码器',
      desc: '精准重新编码会按 NVENC、QSV、AMF 的顺序挑选硬件编码器。',
      keywords: ['编码器', 'nvenc', 'qsv', 'amf', 'encoder', 'gpu'],
      redetect: '重新检测',
      detecting: '检测中…',
      notDetected: '尚未检测',
      available: '可用',
      unavailable: '不可用'
    },
    openh264: {
      title: 'OpenH264（CPU 编码）',
      desc: '仅在没有硬件编码器、或生成预览代理文件时使用；依授权不附带，同意后可从这里下载。',
      keywords: ['openh264', 'cisco', 'cpu', '编码'],
      installed: '已安装',
      notInstalled: '尚未安装',
      unknown: '状态未知',
      download: '下载',
      redownload: '重新下载',
      consent: '为符合授权，本程序不附带 OpenH264。同意后，会从 Cisco 官方网址 ciscobinary.openh264.org 下载官方 DLL（约 0.4 MB）。',
      accept: '同意并下载',
      decline: '取消',
      downloading: '下载中 {pct}%',
      failed: '下载 OpenH264 失败：{msg}'
    },
    about: {
      title: '版本与授权',
      desc: 'MIT 授权。附带 LGPL 版 ffmpeg。',
      keywords: ['版本', '授权', '关于', 'license', 'version', 'mit', 'ffmpeg'],
      version: 'Apex Highlighter {version}',
      licenses: '第三方授权'
    },
    trademark: {
      title: '商标声明',
      desc: 'Apex Legends 为 Electronic Arts／Respawn 之商标，与本项目无关。',
      keywords: ['商标', 'apex legends', 'ea', 'respawn', '声明']
    }
  }
}
