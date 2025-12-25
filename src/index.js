/**
 * オーケストレーションモジュール - メイン実行フロー
 * Requirements: 1.1, 1.2, 1.3, 1.4, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 9.6
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersMissionCounts, getUserList } = require('./crawler');
const { loadPreviousData, compareData, saveData } = require('./data');
const { sendNotification, sendUserListNotification } = require('./notifier');
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
    console.log('🚀 スマイルゼミ クローラー開始');

    // 1. 環境変数の読み込みとバリデーション
    console.log('📋 設定を読み込んでいます...');
    let config;
    try {
      config = loadConfig();
      console.log('✅ 設定の読み込みが完了しました');
    } catch (error) {
      console.error('❌ 設定の読み込みに失敗しました:', error.message);
      return {
        success: false,
        exitCode: 1,
        error: error.message
      };
    }

    // 2. Playwrightブラウザの起動
    console.log('🌐 ブラウザを起動しています...');
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      console.log('✅ ブラウザの起動が完了しました');
    } catch (error) {
      console.error('❌ ブラウザの起動に失敗しました:', error.message);
      return {
        success: false,
        exitCode: 1,
        error: `ブラウザ起動エラー: ${error.message}`
      };
    }

    // 3. 認証（ログイン）
    console.log('🔐 ログインしています...');
    const loginResult = await login(browser, {
      username: config.SMILEZEMI_USERNAME,
      password: config.SMILEZEMI_PASSWORD
    });

    if (!loginResult.success) {
      console.error('❌ ログインに失敗しました:', loginResult.error);

      // スクリーンショットを保存
      if (page) {
        await saveErrorScreenshot(page, 'login-failed');
      }

      return {
        success: false,
        exitCode: 1,
        error: loginResult.error
      };
    }

    page = loginResult.page;
    context = loginResult.context;
    console.log('✅ ログインが完了しました');

    // 4. ユーザー一覧取得とLINE通知
    console.log('👥 ユーザー一覧を取得しています...');
    const userListResult = await getUserList(page);

    if (userListResult.success) {
      const users = userListResult.users;
      console.log(`✅ ユーザー一覧の取得が完了しました（${users.length}名）`);

      // ユーザー一覧をLINEに通知
      console.log('📤 ユーザー一覧をLINEに通知しています...');
      const userListNotifyResult = await sendUserListNotification(
        users,
        config.LINE_CHANNEL_ACCESS_TOKEN,
        config.LINE_USER_ID
      );

      if (userListNotifyResult.success) {
        console.log('✅ ユーザー一覧のLINE通知が完了しました');
      } else {
        console.error('❌ ユーザー一覧のLINE通知に失敗しました:', userListNotifyResult.error);
        errors.push(userListNotifyResult.error);
        // 通知失敗してもクローリングは続行
      }
    } else {
      console.warn('⚠️ ユーザー一覧の取得に失敗しました:', userListResult.error);
      errors.push(userListResult.error);
      // ユーザー一覧取得失敗してもクローリングは続行
    }

    // 5. 前回データの取得
    console.log('📊 前回データを読み込んでいます...');
    const previousDataResult = await loadPreviousData();
    let previousData = [];

    if (previousDataResult.success) {
      previousData = previousDataResult.data;
      console.log(`✅ 前回データの読み込みが完了しました（${previousData.length}件）`);
    } else {
      console.warn('⚠️ 前回データの読み込みに失敗しました:', previousDataResult.error);
      console.log('ℹ️ 初回実行として続行します');
    }

    // 6. クローリング（ユーザーリストとミッション数の取得）
    console.log('🔍 ミッション数を取得しています...');
    const crawlResult = await getAllUsersMissionCounts(page);

    if (!crawlResult.success) {
      console.error('❌ クローリングに失敗しました:', crawlResult.error);
      errors.push(crawlResult.error);

      // エラー通知を送信
      try {
        await sendNotification(
          [],
          config.LINE_CHANNEL_ACCESS_TOKEN,
          config.LINE_USER_ID
        );
      } catch (notifyError) {
        console.error('❌ エラー通知の送信にも失敗しました:', notifyError.message);
      }

      // スクリーンショットを保存
      await saveErrorScreenshot(page, 'crawling-failed');

      return {
        success: false,
        exitCode: 1,
        error: crawlResult.error,
        errors
      };
    }

    const currentData = crawlResult.data;
    console.log(`✅ ミッション数の取得が完了しました（${currentData.length}件）`);

    if (crawlResult.partialFailure) {
      console.warn('⚠️ 一部のユーザーのデータ取得に失敗しました');
    }

    // 7. データ比較（変更検出）
    console.log('🔄 データを比較しています...');
    const compareResult = compareData(previousData, currentData);

    if (compareResult.success) {
      console.log(`✅ データ比較が完了しました（${compareResult.changes.length}件の変更）`);
    } else {
      console.error('❌ データ比較に失敗しました:', compareResult.error);
      errors.push(compareResult.error);
    }

    // 8. LINE通知送信（ミッション数の変更）
    console.log('📤 LINE通知を送信しています...');
    const notifyResult = await sendNotification(
      compareResult.changes,
      config.LINE_CHANNEL_ACCESS_TOKEN,
      config.LINE_USER_ID
    );

    if (notifyResult.success) {
      console.log('✅ LINE通知の送信が完了しました');
    } else {
      console.error('❌ LINE通知の送信に失敗しました:', notifyResult.error);
      errors.push(notifyResult.error);
      // 通知失敗してもデータ保存は続行
    }

    // 9. 新しいデータの保存
    console.log('💾 データを保存しています...');
    const saveResult = await saveData(currentData);

    if (saveResult.success) {
      console.log('✅ データの保存が完了しました');
    } else {
      console.error('❌ データの保存に失敗しました:', saveResult.error);
      errors.push(saveResult.error);
    }

    // 10. 完了
    console.log('🎉 処理が正常に完了しました');

    return {
      success: errors.length === 0,
      exitCode: errors.length === 0 ? 0 : 1,
      errors: errors.length > 0 ? errors : undefined
    };

  } catch (error) {
    console.error('❌ 予期しないエラーが発生しました:', error);
    errors.push(error.message);

    // スクリーンショットを保存
    if (page) {
      await saveErrorScreenshot(page, 'unexpected-error');
    }

    return {
      success: false,
      exitCode: 1,
      error: error.message,
      errors
    };

  } finally {
    // 11. ブラウザのクリーンアップ（必ず実行）
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
