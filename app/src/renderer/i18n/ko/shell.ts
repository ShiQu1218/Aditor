import type { Messages } from '../index'

/** 한국어: 앱 셸(사이드 레일, 단축키 안내, 알림 영역) 문자열. */
export const shellI18n: Messages['shellI18n'] = {
  rail: {
    library: '라이브러리',
    studio: '스튜디오(하이라이트 + 프로젝트)',
    studioLabel: '스튜디오',
    queue: '분석 대기열',
    shortcuts: '단축키 (?)',
    shortcutsLabel: '단축키',
    settings: '설정',
    mainNav: '주 메뉴'
  },
  settings: { title: '설정' },
  shortcutsDialog: {
    title: '단축키 안내',
    close: '닫기',
    hint: 'Esc를 누르면 닫힙니다. 입력란에 입력하는 문자는 단축키를 실행하지 않습니다.',
    keysLabel: '키'
  },
  toastHost: { label: '알림' },
  onboarding: {
    progress: '{total}단계 중 {n}단계',
    skip: '나중에',
    back: '이전',
    next: '다음',
    finish: '시작하기',
    saving: '저장 중…',
    welcome: {
      title: 'Apex Highlighter에 오신 것을 환영합니다',
      body: '몇 가지만 설정하면 바로 시작할 수 있습니다. 표시 언어를 고르고, 파일을 저장할 위치를 정하고, 녹화 방식을 선택하세요. 나중에도 설정에서 바꿀 수 있습니다.',
      languageLabel: '표시 언어',
      languageAuto: '시스템 언어 따르기'
    },
    storage: {
      title: '파일은 어디에 저장할까요?',
      body: '녹화와 편집 결과물은 같은 폴더 아래에 저장되어, 한꺼번에 백업하거나 옮기기 쉽습니다.',
      current: '저장 위치',
      choose: '폴더 선택…',
      loading: '추천 위치를 가져오는 중…'
    },
    recording: {
      title: '녹화 설정',
      body: '이 설정은 나중에 설정의 녹화 탭에서도 바꿀 수 있습니다.',
      modeLabel: '녹화 모드',
      modeSessionDesc: 'Apex를 켠 순간부터 끌 때까지, 하나의 완전한 영상으로 저장합니다.',
      modeMatchDesc: '매치마다 영상 하나로 저장합니다. 로비는 최근 약 15초만 임시로 보관하므로 디스크를 차지하지 않습니다.',
      resolution: '해상도',
      fps: '프레임 레이트',
      bitrate: '비트레이트(kbps)'
    },
    done: {
      title: '설정이 모두 끝났습니다',
      summaryStorage: '저장 위치: {dir}',
      summaryMode: '녹화 모드: {mode}',
      summaryQuality: '화질: {height}, {fps} fps, {bitrate} kbps',
      nextHeading: '이제 이런 일이 일어납니다',
      next1: 'Apex Legends를 실행하면 자동으로 녹화가 시작됩니다.',
      next2: '녹화가 끝나면 자동으로 분석해 하이라이트 장면을 찾습니다.',
      next3: '스튜디오에서 장면을 골라 내보내세요.'
    }
  },
  keymap: {
    scope: {
      global: '전역',
      studio: '스튜디오',
      source: '원본 타임라인',
      hl: '하이라이트 목록',
      proj: '프로젝트 트랙',
      library: '라이브러리',
      settings: '설정'
    },
    cmd: {
      play: '재생/일시정지',
      speed: '재생 속도 전환',
      prevEvent: '이전 이벤트',
      nextEvent: '다음 이벤트',
      seekBack: '5초 뒤로',
      seekFwd: '5초 앞으로',
      zoomIn: '타임라인 확대',
      zoomOut: '타임라인 축소',
      zoomReset: '타임라인 전체 보기',
      quickOrSplit: '블레이드 모드 전환(프로젝트 미리보기에서는 재생 헤드 위치에서 분할)',
      blade: '블레이드 모드 전환(빠른 편집)',
      addEvent: '이벤트 추가',
      setStart: '현재 클립 시작점 = 재생 헤드',
      setEnd: '현재 클립 끝점 = 재생 헤드',
      addAllToProject: '프로젝트에 추가(제안 전체)',
      acceptSuggestion: '현재 제안 추가',
      skipSuggestion: '현재 제안 건너뛰기',
      deleteProjectItem: '선택한 클립 삭제',
      duplicateItem: '선택한 클립 복제',
      moveItemLeft: '선택한 클립을 앞으로 이동',
      moveItemRight: '선택한 클립을 뒤로 이동',
      playItem: '해당 클립 재생',
      undo: '실행 취소',
      redo: '다시 실행',
      openExport: '내보내기 패널 열기',
      toggleAside: '사이드바 표시/숨기기',
      backToSource: '원본 모드로 돌아가기',
      closeOverlay: '오버레이 닫기',
      showShortcuts: '단축키 안내',
      focusToast: '최신 알림으로 이동([실행 취소]를 누를 수 있음)',
      focusSearch: '검색창으로 이동',
      toggleFavoriteFilter: '즐겨찾기만 보기 전환',
      selectPrevItem: '이전 클립 선택',
      selectNextItem: '다음 클립 선택',
      listPrev: '이전 항목',
      listNext: '다음 항목'
    }
  }
}
