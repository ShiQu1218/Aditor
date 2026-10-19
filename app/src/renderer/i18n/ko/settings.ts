import type { Messages } from '../index'

/** 한국어: 설정 화면(분류, 카드, 각 항목 문자열과 컨트롤 레이블). */
export const settingsI18n: Messages['settingsI18n'] = {
  title: '설정',
  searchPlaceholder: '설정 검색',
  searchLabel: '설정 검색',
  tablistLabel: '설정 분류',
  resultsLabel: '검색 결과',
  noResults: '일치하는 설정이 없습니다',
  noResultsHint: '‘프록시’, ‘초’, ‘인코더’처럼 다른 검색어를 시도해 보세요.',
  hitCount: '{n}개 일치',
  loading: '설정을 불러오는 중…',
  loadFailed: '설정을 읽을 수 없어 기본값을 표시합니다.',
  saveFailed: '저장에 실패했습니다. 이 변경은 현재 창에는 적용되었지만 디스크에 기록되지 않아 다시 시작하면 되돌아갈 수 있습니다. 디스크 공간과 폴더 권한을 확인한 뒤 다시 시도하세요.',
  newTag: '신규',
  comingSoon: '이 기능은 이후 업데이트에서 제공될 예정입니다.',
  cat: {
    general: '일반',
    recording: '녹화',
    analysis: '가져오기와 분석',
    editing: '편집',
    export: '내보내기',
    about: '정보'
  },
  catDesc: {
    general: '인터페이스 언어, 시작 및 시스템 트레이 동작, 녹화와 편집 결과물의 저장 위치.',
    recording: '녹화 시점, 사용할 녹화기, 영상과 오디오 품질, 디스크 공간이 부족할 때의 동작.',
    analysis: '영상을 라이브러리로 가져오는 방법과 하이라이트를 분석하는 방식.',
    editing: '스튜디오의 미리보기 재생과 편집 기본값.',
    export: '영상을 내보낼 때 사용하는 인코더.',
    about: '버전, 라이선스, 상표 고지.'
  },
  card: {
    ui: '인터페이스',
    startup: '시작과 창',
    storage: '저장',
    source: '영상 소스',
    perf: '분석 성능',
    proxy: '미리보기와 프록시 파일',
    clip: '편집 기본값',
    export: '인코더',
    about: '버전 정보'
  },
  row: {
    language: {
      title: '인터페이스 언어',
      desc: '변경하면 창이 다시 로드되어 적용됩니다. 시스템 트레이 메뉴도 함께 바뀝니다. ‘시스템 따름’을 선택하면 Windows 표시 언어에 따라 정해지며, 지원하지 않는 언어이면 영어를 사용합니다.',
      keywords: ['언어', '인터페이스', '번역', '한국어', 'language', 'locale', '중국어', 'english', '日本語'],
      auto: '시스템 따름'
    },
    watchFolders: {
      title: '감시 폴더',
      desc: '새 영상이 안정되면 자동으로 라이브러리에 가져옵니다(자동 분석 여부는 다음 항목에서 설정합니다).',
      keywords: ['폴더', '감시', '가져오기', 'watch', 'folder'],
      add: '폴더 추가',
      remove: '제거',
      removeLabel: '감시 폴더 {dir} 제거',
      empty: '설정된 감시 폴더가 없습니다',
      missing: '폴더를 찾을 수 없습니다',
      list: '설정된 감시 폴더'
    },
    autoAnalyze: {
      title: '새 영상 자동 분석',
      desc: '끄면 가져오기만 하고, 분석은 ‘분석’ 버튼을 눌러야 시작됩니다.',
      keywords: ['분석', '대기열', '자동']
    },
    decode: {
      title: '디코딩 방식',
      desc: '소프트웨어 디코딩 강제는 이후 시작되는 분석부터 적용됩니다(이미 분석 중인 영상에는 영향이 없습니다). 하드웨어 디코딩에 실패하면 자동으로 소프트웨어 디코딩으로 바꾸고 알려 드립니다.',
      keywords: ['디코딩', '하드웨어', '소프트웨어', 'gpu', 'decode'],
      auto: '자동(하드웨어 우선)',
      software: '소프트웨어 디코딩 강제'
    },
    cacheLocation: {
      title: '캐시 위치',
      desc: '기본값은 %APPDATA%\\Aditor\\cache이며, Outplayed 폴더에는 기록하지 않습니다. 변경하면 이후 시작되는 분석부터 적용되며, 이미 분석한 영상은 원래 위치에서도 계속 열 수 있습니다.',
      keywords: ['캐시', '위치', 'cache', 'appdata'],
      appdata: '앱 폴더',
      besideVideo: '영상 옆(.aditor.json)'
    },
    lowPerfMode: {
      title: '저성능 모드',
      desc: '애니메이션을 끄고, 썸네일은 정적 이미지로 바꾸며, 타임라인 밀도 막대를 60칸으로 줄입니다.',
      keywords: ['저성능', '성능', '애니메이션', 'performance']
    },
    proxySuggest: {
      title: '재생이 끊기면 프록시 파일 만들기 제안',
      desc: 'mediaCapabilities로 판단합니다. 내보내기에는 항상 원본 파일을 사용합니다.',
      keywords: ['프록시', '제안', 'proxy', '미리보기']
    },
    proxyUsage: {
      title: '프록시 파일 사용 공간',
      desc: '삭제해도 필요할 때 다시 만들 수 있습니다.',
      keywords: ['프록시', '삭제', '사용량', '공간', 'proxy'],
      summary: '{size}({count}개 파일)',
      none: '현재 프록시 파일이 없습니다',
      unknown: '사용 공간을 확인할 수 없습니다',
      delete: '프록시 파일 모두 삭제',
      confirm: '정말 삭제할까요?',
      cancel: '취소',
      deleted: '프록시 파일 {n}개를 삭제했습니다',
      failed: '프록시 파일 {n}개를 삭제할 수 없습니다'
    },
    beforeAfter: {
      title: '이벤트 미리보기 시간(초)',
      desc: '이벤트로 이동할 때 지정한 시간(초)만큼 앞당겨 보여 줍니다. 기본값은 8초이며, 범위는 0–30초입니다. 이벤트 후 시간(초) 설정은 이전 버전과의 호환을 위해서만 남아 있으며, 빠른 편집은 블레이드로 선택한 시작점과 끝점을 따릅니다.',
      keywords: ['초', '시간', '앞뒤', '전후', '빠른 편집', '합본', 'before', 'after'],
      before: '이벤트 전 시간(초)',
      after: '이벤트 후 시간(초)(이전 버전 설정)',
      decrease: '{name} 줄이기',
      increase: '{name} 늘리기',
      unit: '초'
    },
    autoclip: {
      title: 'AI 자동 편집 기본 매개변수',
      desc: '‘AI 자동 편집’ 패널에서 임시로 조정할 수 있습니다. 여기서는 패널을 열 때의 시작값을 정합니다.',
      keywords: ['ai', '자동 편집', '매개변수', '설정', '킬', 'gap', 'max_len', '하이라이트'],
      n: '최소 킬 수 n(1–10)',
      gap: '인접 킬 최대 간격 gap(5–60초)',
      before: '첫 킬 전 before(0–30초)',
      after: '마지막 킬 후 after(0–30초)',
      max_len: '클립 최대 길이 max_len 초(15–300)'
    },
    autoSuggestOnOpen: {
      title: '영상을 열면 하이라이트 제안 자동 생성',
      desc: '기본 매개변수로 한 번 실행해 제안 상자만 표시합니다. 프로젝트에 자동으로 추가되지는 않습니다.',
      keywords: ['자동', '제안', '하이라이트', '영상 열기']
    },
    projectAutosave: {
      title: '프로젝트 자동 저장',
      desc: '변경할 때마다 %APPDATA%\\Aditor\\projects\\에 자동으로 저장됩니다. ‘다른 이름으로 저장’은 공유 용도로만 사용됩니다. 끄면 ‘저장하지 않은 변경 사항’ 안내가 다시 표시됩니다.',
      keywords: ['프로젝트', '자동 저장', 'autosave', '저장']
    },
    storageRoot: {
      title: '저장 위치',
      desc: '녹화와 편집 결과물은 모두 이 폴더 아래에 저장되어, 한꺼번에 백업하거나 옮기기 쉽습니다.',
      keywords: ['저장', '위치', '폴더', '녹화', '출력', '내보내기', 'storage', 'folder', 'recordings', 'exports'],
      unset: '아직 설정되지 않음(권장: {dir})',
      change: '변경…',
      open: '파일 탐색기에서 열기',
      preview: {
        heading: '폴더 구조',
        dayFolder: '날짜',
        recordings: '녹화는 날짜별 폴더에 저장',
        merged: '편집 결과: 병합',
        clips: '편집 결과: 클립별 저장'
      }
    },
    encoders: {
      title: '사용 가능한 인코더',
      desc: '정밀 재인코딩은 NVENC, QSV, AMF 순서로 하드웨어 인코더를 고릅니다.',
      keywords: ['인코더', 'nvenc', 'qsv', 'amf', 'encoder', 'gpu'],
      redetect: '다시 감지',
      detecting: '감지 중…',
      notDetected: '아직 감지하지 않음',
      available: '사용 가능',
      unavailable: '사용 불가'
    },
    openh264: {
      title: 'OpenH264(CPU 인코딩)',
      desc: '하드웨어 인코더가 없거나 프록시 미리보기 파일을 만들 때만 사용합니다. 라이선스 때문에 프로그램에 포함되어 있지 않으며, 동의하면 여기에서 다운로드할 수 있습니다.',
      keywords: ['openh264', 'cisco', 'cpu', '인코딩'],
      installed: '설치됨',
      notInstalled: '설치되지 않음',
      unknown: '상태 알 수 없음',
      download: '다운로드',
      redownload: '다시 다운로드',
      consent: '라이선스를 준수하기 위해 이 프로그램은 OpenH264를 포함하지 않습니다. 동의하면 Cisco 공식 주소 ciscobinary.openh264.org에서 공식 DLL(약 0.4MB)을 다운로드합니다.',
      accept: '동의하고 다운로드',
      decline: '취소',
      downloading: '다운로드 중 {pct}%',
      failed: 'OpenH264 다운로드 실패: {msg}'
    },
    about: {
      title: '버전과 라이선스',
      desc: 'MIT 라이선스. LGPL 버전의 ffmpeg가 함께 제공됩니다.',
      keywords: ['버전', '라이선스', '정보', 'license', 'version', 'mit', 'ffmpeg'],
      version: 'Aditor {version}',
      licenses: '서드파티 라이선스'
    },
    trademark: {
      title: '상표 고지',
      desc: 'Apex Legends는 Electronic Arts / Respawn의 상표이며, 본 프로젝트와는 무관합니다.',
      keywords: ['상표', 'apex legends', 'ea', 'respawn', '고지']
    }
  }
}
