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
  }
};
