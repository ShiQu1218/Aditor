import type { Messages } from '../index'

/** 設定画面：カテゴリ、カード、各行のテキストとコントロールのラベル。 */
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
  newTag: '新規',
  comingSoon: 'この機能は今後のアップデートで提供予定です。',
  cat: {
    a: '動画と分析',
    b: 'プレビューとクリップ編集',
    c: '書き出しと情報',
    recording: '録画'
  },
  card: {
    general: '一般',
    source: '動画ソース',
    perf: '分析とパフォーマンス',
    proxy: 'プレビューとプロキシファイル',
    clip: 'クリップ編集の既定値',
    export: '書き出し',
    about: '情報'
  },
  row: {
    language: {
      title: '表示言語',
      desc: '変更するとウィンドウが再読み込みされて適用されます。システムトレイのメニューも同時に更新されます。「システムに従う」を選ぶと、Windows の表示言語に従います。',
      keywords: ['言語', '表示', '翻訳', 'language', 'locale', '中国語', 'english', '日本語', '한국어'],
      auto: 'システムに従う'
    },
    watchFolders: {
      title: '監視フォルダー',
      desc: '新しい動画が安定すると、自動でライブラリに取り込まれます（自動分析するかどうかは次の項目）。',
      keywords: ['フォルダー', '監視', '取り込み', 'watch', 'folder'],
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
      desc: 'ソフトウェアデコードを強制すると、以後開始する分析から適用されます（分析中の動画には影響しません）。ハードウェアデコードに失敗した場合は、自動的にソフトウェアデコードに切り替えて通知します。',
      keywords: ['デコード', 'ハードウェア', 'ソフトウェア', 'gpu', 'decode'],
      auto: '自動（ハードウェア優先）',
      software: 'ソフトウェアデコードを強制'
    },
    cacheLocation: {
      title: 'キャッシュの場所',
      desc: '既定では %APPDATA%\\ApexHighlighter\\cache に保存され、Outplayed のフォルダーには書き込みません。変更は以後開始する分析に適用されます。分析済みの動画は元の場所からそのまま開けます。',
      keywords: ['キャッシュ', '場所', 'cache', 'appdata'],
      appdata: 'アプリのフォルダー',
      besideVideo: '動画の隣（.apexhl.json）'
    },
    lowPerfMode: {
      title: '低パフォーマンスモード',
      desc: 'アニメーションを停止し、サムネイルを静止画にして、タイムラインの熱量バーを 60 マスに減らします。',
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
      gap: '隣接する最大間隔 gap 秒（5〜60）',
      before: '最初のキル前 before 秒（0〜30）',
      after: '最後のキル後 after 秒（0〜30）',
      max_len: 'クリップの最長 max_len 秒（15〜300）'
    },
    autoSuggestOnOpen: {
      title: '動画を開いたときにハイライトの提案を自動生成',
      desc: '既定のパラメーターで一度実行し、提案枠を置くだけです。プロジェクトへは自動で追加されません。',
      keywords: ['自動', '提案', 'ハイライト', '動画を開く']
    },
    projectAutosave: {
      title: 'プロジェクトの自動保存',
      desc: '変更するたびに %APPDATA%\\ApexHighlighter\\projects\\ へ自動保存されます。「名前を付けて保存」は共有用にのみ使われます。オフにすると、「未保存の変更」の確認が再び表示されます。',
      keywords: ['プロジェクト', '自動保存', 'autosave', '保存']
    },
    defaultOutDir: {
      title: '既定の出力フォルダー',
      desc: '書き出しドロワーの初期フォルダーです。未設定の場合は毎回確認します。',
      keywords: ['書き出し', '出力', 'フォルダー', 'export'],
      choose: 'フォルダーを選択',
      clear: 'クリア',
      unset: '毎回確認',
      current: '現在：{dir}'
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
      desc: 'MIT ライセンス。LGPL 版の ffmpeg を同梱しています。',
      keywords: ['バージョン', 'ライセンス', '情報', 'license', 'version', 'mit', 'ffmpeg'],
      version: 'Apex Highlighter {version}',
      licenses: 'サードパーティライセンス'
    },
    trademark: {
      title: '商標について',
      desc: 'Apex Legends は Electronic Arts／Respawn の商標であり、本プロジェクトとは無関係です。',
      keywords: ['商標', 'apex legends', 'ea', 'respawn', '表記']
    }
  }
}
