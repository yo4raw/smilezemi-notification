/**
 * オーケストレーションモジュール - メイン実行フロー
 * Requirements: 1.1, 1.2, 1.3, 1.4, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 9.6
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersDetailedData, getAllUsersMissionCounts, getUserList, getTargetDates } = require('./crawler');
const { loadPreviousData, compareData, compareMissionDetails, saveData } = require('./data');
const { sendNotification, sendPushMessage, formatDetailedMessage, truncateToLimit } = require('./notifier');
const { loadStreakData, saveStreakData, updateStreaks, formatStreakInfo, isStudied, createInitialState } = require('./streak');
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

    // 6. クローリング（詳細データ取得 - v2.0）
    // Requirements: 1.1, 2.1, 3.1, 4.1, 5.1
    // 中学生コースは朝通知(src/morning-index.js)で前日分を通知するため、ここでは小学生コースのみ対象
    console.log('🔍 詳細データを取得しています...');
    const crawlResult = await getAllUsersDetailedData(page, { courseFilter: 'elementary' });

    if (!crawlResult.success) {
      console.error('❌ クローリングに失敗しました:', crawlResult.error);
      errors.push(crawlResult.error);

      // スクリーンショットを保存
      await saveErrorScreenshot(page, 'crawling-failed');

      // グレースフルデグラデーション: 基本機能にフォールバック
      // Requirements: 6.1, 6.2, 6.3, 6.4
      console.log('⚠️ 基本機能（ミッション数のみ）にフォールバックします...');
      const basicCrawlResult = await getAllUsersMissionCounts(page);

      if (!basicCrawlResult.success) {
        console.error('❌ 基本機能でもクローリングに失敗しました:', basicCrawlResult.error);
        errors.push(basicCrawlResult.error);

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

        return {
          success: false,
          exitCode: 1,
          error: crawlResult.error,
          errors
        };
      }

      // 基本データで続行（v1.0形式なので自動でv2.0に変換される）
      const currentData = basicCrawlResult.data;
      console.log(`✅ 基本データの取得が完了しました（${currentData.length}件）`);

      // データ比較と通知（基本モード）
      const compareResult = compareData(previousData, currentData);
      const notifyResult = await sendNotification(
        compareResult.changes,
        config.LINE_CHANNEL_ACCESS_TOKEN,
        config.LINE_USER_ID
      );

      if (notifyResult.success) {
        console.log('✅ 基本モードでのLINE通知が完了しました');
      } else {
        console.error('❌ 基本モードでのLINE通知に失敗しました:', notifyResult.error);
        errors.push(notifyResult.error);
      }

      // データ保存（v2.0形式、デフォルト値付き）
      const saveResult = await saveData(currentData);
      if (!saveResult.success) {
        console.error('❌ データの保存に失敗しました:', saveResult.error);
        errors.push(saveResult.error);
      }

      return {
        success: errors.length === 0,
        exitCode: errors.length === 0 ? 0 : 1,
        errors: errors.length > 0 ? errors : undefined
      };
    }

    const currentData = crawlResult.data;
    console.log(`✅ 詳細データの取得が完了しました（${currentData.length}件）`);

    // 対象ユーザーが0件(全員中学生コース等)の場合は通知せず正常終了
    if (currentData.length === 0) {
      console.log('ℹ️ 小学生コースの対象ユーザーがいないため、通知をスキップして終了します');
      return { success: true, exitCode: 0 };
    }

    if (crawlResult.partialFailure) {
      console.warn('⚠️ 一部のデータ取得に失敗しました');
    }

    if (!crawlResult.detailsAvailable) {
      console.warn('⚠️ 詳細情報の一部が取得できませんでした');
    }

    // 6.5 ストリーク(連続学習日数)の更新
    // 20時時点の当日データでは確定できないため、前日分を追加クロールして確定判定する。
    // 当日分は「確定ストリーク+当日学習済みなら暫定+1」として表示に使う。
    let streaks = null;
    console.log('🔥 ストリークを更新しています...');
    const streakLoadResult = await loadStreakData();

    let streakUsers;
    if (streakLoadResult.success) {
      streakUsers = streakLoadResult.data;
    } else {
      // 読み込み失敗はエラーとして記録しつつ、空状態で続行して次回保存時に自己修復させる
      // (システム側の問題で子供にペナルティを与えず、通知処理も止め続けないため)
      console.error('❌ ストリークデータの読み込みに失敗しました:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
      console.warn('⚠️ ストリークデータを初期化して続行します');
      streakUsers = {};
    }

    const resultMap = new Map();

    const yesterdayDates = getTargetDates(-1);
    console.log(`🔍 ストリーク確定のため前日(${yesterdayDates.withPadding})のデータを取得しています...`);
    const yesterdayCrawlResult = await getAllUsersDetailedData(page, {
      courseFilter: 'elementary',
      dateOffset: -1
    });

    if (yesterdayCrawlResult.success) {
      const updateResult = updateStreaks(
        streakUsers,
        yesterdayCrawlResult.data,
        yesterdayDates.dateString
      );
      streakUsers = updateResult.streakUsers;
      updateResult.results.forEach(result => resultMap.set(result.userName, result));

      const streakSaveResult = await saveStreakData(streakUsers);
      if (streakSaveResult.success) {
        console.log('✅ ストリークデータの保存が完了しました');
      } else {
        console.error('❌ ストリークデータの保存に失敗しました:', streakSaveResult.error);
        errors.push(streakSaveResult.error);
      }
    } else {
      // 前日分が取れない場合は確定判定をスキップし、前回の確定値をそのまま表示する
      // (未判定日は翌日以降に空白日として中立処理される)
      console.warn('⚠️ 前日分の取得に失敗したため、ストリークの確定判定をスキップします:', yesterdayCrawlResult.error);
    }

    // 通知用の表示情報を構築(当日すでに学習していれば暫定で+1表示)
    streaks = {};
    currentData.forEach(user => {
      const result = resultMap.get(user.userName) || {
        state: streakUsers[user.userName] || createInitialState(),
        event: 'none'
      };
      streaks[user.userName] = formatStreakInfo(result, { todayStudied: isStudied(user) });
    });

    // 7. データ比較（変更検出）
    console.log('🔄 データを比較しています...');

    // ミッション数の変化（既存機能）
    const compareResult = compareData(previousData, currentData);

    // ミッション詳細の変化（新機能）
    const missionChangesResult = compareMissionDetails(previousData, currentData);

    if (compareResult.success) {
      console.log(`✅ データ比較が完了しました（${compareResult.changes.length}件の変更）`);
    } else {
      console.error('❌ データ比較に失敗しました:', compareResult.error);
      errors.push(compareResult.error);
    }

    // 8. LINE通知送信（詳細データモード）
    // Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
    console.log('📤 LINE通知を送信しています...');

    // 詳細メッセージをフォーマット（ミッション変化情報を含む）
    let message = formatDetailedMessage(currentData, missionChangesResult, { streaks });

    // 文字数制限を適用
    message = truncateToLimit(message);

    // 通知送信（リトライ・タイムアウト・マスキングはsendPushMessageに委譲）
    const notifyResult = await sendPushMessage(
      message,
      config.LINE_CHANNEL_ACCESS_TOKEN,
      config.LINE_USER_ID
    );

    if (notifyResult.success) {
      console.log('✅ 詳細モードでのLINE通知が完了しました');
    } else {
      console.error('❌ LINE通知の送信に失敗しました:', notifyResult.error);
      errors.push(notifyResult.error);
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
