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
    general: 'General',
    recording: 'Recording',
    analysis: 'Import and analysis',
    editing: 'Editing',
    export: 'Export',
    about: 'About'
  },
  catDesc: {
    general: 'Interface language, startup and tray behavior, and where recordings and edited videos are saved.',
    recording: 'When to record, which recorder to use, video and audio quality, and what happens when disk space runs low.',
    analysis: 'How videos get into the library and how highlights are analyzed.',
    editing: 'Preview playback and editing defaults in the studio.',
    export: 'Encoders used when exporting videos.',
    about: 'Version, updates, licenses, and trademark notice.'
  },
  card: {
    ui: 'Interface',
    startup: 'Startup and window',
    storage: 'Storage',
    source: 'Video source',
    perf: 'Analysis performance',
    proxy: 'Preview and proxy files',
    clip: 'Editing defaults',
    export: 'Encoders',
    about: 'Version info'
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
      desc: 'Forcing software decoding applies to analyses started afterward. Videos already being analyzed are not affected. If hardware decoding fails, software decoding is used automatically and you are notified. Preview playback also uses software decoding after you restart Aditor, which can fix slow-motion or out-of-sync preview on some graphics cards.',
      keywords: ['decode', 'decoding', 'hardware', 'software', 'gpu'],
      auto: 'Auto (hardware first)',
      software: 'Force software decoding',
      restartNotice: 'Preview playback uses the new decoding method after Aditor restarts.',
      restartNow: 'Restart now'
    },
    cacheLocation: {
      title: 'Cache location',
      desc: 'Stored in %APPDATA%\\Aditor\\cache by default, not in the Outplayed folder. Applies to analyses started afterward. Videos that were already analyzed can still be opened from their original location.',
      keywords: ['cache', 'location', 'folder', 'appdata', 'storage'],
      appdata: 'App folder',
      besideVideo: 'Next to video (.aditor.json)'
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
      desc: 'Saves to %APPDATA%\\Aditor\\projects\\ after every change. "Save as" is only for sharing. When this is off, the "unsaved changes" prompt returns.',
      keywords: ['project', 'autosave', 'auto save', 'save']
    },
    storageRoot: {
      title: 'Storage location',
      desc: 'Recordings and exported clips are saved inside this folder, so you can back up or move everything at once.',
      keywords: ['storage', 'location', 'folder', 'recordings', 'exports', 'output', 'save', 'path'],
      unset: 'Not set yet (suggested: {dir})',
      change: 'Change…',
      open: 'Open in File Explorer',
      preview: {
        heading: 'Folder layout',
        dayFolder: 'Date',
        recordings: 'Recordings are sorted into date folders',
        merged: 'Clip exports: merged',
        clips: 'Clip exports: separate clips'
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
      desc: 'Licensed under GPL v3. Includes LGPL-licensed ffmpeg.',
      keywords: ['version', 'license', 'about', 'gpl', 'ffmpeg'],
      version: 'Aditor {version}',
      licenses: 'Third-party licenses'
    },
    updateStatus: {
      title: 'Software update',
      desc: 'Checks GitHub for new versions. A new version is downloaded only when you choose "Download update", and installed only when you choose "Restart and update now".',
      keywords: ['update', 'new version', 'version', 'github', 'download'],
      unsupported: 'Automatic updates are not available in the portable or development build',
      idle: 'Not checked yet',
      checking: 'Checking…',
      latest: 'You have the latest version',
      available: 'Version {version} is available',
      downloading: 'Downloading {version} ({pct}%)',
      downloaded: '{version} downloaded; choose "Restart and update now" to install',
      error: 'Update check failed: {msg}',
      check: 'Check for updates',
      download: 'Download update',
      install: 'Restart and update now',
      openReleases: 'Open download page'
    },
    autoUpdate: {
      title: 'Check for updates automatically',
      desc: 'Checks at startup and every 6 hours; never downloads or installs automatically.',
      keywords: ['update', 'automatic', 'github']
    },
    telemetryEnabled: {
      title: 'Share error and performance diagnostics',
      desc: 'Enabled by default: send filtered app, analysis and recording errors and performance data to Sentry. You can turn this off immediately. No videos, screenshots or full interaction history. Restart after re-enabling.',
      keywords: ['sentry', 'diagnostics', 'privacy']
    },
    trademark: {
      title: 'Trademark notice',
      desc: 'Apex Legends is a trademark of Electronic Arts / Respawn. This project is not affiliated with EA or Respawn.',
      keywords: ['trademark', 'apex legends', 'ea', 'respawn', 'notice']
    }
  }
}
