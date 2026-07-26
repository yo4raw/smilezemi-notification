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
const { loadStreakData, formatStreakInfo, isStudied, createInitialState, getRequirementForCourse } = require('./streak');
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
    // 両コース(小学生・中学生)の当日分を速報として取得する。
    // ストリーク確定は翌朝の朝通知が前日分で行うため、ここでは確定しない。
    console.log('🔍 詳細データを取得しています...');
    const crawlResult = await getAllUsersDetailedData(page, { courseFilter: null });

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

        // 障害を明示するエラー通知を送信（「変更なし」と偽装しない）
        if (process.env.DRY_RUN === 'true') {
          console.log('ℹ️ ドライランモード: エラー通知はスキップしました');
        } else {
          const errorMessage = [
            '⚠️ スマイルゼミ通知でエラーが発生しました',
            '',
            '夜通知のデータ取得に失敗したため、本日の通知をお届けできません。',
            'GitHub Actions のログを確認してください。'
          ].join('\n');
          const errorNotifyResult = await sendPushMessage(
            errorMessage,
            config.LINE_CHANNEL_ACCESS_TOKEN,
            config.LINE_USER_ID
          );
          if (!errorNotifyResult.success) {
            console.error('❌ エラー通知の送信にも失敗しました:', errorNotifyResult.error);
          }
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

      // ドライラン: DRY_RUN=true の場合は送信・保存しない
      if (process.env.DRY_RUN === 'true') {
        console.log('ℹ️ ドライランモード: 基本モードのLINE通知とデータ保存はスキップしました');
        return {
          success: errors.length === 0,
          exitCode: errors.length === 0 ? 0 : 1,
          errors: errors.length > 0 ? errors : undefined
        };
      }

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

    // 対象ユーザーが0件の場合は通知せず正常終了
    if (currentData.length === 0) {
      console.log('ℹ️ 対象ユーザーがいないため、通知をスキップして終了します');
      return { success: true, exitCode: 0 };
    }

    if (crawlResult.partialFailure) {
      console.warn('⚠️ 一部のデータ取得に失敗しました');
    }

    if (!crawlResult.detailsAvailable) {
      console.warn('⚠️ 詳細情報の一部が取得できませんでした');
    }

    // 6.5 ストリーク(連続学習日数)の表示
    // 夜通知は速報のため確定・保存はしない(確定は翌朝の朝通知が前日分で行う)。
    // streak_data.json の確定値を読み、当日すでにしきい値達成なら暫定+1して表示する。
    let streaks = null;
    console.log('🔥 ストリーク情報を読み込んでいます...');
    const streakLoadResult = await loadStreakData();

    let streakUsers;
    if (streakLoadResult.success) {
      streakUsers = streakLoadResult.data;
    } else {
      // 読み込み失敗はエラー記録しつつ空状態で表示を続行する(確定は朝が担うため保存はしない)
      console.error('❌ ストリークデータの読み込みに失敗しました:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
      console.warn('⚠️ ストリークデータを初期化して表示します');
      streakUsers = {};
    }

    const todayDateString = getTargetDates(0).dateString;
    streaks = {};
    let hasUnqualifiedUser = false;
    currentData.forEach(user => {
      const state = streakUsers[user.userName] || createInitialState();
      const threshold = getRequirementForCourse(user.course, todayDateString);
      const todayStudied = isStudied(user, { minCompletedMissions: threshold });
      if (!todayStudied) {
        hasUnqualifiedUser = true;
      }
      streaks[user.userName] = formatStreakInfo({ state, event: 'none' }, { todayStudied });
    });

    // 6.6 送信要否の判定
    // 夜通知は速報のため、全員が当日のストリーク要件を達成済みの日は送信しない。
    // 送信先グループへのpushは人数分カウントされ無料枠(月200)が逼迫しているため、
    // 「このままだと記録更新できないユーザーがいる」= 夜のうちに促す価値がある日だけ通知する。
    // 確定通知は翌朝の朝通知が毎日必ず送る。
    // 詳細: docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md
    if (!hasUnqualifiedUser) {
      console.log('ℹ️ 全ユーザーが本日のストリーク要件を達成済みのため、夜通知をスキップします(送信数節約)');

      if (process.env.DRY_RUN === 'true') {
        console.log('ℹ️ ドライランモード: データ保存はスキップしました');
        console.log('🎉 処理が正常に完了しました');
        return {
          success: errors.length === 0,
          exitCode: errors.length === 0 ? 0 : 1,
          errors: errors.length > 0 ? errors : undefined
        };
      }

      // 通知しない日もデータは保存し、翌日の差分比較の基準を保つ
      console.log('💾 データを保存しています...');
      const saveResult = await saveData(currentData);
      if (saveResult.success) {
        console.log('✅ データの保存が完了しました');
      } else {
        console.error('❌ データの保存に失敗しました:', saveResult.error);
        errors.push(saveResult.error);
      }

      console.log('🎉 処理が正常に完了しました');
      return {
        success: errors.length === 0,
        exitCode: errors.length === 0 ? 0 : 1,
        errors: errors.length > 0 ? errors : undefined
      };
    }

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

    // 詳細メッセージをフォーマット（ミッション変化情報・コース別しきい値未達警告を含む）
    let message = formatDetailedMessage(currentData, missionChangesResult, {
      streaks,
      missionWarningThresholds: {
        elementary: getRequirementForCourse('elementary', todayDateString),
        juniorHigh: getRequirementForCourse('juniorHigh', todayDateString)
      }
    });

    // 文字数制限を適用
    message = truncateToLimit(message);

    // ドライラン: DRY_RUN=true の場合はメッセージを表示して送信・保存しない
    if (process.env.DRY_RUN === 'true') {
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(message);
      console.log('=== プレビュー終了 ===\n');
      console.log('ℹ️ ドライランモード: LINE通知とデータ保存はスキップしました');
      console.log('🎉 処理が正常に完了しました');
      return {
        success: errors.length === 0,
        exitCode: errors.length === 0 ? 0 : 1,
        errors: errors.length > 0 ? errors : undefined
      };
    }

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
