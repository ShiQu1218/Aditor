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
  onboarding: {
    progress: 'Step {n} of {total}',
    skip: 'Later',
    back: 'Back',
    next: 'Next',
    finish: 'Get started',
    saving: 'Saving…',
    welcome: {
      title: 'Welcome to Aditor',
      body: 'A few quick settings and you are ready to go: choose your display language, pick where files are saved, and choose how to record. You can change any of these later in Settings.',
      languageLabel: 'Display language',
      languageAuto: 'Follow system'
    },
    storage: {
      title: 'Where should files be saved?',
      body: 'Recordings and exported clips are kept in the same folder, so you can back up or move them all at once.',
      current: 'Storage location',
      choose: 'Choose folder…',
      loading: 'Finding a suggested location…'
    },
    recording: {
      title: 'Recording settings',
      body: 'You can change these later in the Recording tab of Settings.',
      modeLabel: 'Recording mode',
      modeSessionDesc: 'Records from when Apex opens until you close it, saved as one complete video.',
      modeMatchDesc: 'Saves each match as its own video. The lobby keeps only the last 15 seconds or so in a buffer, so it takes no disk space.',
      resolution: 'Resolution',
      fps: 'Frame rate',
      bitrate: 'Bitrate (kbps)'
    },
    done: {
      title: 'All set',
      summaryStorage: 'Storage location: {dir}',
      summaryMode: 'Recording mode: {mode}',
      summaryQuality: 'Quality: {height}, {fps} fps, {bitrate} kbps',
      nextHeading: 'What happens next',
      next1: 'Recording starts automatically when you open Apex Legends.',
      next2: 'After a recording ends, it is analyzed automatically to find highlights.',
      next3: 'Go to Studio to pick clips and export them.'
    }
  },
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
