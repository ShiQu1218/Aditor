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
