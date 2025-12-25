/**
 * 認証モジュール - みまもるネット自動ログイン
 * Requirements: 2.1, 2.2, 9.2
 */

const selectors = require('./config/selectors');
const { maskSensitiveData } = require('./config');

/**
 * みまもるネットにログインする
 *
 * @param {import('playwright').Browser} browser - Playwrightブラウザインスタンス
 * @param {object} credentials - 認証情報
 * @param {string} credentials.username - ユーザー名（メールアドレス）
 * @param {string} credentials.password - パスワード
 * @param {object} [options] - オプション設定
 * @param {number} [options.maxRetries=3] - 最大リトライ回数
 * @param {number} [options.retryDelay=2000] - リトライ間隔（ms、指数バックオフ）
 * @returns {Promise<{success: boolean, error?: string, page?: object}>}
 */
async function login(browser, credentials, options = {}) {
  const { maxRetries = 3, retryDelay = 2000 } = options;

  // パラメータ検証
  if (!credentials || !credentials.username || !credentials.password) {
    return {
      success: false,
      error: '必須パラメータが欠けています: username と password が必要です'
    };
  }

  // リトライロジック
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await attemptLogin(browser, credentials);

      if (result.success) {
        return result;
      }

      // 認証失敗（リトライ不要）の場合は即座に返す
      if (result.error && result.error.includes('認証失敗')) {
        return result;
      }

      // 最後の試行でなければリトライ
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1); // 指数バックオフ
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // 最後の試行でも失敗
      return result;

    } catch (error) {
      const maskedError = maskPasswordInError(error.message, credentials.password);

      // 最後の試行でなければリトライ
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // 最後の試行でも失敗
      return {
        success: false,
        error: `ログイン失敗（${attempt}回試行）: ${maskedError}`
      };
    }
  }

  // ここには到達しないはずだが、念のため
  return {
    success: false,
    error: `ログイン失敗: 最大リトライ回数（${maxRetries}回）に達しました`
  };
}

/**
 * エラーメッセージから実際のパスワードを除去
 * @private
 */
function maskPasswordInError(errorMessage, password) {
  if (!password) {
    return errorMessage;
  }

  // パスワードの値を *** に置換
  let masked = errorMessage;

  // 実際のパスワード値を置換
  if (masked.includes(password)) {
    masked = masked.replace(new RegExp(password, 'g'), '***');
  }

  // 一般的なパスワードパターンもマスキング
  masked = maskSensitiveData(masked);

  return masked;
}

/**
 * 1回のログイン試行
 * @private
 */
async function attemptLogin(browser, credentials) {
  let context;
  let page;

  try {
    // 新しいブラウザコンテキストとページを作成
    context = await browser.newContext();
    page = await context.newPage();

    // ログインページにアクセス
    await page.goto(selectors.login.url, {
      waitUntil: selectors.waitStrategies.pageLoad,
      timeout: selectors.waitStrategies.timeout
    });

    // DOM安定化待機
    await page.waitForTimeout(selectors.waitStrategies.stabilizationDelay);

    // ユーザー名入力
    const usernameField = page.locator(selectors.login.usernameField);
    await usernameField.fill(credentials.username);

    // パスワード入力
    const passwordField = page.locator(selectors.login.passwordField);
    await passwordField.fill(credentials.password);

    // ログインボタンをクリック
    const submitButton = page.locator(selectors.login.submitButton);
    await submitButton.click();

    // ページ遷移を待機
    await page.waitForLoadState(selectors.waitStrategies.pageLoad, {
      timeout: selectors.waitStrategies.timeout
    });

    // 追加の安定化待機
    await page.waitForTimeout(selectors.waitStrategies.userSwitchDelay);

    // ログイン成功判定: URLが /login から変わったか確認
    const currentUrl = page.url();

    if (currentUrl.includes('/login')) {
      // ログイン後もログインページのまま = 認証失敗
      await context.close();
      return {
        success: false,
        error: '認証失敗: ログイン情報が正しくありません'
      };
    }

    // ログイン成功
    return {
      success: true,
      page,
      context  // コンテキストは呼び出し側で管理
    };

  } catch (error) {
    // エラーが発生した場合、ページとコンテキストをクリーンアップ
    if (context) {
      await context.close();
    }

    // エラー種別に応じたメッセージ（パスワードをマスキング）
    const maskedError = maskPasswordInError(error.message, credentials.password);

    if (error.message.includes('Timeout')) {
      return {
        success: false,
        error: `タイムアウトエラー: ページの読み込みに時間がかかりすぎました - ${maskedError}`
      };
    }

    if (error.message.includes('net::') || error.message.includes('connection')) {
      return {
        success: false,
        error: `ネットワークエラー: サーバーに接続できません - ${maskedError}`
      };
    }

    return {
      success: false,
      error: `ログインエラー: ${maskedError}`
    };
  }
}

module.exports = {
  login
};
