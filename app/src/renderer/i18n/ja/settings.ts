import type { Messages } from '../index'

/** Settings screen: categories, cards, row text, and control labels. */
export const settingsI18n: Messages['settingsI18n'] = {
  title: '設定',
  searchPlaceholder: '設定を検索',
  searchLabel: '設定を検索',
  tablistLabel: '設定カテゴリ',
  resultsLabel: '検索結果',
  noResults: '一致する設定はありません',
  noResultsHint: '「プロキシ」「秒数」「エンコーダー」などほかのキーワードも試してください。',
  hitCount: '{n} 件一致',
  loading: '設定を読み込み中…',
  loadFailed: '設定を読み込めなかったため、既定値を表示しています。',
  saveFailed: '保存に失敗しました。この変更は現在のウィンドウには反映されていますが、ディスクには書き込まれていないため、再起動すると元に戻る可能性があります。ディスクの空き容量とフォルダーの権限を確認してから、もう一度お試しください。',
  newTag: 'NEW',
  comingSoon: 'この機能は今後のアップデートで提供予定です。',
  cat: {
    general: '一般',
    recording: '録画',
    analysis: '取り込みと分析',
    editing: '編集',
    export: '書き出し',
    about: '情報'
  },
  catDesc: {
    general: '表示言語、起動とシステムトレイの動作、録画と書き出し動画の保存先。',
    recording: '録画のタイミング、使うレコーダー、映像と音声の品質、ディスク容量が不足したときの動作。',
    analysis: '動画をライブラリに取り込む方法と、ハイライトの分析方法。',
    editing: 'スタジオでのプレビュー再生とクリップ編集の既定値。',
    export: '動画の書き出しに使うエンコーダー。',
    about: 'バージョン、アップデート、ライセンス、商標について。'
  },
  card: {
    ui: '表示',
    startup: '起動とウィンドウ',
    storage: '保存先',
    source: '動画ソース',
    perf: '分析のパフォーマンス',
    proxy: 'プレビューとプロキシファイル',
    clip: 'クリップ編集の既定値',
    export: 'エンコーダー',
    about: 'バージョン情報'
  },
  row: {
    language: {
      title: '表示言語',
      desc: '変更するとウィンドウが再読み込みされて適用されます。システムトレイのメニューも同時に更新されます。「システムに従う」を選ぶと、Windows の表示言語に従います（対応していない言語の場合は英語になります）。',
      keywords: ['言語', '表示', '翻訳', 'language', 'locale', '中国語', '中文', 'english', '日本語', '한국어'],
      auto: 'システムに従う'
    },
    watchFolders: {
      title: '監視フォルダー',
      desc: '新しい動画の書き込みが完了すると、自動でライブラリに取り込まれます（自動分析するかどうかは次の項目）。',
      keywords: ['フォルダー', '監視', '取り込み', 'インポート', 'watch', 'folder'],
      add: 'フォルダーを追加',
      remove: '削除',
      removeLabel: '監視フォルダー {dir} を削除',
      empty: '監視フォルダーが設定されていません',
      missing: 'このフォルダーが見つかりません',
      list: '設定済みの監視フォルダー'
    },
    autoAnalyze: {
      title: '新しい動画を自動で分析',
      desc: 'オフにすると取り込みのみ行い、「分析」を手動で押す必要があります。',
      keywords: ['分析', 'キュー', '自動']
    },
    decode: {
      title: 'デコード方式',
      desc: 'ソフトウェアデコードを強制すると、以後開始する分析から適用されます（分析中の動画には影響しません）。ハードウェアデコードに失敗した場合は、自動的にソフトウェアデコードに切り替えて通知します。プレビュー再生も Aditor の再起動後にソフトウェアデコードになり、一部のグラフィックカードで起きるプレビューのスロー再生や音ズレを改善できます。',
      keywords: ['デコード', 'ハードウェア', 'ソフトウェア', 'gpu', 'decode'],
      auto: '自動（ハードウェア優先）',
      software: 'ソフトウェアデコードを強制',
      restartNotice: 'プレビュー再生のデコード方式は Aditor の再起動後に適用されます。',
      restartNow: '今すぐ再起動'
    },
    cacheLocation: {
      title: 'キャッシュの場所',
      desc: '既定では %APPDATA%\\Aditor\\cache に保存され、Outplayed のフォルダーには書き込みません。変更は以後開始する分析に適用されます。分析済みの動画は元の場所からそのまま開けます。',
      keywords: ['キャッシュ', '場所', 'cache', 'appdata'],
      appdata: 'アプリのフォルダー',
      besideVideo: '動画の隣（.aditor.json）'
    },
    lowPerfMode: {
      title: '低パフォーマンスモード',
      desc: 'アニメーションを停止し、サムネイルを静止画にして、タイムラインのヒートマップを 60 マスに減らします。',
      keywords: ['低パフォーマンス', 'パフォーマンス', 'アニメーション', 'performance']
    },
    proxySuggest: {
      title: '再生がスムーズでない場合はプロキシファイルを推奨',
      desc: 'mediaCapabilities で判定します。書き出しには常に元のファイルを使用します。',
      keywords: ['プロキシ', '推奨', 'proxy', 'プレビュー']
    },
    proxyUsage: {
      title: 'プロキシファイルの使用容量',
      desc: '削除しても、必要になったときに再生成できます。',
      keywords: ['プロキシ', '削除', '使用量', '容量', 'proxy'],
      summary: '{size}（{count} 個のファイル）',
      none: '現在プロキシファイルはありません',
      unknown: '使用容量を取得できません',
      delete: 'すべてのプロキシファイルを削除',
      confirm: '本当に削除しますか？',
      cancel: 'キャンセル',
      deleted: '{n} 個のプロキシファイルを削除しました',
      failed: '{n} 個のプロキシファイルを削除できませんでした'
    },
    beforeAfter: {
      title: 'イベントのプレビュー秒数',
      desc: 'イベントへジャンプする際、指定した秒数だけ手前から再生します。既定値は 8 秒、範囲は 0〜30 秒です。後の秒数は旧設定の保持のみで、クイッククリップではブレードで選んだ開始・終了位置が優先されます。',
      keywords: ['秒数', '前後', 'クイッククリップ', 'まとめ', 'before', 'after'],
      before: 'イベント前の秒数',
      after: 'イベント後の秒数（旧設定）',
      decrease: '{name}を減らす',
      increase: '{name}を増やす',
      unit: '秒'
    },
    autoclip: {
      title: 'AI 自動クリップの既定パラメーター',
      desc: '「AI 自動クリップ」のオーバーレイで一時的に変更できます。ここはオーバーレイを開いたときの初期値です。',
      keywords: ['ai', '自動クリップ', 'パラメーター', 'gap', 'max_len', 'ハイライト'],
      n: '最小キル数 n（1〜10）',
      gap: '隣接イベントの最大間隔 gap 秒（5〜60）',
      before: '最初のキル前 before 秒（0〜30）',
      after: '最後のキル後 after 秒（0〜30）',
      max_len: 'クリップの最大長 max_len 秒（15〜300）'
    },
    autoSuggestOnOpen: {
      title: '動画を開いたときにハイライトの提案を自動生成',
      desc: '既定のパラメーターで一度実行し、提案枠を置くだけです。プロジェクトへは自動で追加されません。',
      keywords: ['自動', '提案', 'ハイライト', '動画を開く']
    },
    projectAutosave: {
      title: 'プロジェクトの自動保存',
      desc: '変更するたびに %APPDATA%\\Aditor\\projects\\ へ自動保存されます。「名前を付けて保存」は共有用にのみ使われます。オフにすると、「未保存の変更」の確認が再び表示されます。',
      keywords: ['プロジェクト', '自動保存', 'autosave', '保存']
    },
    storageRoot: {
      title: '保存場所',
      desc: '録画と編集の出力は、すべてこのフォルダーの下に保存されます。一括バックアップや移動に便利です。',
      keywords: ['保存', '場所', 'フォルダー', '録画', '出力', '書き出し', 'storage', 'folder', 'recordings', 'exports'],
      unset: '未設定（推奨：{dir}）',
      change: '変更…',
      open: 'エクスプローラーで開く',
      preview: {
        heading: 'フォルダー構成',
        dayFolder: '日付',
        recordings: '録画は日付ごとにフォルダーを分ける',
        merged: '編集出力：結合',
        clips: '編集出力：クリップごと'
      }
    },
    encoders: {
      title: '利用可能なエンコーダー',
      desc: '正確な再エンコードでは、NVENC、QSV、AMF の順にハードウェアエンコーダーを選びます。',
      keywords: ['エンコーダー', 'nvenc', 'qsv', 'amf', 'encoder', 'gpu'],
      redetect: '再検出',
      detecting: '検出中…',
      notDetected: '未検出',
      available: '利用可能',
      unavailable: '利用不可'
    },
    openh264: {
      title: 'OpenH264（CPU エンコード）',
      desc: 'ハードウェアエンコーダーがない場合、またはプレビュー用のプロキシファイルを生成する場合にのみ使用します。ライセンス上同梱していないため、同意のうえここからダウンロードできます。',
      keywords: ['openh264', 'cisco', 'cpu', 'エンコード'],
      installed: 'インストール済み',
      notInstalled: '未インストール',
      unknown: '状態不明',
      download: 'ダウンロード',
      redownload: '再ダウンロード',
      consent: 'ライセンスに従い、本プログラムには OpenH264 を同梱していません。同意すると、Cisco の公式サイト ciscobinary.openh264.org から公式 DLL（約 0.4 MB）をダウンロードします。',
      accept: '同意してダウンロード',
      decline: 'キャンセル',
      downloading: 'ダウンロード中 {pct}%',
      failed: 'OpenH264 のダウンロードに失敗しました：{msg}'
    },
    about: {
      title: 'バージョンとライセンス',
      desc: 'GPL v3 ライセンス。LGPL 版の ffmpeg を同梱しています。',
      keywords: ['バージョン', 'ライセンス', '情報', 'license', 'version', 'gpl', 'ffmpeg'],
      version: 'Aditor {version}',
      licenses: 'サードパーティライセンス'
    },
    updateStatus: {
      title: 'ソフトウェアのアップデート',
      desc: 'GitHub で新しいバージョンを確認します。「アップデートをダウンロード」を選んだときだけダウンロードし、「今すぐ再起動してアップデート」を選んだときだけインストールします。',
      keywords: ['アップデート', '更新', '新バージョン', 'バージョン', 'update', 'github', 'ダウンロード'],
      unsupported: 'ポータブル版と開発版は自動アップデートに対応していません',
      idle: '未確認',
      checking: '確認中…',
      latest: '最新バージョンです',
      available: '新しいバージョン {version} を利用できます',
      downloading: '{version} をダウンロード中（{pct}%）',
      downloaded: '{version} をダウンロードしました。「今すぐ再起動してアップデート」でインストールします',
      error: 'アップデートの確認に失敗しました：{msg}',
      check: 'アップデートを確認',
      download: 'アップデートをダウンロード',
      install: '今すぐ再起動してアップデート',
      openReleases: 'ダウンロードページを開く'
    },
    autoUpdate: {
      title: 'アップデートを自動で確認',
      desc: '起動時と 6 時間ごとに確認します。自動でのダウンロードやインストールは行いません。',
      keywords: ['アップデート', '更新', '自動', 'update', 'github']
    },
    telemetryEnabled: {
      title: 'エラーとパフォーマンス診断を共有',
      desc: '初期設定でフィルタリング済みのアプリ・分析・録画エラーと性能データを Sentry に送信します。いつでも無効にできます。動画・スクリーンショット・操作履歴は含みません。再有効化後は再起動してください。',
      keywords: ['sentry', 'diagnostics', 'privacy']
    },
    trademark: {
      title: '商標について',
      desc: 'Apex Legends は Electronic Arts／Respawn の商標であり、本プロジェクトとは無関係です。',
      keywords: ['商標', 'apex legends', 'ea', 'respawn', '表記']
    }
  }
}
