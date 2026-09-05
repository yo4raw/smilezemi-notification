/**
 * 認証モジュール - みまもるネット自動ログイン
 */

const selectors = require('./config/selectors');
const { maskLiterals } = require('./config');
const { retry } = require('./retry');

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
 * @returns {Promise<{success: boolean, error?: string, page?: object, context?: object}>}
 */
async function login(browser, credentials, options = {}) {
  const { maxRetries = 3, retryDelay = 2000 } = options;

  if (!credentials || !credentials.username || !credentials.password) {
    return {
      success: false,
      error: '必須パラメータが欠けています: username と password が必要です'
    };
  }

  return retry(() => attemptLogin(browser, credentials), {
    maxRetries,
    retryDelay,
    // 認証失敗はリトライしても解決しないため即返す
    shouldRetry: result => !(result.error && result.error.includes('認証失敗')),
    onThrow: (error, attempt) => ({
      success: false,
      error: `ログイン失敗（${attempt}回試行）: ${maskLiterals(error.message, credentials.password)}`
    })
  });
}

/**
 * 1回のログイン試行
 * @private
 */
async function attemptLogin(browser, credentials) {
  let context;

  try {
    // 新しいブラウザコンテキストとページを作成
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(selectors.login.url, {
      waitUntil: selectors.waitStrategies.pageLoad,
      timeout: selectors.waitStrategies.timeout
    });

    // DOM安定化待機
    await page.waitForTimeout(selectors.waitStrategies.stabilizationDelay);

    await page.locator(selectors.login.usernameField).fill(credentials.username);
    await page.locator(selectors.login.passwordField).fill(credentials.password);
    await page.locator(selectors.login.submitButton).click();

    // ページ遷移を待機
    await page.waitForLoadState(selectors.waitStrategies.pageLoad, {
      timeout: selectors.waitStrategies.timeout
    });
    await page.waitForTimeout(selectors.waitStrategies.userSwitchDelay);

    // ログイン成功判定: URLが /login から変わったか確認
    if (page.url().includes('/login')) {
      await context.close();
      return {
        success: false,
        error: '認証失敗: ログイン情報が正しくありません'
      };
    }

    // コンテキストは呼び出し側で管理する
    return { success: true, page, context };

  } catch (error) {
    if (context) {
      await context.close();
    }

    const maskedError = maskLiterals(error.message, credentials.password);

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
