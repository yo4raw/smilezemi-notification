/**
 * DOMセレクタ定義
 * Requirements: 2.1, 2.2, 3.1, 3.2
 *
 * 調査日: 2025-12-25
 * 調査方法: scripts/investigate-selectors.js による実サイト調査
 */

module.exports = {
  // ログインページのセレクタ
  login: {
    url: 'https://smile-zemi.jp/mimamoru-net/ui/login',

    // フォーム要素
    usernameField: 'input[name="userId"]',       // type="email"
    passwordField: 'input[name="password"]',     // type="password"
    submitButton: 'button:has-text("ログイン")', // ログインボタン
    rememberMeCheckbox: 'input[name="rememberMe"]', // ログイン状態保持

    // 検証用セレクタ
    loginForm: 'form',
    errorMessage: '.error-message, [role="alert"]',

    // ページ遷移検証
    successUrlPattern: /^(?!.*\/login).*$/  // /login を含まないURLへの遷移で成功と判断
  },

  // ダッシュボードのセレクタ
  dashboard: {
    // ユーザー選択UI（調査結果待ち）
    userSelector: 'select[name="user"]',
    userSelectorAlternative: '[data-testid*="user"]',
    userOption: 'option',

    // ミッション数表示要素（調査結果待ち）
    missionCount: 'text=/\\d+ミッション/',
    missionCountAlternative: '[data-testid*="mission"]',
    missionText: 'span:has-text("ミッション")',

    // 日付表示
    currentDate: '.date, [data-testid="date"]'
  },

  // 待機戦略設定
  waitStrategies: {
    // ページロード待機
    pageLoad: 'domcontentloaded',
    timeout: 60000,  // 60秒

    // DOM要素の待機
    elementTimeout: 30000,  // 30秒

    // ユーザー切り替え後の待機時間
    userSwitchDelay: 3000,  // 3秒

    // 追加の安定化待機
    stabilizationDelay: 1000  // 1秒
  },

  // エラー検出用セレクタ
  errors: {
    loginError: '.error-message, [role="alert"], .alert-danger',
    networkError: 'text=/ネットワークエラー|通信エラー/',
    sessionExpired: 'text=/セッション|タイムアウト/'
  },

  // コース選択のセレクタ
  // DOM調査日: 2026-01-16 (scripts/investigate-course-selection.js で確認)
  courseSelection: {
    // ユーザー選択後に表示されるコース選択画面
    juniorHighSchool: 'text="中学生コース"',  // 中学生コース
    elementarySchool: 'text="小学生コース"',  // 小学生コース
    // コース選択確認用の待機時間
    courseSelectionWaitTime: 2000  // 2秒
  },

  // ミッション詳細のセレクタ（Requirements: 1.1, 2.2, 3.1）
  // DOM調査日: 2025-12-30 (scripts/investigate-study-details.js で確認)
  missionDetails: {
    // 勉強時間セレクタ（確定）
    // 調査結果: .totalStudyTime__ZyyiE, .minute__SnMnp が存在
    // パターン: "5分" のような表示（時間は別要素の可能性あり）
    studyTime: {
      selector: 'text=/\\d+時間\\d+分/',
      alternativeSelectors: [
        '.totalStudyTime__ZyyiE',
        '.minute__SnMnp',
        '[class*="studyTime"]',
        '[class*="study-time"]',
        'text=/\\d+分/'  // 分のみの表示も対応
      ],
      pattern: /(\d+)時間(\d+)分/  // hours, minutes をキャプチャ
    },

    // ミッション要素（既存、確認済み: 26件検出）
    missionIcon: '.missionIcon__i6nW8',

    // ミッション名セレクタ（確定）
    // 調査結果: .title__C3bzF が実際のミッション名クラス
    // 親要素: .subIcon__p_BWc
    missionName: {
      selector: '.title__C3bzF',
      alternativeSelectors: [
        '[class*="title"]',
        '[class*="mission-title"]',
        '[class*="missionTitle"]',
        '.missionIcon__i6nW8 + *'  // アイコンの兄弟要素（フォールバック）
      ],
      defaultName: 'ミッション'  // 取得失敗時のデフォルト値
    },

    // ミッション点数セレクタ（確定）
    // 調査結果: .scoreLabel__LpVbL が「前回 XX点」の形式
    // パターン: "100点" のような表示（38件検出）
    missionScore: {
      selector: 'text=/\\d+点/',
      alternativeSelectors: [
        '.scoreLabel__LpVbL',
        '[class*="score"]',
        '[class*="point"]'
      ],
      pattern: /(\d+)点/,  // score をキャプチャ
      defaultScore: 0      // 取得失敗時のデフォルト値
    },

    // NEWラベル（確認済み: "NEWミッション" として検出）
    newLabel: 'text="NEW"'
  },

  // 中学生コース タイムラインのセレクタ
  // DOM調査日: 2026-04-02 (Playwrightで実サイト調査)
  // 中学生コースのURL: /study/c/timeline（小学生コースの /study/s/timeline とは別UI）
  juniorHighTimeline: {
    root: '.timeline_root__He2PS',
    dailyRoot: '.dailyRoot__a754V',
    studyDate: '.studyDate__GL9tf',
    studyDateInner: '.studyDateInner__s0Jtj',
    dateLabel: '.date__FKSSm',
    subjectsContainer: '.subjects__eHK8S',
    subjectGroup: '.subject__bWHro',
    subjectName: '.name__TRpmJ',
    subjectTime: '.time__Pn3gb',
    courseName: '.name__nAtRj',
    courseResult: '.current__PxOK0',
    // フォールバック（ハッシュ変更対策）
    alternativeSelectors: {
      dailyRoot: '[class*="dailyRoot"]',
      dateLabel: '[class*="date__F"]',
      subjectGroup: '[class*="subject__b"]',
      courseName: '[class*="name__"][class*="limit3Line"]',
      courseResult: '[class*="current__"]'
    }
  },

  // 週間レポート（指導レポート）のセレクタ
  // DOM調査日: 2026-03-16 (scripts/explore-guidance-report.js で確認)
  weeklyReport: {
    // 指導レポートタブ
    reportTab: 'button:has-text("指導レポート")',
    // セクションタイトル（「とりくみの様子」「今後の指導」）
    sectionTitle: '.title__jXeZJ',
    // セクションキャプション（「週のとりくみ」）
    sectionCaption: '.caption__dfUam',
    // サブセクションキャプション（「褒めポイント」「とりくみ時間」）
    subCaption: '.caption__mUTwZ',
    // 注記
    note: '.note__Kg016',
    // タブクリック後の待機時間
    tabClickWaitTime: 5000
  }
};
