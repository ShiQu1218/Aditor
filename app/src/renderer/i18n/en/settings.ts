import type { Messages } from '../index'

export const settingsI18n: Messages['settingsI18n'] = {
  title: 'Settings',
  searchPlaceholder: 'Search settings',
  searchLabel: 'Search settings',
  tablistLabel: 'Settings categories',
  resultsLabel: 'Search results',
  noResults: 'No matching settings',
  noResultsHint: 'Try other keywords, such as "proxy", "seconds", or "encoder".',
  hitCount: 'Results: {n}',
  loading: 'Loading settings…',
  loadFailed: 'Unable to load settings. Showing default values.',
  saveFailed: 'Save failed. This change is active in the current window but was not written to disk, so it may revert after a restart. Check disk space and folder permissions, then try again.',
  newTag: 'New',
  comingSoon: 'This feature will be available in a future update.',
  cat: {
    a: 'Videos and analysis',
    b: 'Preview and editing',
    c: 'Export and about',
    recording: 'Recording'
  },
  card: {
    general: 'General',
    source: 'Video source',
    perf: 'Analysis and performance',
    proxy: 'Preview and proxy files',
    clip: 'Editing defaults',
    export: 'Export',
    about: 'About'
  },
  row: {
    language: {
      title: 'Interface language',
      desc: 'The window reloads to apply the change, and the tray menu updates as well. "Follow system" uses the Windows display language, or English if that language is not supported.',
      keywords: ['language', 'interface', 'translation', 'locale', 'chinese', 'english', 'japanese', 'korean', '日本語', '한국어'],
      auto: 'Follow system'
    },
    watchFolders: {
      title: 'Watch folders',
      desc: 'New videos are imported into the library automatically once they are stable (see the next item for auto-analysis).',
      keywords: ['folder', 'watch', 'import', 'directory'],
      add: 'Add folder',
      remove: 'Remove',
      removeLabel: 'Remove watch folder {dir}',
      empty: 'No watch folders set',
      missing: 'Folder not found',
      list: 'Configured watch folders'
    },
    autoAnalyze: {
      title: 'Auto-analyze new videos',
      desc: 'When off, videos are only imported and you need to click "Analyze" manually.',
      keywords: ['analyze', 'analysis', 'queue', 'automatic']
    },
    decode: {
      title: 'Decoding method',
      desc: 'Forcing software decoding applies to analyses started afterward. Videos already being analyzed are not affected. If hardware decoding fails, software decoding is used automatically and you are notified.',
      keywords: ['decode', 'decoding', 'hardware', 'software', 'gpu'],
      auto: 'Auto (hardware first)',
      software: 'Force software decoding'
    },
    cacheLocation: {
      title: 'Cache location',
      desc: 'Stored in %APPDATA%\\ApexHighlighter\\cache by default, not in the Outplayed folder. Applies to analyses started afterward. Videos that were already analyzed can still be opened from their original location.',
      keywords: ['cache', 'location', 'folder', 'appdata', 'storage'],
      appdata: 'App folder',
      besideVideo: 'Next to video (.apexhl.json)'
    },
    lowPerfMode: {
      title: 'Low performance mode',
      desc: 'Turns off animations, shows static thumbnails, and reduces the timeline heat bar to 60 segments.',
      keywords: ['low performance', 'performance', 'animation', 'performance mode']
    },
    proxySuggest: {
      title: 'Suggest a proxy file when playback stutters',
      desc: 'Determined using mediaCapabilities. Exports always use the original file.',
      keywords: ['proxy', 'suggest', 'preview', 'proxy file']
    },
    proxyUsage: {
      title: 'Proxy file disk usage',
      desc: 'You can regenerate them when needed after deleting.',
      keywords: ['proxy', 'delete', 'usage', 'space', 'disk'],
      summary: '{size} ({count} files)',
      none: 'No proxy files at the moment',
      unknown: 'Unable to determine disk usage',
      delete: 'Delete all proxy files',
      confirm: 'Delete?',
      cancel: 'Cancel',
      deleted: 'Proxy files deleted: {n}',
      failed: 'Proxy files that could not be deleted: {n}'
    },
    beforeAfter: {
      title: 'Event preview seconds',
      desc: 'Seeking to an event starts this many seconds early. Default is 8 seconds; range 0–30 seconds. The after value is kept only for older settings. Quick clips use the start and end points set with the blade.',
      keywords: ['seconds', 'before', 'after', 'quick clip', 'compilation'],
      before: 'Seconds before event',
      after: 'Seconds after event (legacy setting)',
      decrease: 'Decrease {name}',
      increase: 'Increase {name}',
      unit: 's'
    },
    autoclip: {
      title: 'AI auto-clip default parameters',
      desc: 'You can adjust these temporarily in the "AI auto-clip" overlay. This sets the starting values when the overlay opens.',
      keywords: ['ai', 'auto clip', 'parameters', 'gap', 'max_len', 'highlights'],
      n: 'Minimum kills n (1–10)',
      gap: 'Max gap between kills in seconds (5–60)',
      before: 'Seconds before first kill (0–30)',
      after: 'Seconds after last kill (0–30)',
      max_len: 'Max clip length in seconds (15–300)'
    },
    autoSuggestOnOpen: {
      title: 'Auto-generate highlight suggestions when opening a video',
      desc: 'Runs once with the default parameters and only places suggestion boxes. Nothing is added to the project automatically.',
      keywords: ['auto', 'suggestion', 'highlights', 'open video']
    },
    projectAutosave: {
      title: 'Project autosave',
      desc: 'Saves to %APPDATA%\\ApexHighlighter\\projects\\ after every change. "Save as" is only for sharing. When this is off, the "unsaved changes" prompt returns.',
      keywords: ['project', 'autosave', 'auto save', 'save']
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
      title: 'Available encoders',
      desc: 'Precise re-encode picks a hardware encoder in the order NVENC, QSV, then AMF.',
      keywords: ['encoder', 'nvenc', 'qsv', 'amf', 'gpu', 'encode'],
      redetect: 'Detect again',
      detecting: 'Detecting…',
      notDetected: 'Not detected yet',
      available: 'Available',
      unavailable: 'Unavailable'
    },
    openh264: {
      title: 'OpenH264 (CPU encoding)',
      desc: 'Used only when no hardware encoder is available or when generating proxy files. It is not bundled, for licensing reasons. You can download it from here after you agree.',
      keywords: ['openh264', 'cisco', 'cpu', 'encoding'],
      installed: 'Installed',
      notInstalled: 'Not installed',
      unknown: 'Status unknown',
      download: 'Download',
      redownload: 'Download again',
      consent: 'To comply with licensing, this program does not include OpenH264. If you agree, the official DLL (about 0.4 MB) will be downloaded from Cisco\'s official site, ciscobinary.openh264.org.',
      accept: 'Agree and download',
      decline: 'Cancel',
      downloading: 'Downloading {pct}%',
      failed: 'Failed to download OpenH264: {msg}'
    },
    about: {
      title: 'Version and license',
      desc: 'Licensed under MIT. Includes LGPL-licensed ffmpeg.',
      keywords: ['version', 'license', 'about', 'mit', 'ffmpeg'],
      version: 'Apex Highlighter {version}',
      licenses: 'Third-party licenses'
    },
    trademark: {
      title: 'Trademark notice',
      desc: 'Apex Legends is a trademark of Electronic Arts / Respawn. This project is not affiliated with EA or Respawn.',
      keywords: ['trademark', 'apex legends', 'ea', 'respawn', 'notice']
    }
  }
}
