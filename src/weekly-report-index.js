/**
 * 週間レポート通知 - メイン実行フロー
 * 毎週月曜17:00（JST）に指導レポートをLINEに通知する
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersWeeklyReport } = require('./weekly-report-crawler');
const { formatWeeklyReport } = require('./weekly-report-notifier');
const { sendPushMessage } = require('./notifier');
const fs = require('fs').promises;
const path = require('path');

/**
 * メイン実行関数
 *
 * @returns {Promise<{success: boolean, exitCode: number, error?: string}>}
 */
async function main() {
  let browser;
  let context;
  let page;
  const errors = [];

  try {
    console.log('🚀 スマイルゼミ 週間レポート通知 開始');

    // 1. 環境変数の読み込みとバリデーション
    console.log('📋 設定を読み込んでいます...');
    let config;
    try {
      config = loadConfig();
      console.log('✅ 設定の読み込みが完了しました');
    } catch (error) {
      console.error('❌ 設定の読み込みに失敗しました:', error.message);
      return { success: false, exitCode: 1, error: error.message };
    }

    // 2. Playwrightブラウザの起動
    console.log('🌐 ブラウザを起動しています...');
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
      console.log('✅ ブラウザの起動が完了しました');
    } catch (error) {
      console.error('❌ ブラウザの起動に失敗しました:', error.message);
      return { success: false, exitCode: 1, error: `ブラウザ起動エラー: ${error.message}` };
    }

    // 3. 認証（ログイン）
    console.log('🔐 ログインしています...');
    const loginResult = await login(browser, {
      username: config.SMILEZEMI_USERNAME,
      password: config.SMILEZEMI_PASSWORD
    });

    if (!loginResult.success) {
      console.error('❌ ログインに失敗しました:', loginResult.error);
      if (page) {
        await saveErrorScreenshot(page, 'weekly-login-failed');
      }
      return { success: false, exitCode: 1, error: loginResult.error };
    }

    page = loginResult.page;
    context = loginResult.context;
    console.log('✅ ログインが完了しました');

    // 4. 全ユーザーの週間レポートを取得
    console.log('📊 週間レポートを取得しています...');
    const reportResult = await getAllUsersWeeklyReport(page);

    if (!reportResult.success) {
      console.error('❌ 週間レポートの取得に失敗しました:', reportResult.error);
      errors.push(reportResult.error);
      await saveErrorScreenshot(page, 'weekly-report-failed');
      return { success: false, exitCode: 1, error: reportResult.error, errors };
    }

    console.log(`✅ 週間レポートの取得が完了しました（${reportResult.data.length}件）`);

    if (reportResult.partialFailure) {
      console.warn('⚠️ 一部のレポート取得に失敗しました');
    }

    // 5. メッセージフォーマット
    const message = formatWeeklyReport(reportResult.data);

    // ドライラン: DRY_RUN=true の場合はメッセージを表示して送信しない
    if (process.env.DRY_RUN === 'true') {
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(message);
      console.log('=== プレビュー終了 ===\n');
      console.log('ℹ️ ドライランモード: LINE通知はスキップしました');
      console.log('🎉 処理が正常に完了しました');
      return { success: true, exitCode: 0 };
    }

    // 6. LINE API 送信（リトライ・タイムアウト・マスキングはsendPushMessageに委譲）
    console.log('📤 LINE通知を送信しています...');
    const notifyResult = await sendPushMessage(
      message,
      config.LINE_CHANNEL_ACCESS_TOKEN,
      config.LINE_USER_ID
    );

    if (notifyResult.success) {
      console.log('✅ 週間レポートのLINE通知が完了しました');
    } else {
      console.error('❌ LINE通知の送信に失敗しました:', notifyResult.error);
      errors.push(notifyResult.error);
    }

    // 7. 完了
    console.log('🎉 処理が正常に完了しました');

    return {
      success: errors.length === 0,
      exitCode: errors.length === 0 ? 0 : 1,
      errors: errors.length > 0 ? errors : undefined
    };

  } catch (error) {
    console.error('❌ 予期しないエラーが発生しました:', error);
    errors.push(error.message);

    if (page) {
      await saveErrorScreenshot(page, 'weekly-unexpected-error');
    }

    return { success: false, exitCode: 1, error: error.message, errors };

  } finally {
    console.log('🧹 ブラウザを終了しています...');
    try {
      if (context) {
        await context.close();
      }
      if (browser) {
        await browser.close();
      }
      console.log('✅ ブラウザの終了が完了しました');
    } catch (error) {
      console.error('⚠️ ブラウザの終了に失敗しました:', error.message);
    }
  }
}

/**
 * エラー時のスクリーンショット保存
 * @private
 */
async function saveErrorScreenshot(page, errorType) {
  try {
    const screenshotsDir = path.join(__dirname, '../screenshots');
    await fs.mkdir(screenshotsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${errorType}-${timestamp}.png`;
    const filepath = path.join(screenshotsDir, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`📸 スクリーンショットを保存しました: ${filename}`);
  } catch (error) {
    console.error('⚠️ スクリーンショットの保存に失敗しました:', error.message);
  }
}

// CLIから直接実行された場合
if (require.main === module) {
  main()
    .then(result => {
      process.exit(result.exitCode);
    })
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = {
  main
};
