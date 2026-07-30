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
    stabilizationDelay: 1000,  // 1秒

    // タイムライン日付要素の表示待ち上限
    timelineDateTimeout: 3000,

    // コース選択画面の再表示待ち上限（旧固定待機 2000ms 以上）
    courseSelectionAppearTimeout: 5000
  },

  // サイドバー / ユーザー切り替えUIのセレクタと待機設定
  // 追加日: 2026-06-10 (固定待機の条件ベース化対応)
  sidebar: {
    // サイドバー表示の判定に使うヘッダー
    childrenHeader: 'text="お子さま"',
    // ユーザーエリアクリックで誤ってプロフィールページへ遷移した場合の検出
    profileSettings: 'text="プロフィール設定"',
    // サイドバー表示待ちの上限（旧固定待機 2000-3000ms 以上）
    openTimeout: 10000,
    // メニュー展開後にユーザー名が現れるまでの上限（旧固定待機 2000ms 以上）
    menuItemTimeout: 5000
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
  // 個別のセレクタは elementaryTimeline/juniorHighTimeline に統合済み。
  // ここには両コース共通で使う defaultName のみ残す。
  missionDetails: {
    // ミッション名セレクタ（確定）
    // 調査結果: .title__C3bzF が実際のミッション名クラス
    // 親要素: .subIcon__p_BWc
    missionName: {
      defaultName: 'ミッション'  // 取得失敗時のデフォルト値
    }
  },

  // 小学生コース タイムラインのセレクタ
  // DOM調査日: 2026-07-30 (docs/DOM_STRUCTURE.md 参照)
  // 日ブロックが構造として分離されているため、Y座標計算は不要
  // クラス名は CSS Modules のハッシュ付きのため、すべて前方一致で指定する
  elementaryTimeline: {
    dayBlock: '[class*="dailyTimeline__"]',       // 1日分のブロック
    dateLabel: '[class*="date__"]',               // 日ブロック内の日付 "07/30(木)"
    totalStudyTime: '[class*="totalStudyTime__"] [class*="minute__"]', // "15分"
    courseList: '[class*="courseList__"]',        // 学習行リスト
    accordion: '[class*="accordionRoot__"]',      // スターアプリ行(カウント対象外)
    missionBadge: '[class*="missionIcon__"]',     // ミッションバッジ
    courseTitle: '[class*="title__"]',            // 講座名
    scoreNumber: '[class*="scoreNumber__"]',      // 点数タイプ "93"
    correctAnswerCount: '[class*="correctAnswerCount__"]', // 正答数タイプ "9"
    questionCount: '[class*="questionCount__"]'   // 正答数タイプ "/10"
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
  }
};
