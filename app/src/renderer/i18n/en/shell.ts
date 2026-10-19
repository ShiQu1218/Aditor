import type { Messages } from '../index'

export const shellI18n: Messages['shellI18n'] = {
  rail: {
    library: 'Library',
    studio: 'Studio (highlights and projects)',
    studioLabel: 'Studio',
    queue: 'Analysis queue',
    shortcuts: 'Keyboard shortcuts (?)',
    shortcutsLabel: 'Shortcuts',
    settings: 'Settings',
    mainNav: 'Main navigation'
  },
  settings: { title: 'Settings' },
  shortcutsDialog: {
    title: 'Keyboard shortcuts',
    close: 'Close',
    hint: 'Press Esc to close. Characters typed in input fields do not trigger shortcuts.',
    keysLabel: 'Keys'
  },
  toastHost: { label: 'Notifications' },
  keymap: {
    scope: {
      global: 'Global',
      studio: 'Studio',
      source: 'Source timeline',
      hl: 'Highlight list',
      proj: 'Project track',
      library: 'Library',
      settings: 'Settings'
    },
    cmd: {
      play: 'Play / pause',
      speed: 'Change playback speed',
      prevEvent: 'Previous event',
      nextEvent: 'Next event',
      seekBack: 'Back 5 seconds',
      seekFwd: 'Forward 5 seconds',
      zoomIn: 'Zoom in timeline',
      zoomOut: 'Zoom out timeline',
      zoomReset: 'Reset timeline to full view',
      quickOrSplit: 'Toggle blade mode (in project preview: split at playhead)',
      blade: 'Toggle blade mode (quick clip)',
      addEvent: 'Add event',
      setStart: 'Set current clip start to playhead',
      setEnd: 'Set current clip end to playhead',
      addAllToProject: 'Add to project (all suggestions)',
      acceptSuggestion: 'Add current suggestion',
      skipSuggestion: 'Skip current suggestion',
      deleteProjectItem: 'Delete selected clip',
      duplicateItem: 'Duplicate selected clip',
      moveItemLeft: 'Move selected clip earlier',
      moveItemRight: 'Move selected clip later',
      playItem: 'Play this clip',
      undo: 'Undo',
      redo: 'Redo',
      openExport: 'Open export drawer',
      toggleAside: 'Show / hide sidebar',
      backToSource: 'Return to source mode',
      closeOverlay: 'Close overlay',
      showShortcuts: 'Keyboard shortcuts',
      focusToast: 'Focus latest notification (press Undo if available)',
      focusSearch: 'Focus search',
      toggleFavoriteFilter: 'Toggle favorites-only filter',
      selectPrevItem: 'Select previous clip',
      selectNextItem: 'Select next clip',
      listPrev: 'Previous item',
      listNext: 'Next item'
    }
  }
}
