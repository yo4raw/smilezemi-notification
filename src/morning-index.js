/**
 * 朝通知 - メイン実行フロー
 * 毎朝 JST 7:00 に中学生コースの前日学習実績を LINE に通知する。
 * 前日は確定データのため差分比較・mission_data.json への保存は行わない。
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersDetailedData, getTargetDates } = require('./crawler');
const { formatDetailedMessage, truncateToLimit } = require('./notifier');
const { loadStreakData, saveStreakData, updateStreaks, formatStreakInfo } = require('./streak');
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
    console.log('🚀 スマイルゼミ 朝通知(中学生コース・前日分) 開始');

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
      return { success: false, exitCode: 1, error: loginResult.error };
    }

    page = loginResult.page;
    context = loginResult.context;
    console.log('✅ ログインが完了しました');

    // 4. 中学生コースの前日分データを取得
    const targetDates = getTargetDates(-1);
    console.log(`🔍 前日(${targetDates.withPadding})の中学生コースデータを取得しています...`);
    const crawlResult = await getAllUsersDetailedData(page, {
      courseFilter: 'juniorHigh',
      dateOffset: -1
    });

    if (!crawlResult.success) {
      console.error('❌ クローリングに失敗しました:', crawlResult.error);
      await saveErrorScreenshot(page, 'morning-crawling-failed');
      return { success: false, exitCode: 1, error: crawlResult.error };
    }

    if (crawlResult.partialFailure) {
      console.warn('⚠️ 一部のデータ取得に失敗しました');
    }

    // 対象ユーザーがいない場合は通知せず正常終了
    if (crawlResult.data.length === 0) {
      console.log('ℹ️ 中学生コースの対象ユーザーがいないため、通知をスキップして終了します');
      return { success: true, exitCode: 0 };
    }

    console.log(`✅ データの取得が完了しました（${crawlResult.data.length}件）`);

    // 4.5 ストリーク(連続学習日数)の確定判定
    // 前日分は確定データのため、そのままストリークを確定する
    let streaks = null;
    console.log('🔥 ストリークを更新しています...');
    const streakLoadResult = await loadStreakData();

    if (streakLoadResult.success) {
      const { streakUsers, results } = updateStreaks(
        streakLoadResult.data,
        crawlResult.data,
        targetDates.dateString
      );

      streaks = {};
      results.forEach(result => {
        streaks[result.userName] = formatStreakInfo(result);
      });

      // ドライラン時は状態を書き換えない(再実行で二重判定になるのを防ぐ)
      if (process.env.DRY_RUN === 'true') {
        console.log('ℹ️ ドライランモード: ストリークデータの保存はスキップしました');
      } else {
        const streakSaveResult = await saveStreakData(streakUsers);
        if (streakSaveResult.success) {
          console.log('✅ ストリークデータの保存が完了しました');
        } else {
          console.error('❌ ストリークデータの保存に失敗しました:', streakSaveResult.error);
          errors.push(streakSaveResult.error);
        }
      }
    } else {
      console.warn('⚠️ ストリークデータの読み込みに失敗したため、ストリーク表示をスキップします:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
    }

    // 5. メッセージフォーマット（前日は確定データのため差分比較なし。未学習でも必ず通知）
    let message = formatDetailedMessage(crawlResult.data, null, {
      dateLabel: `昨日(${targetDates.withPadding})`,
      showNoStudyWarning: true,
      streaks
    });
    message = truncateToLimit(message);

    // ドライラン: DRY_RUN=true の場合はメッセージを表示して送信しない
    if (process.env.DRY_RUN === 'true') {
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(message);
      console.log('=== プレビュー終了 ===\n');
      console.log('ℹ️ ドライランモード: LINE通知はスキップしました');
      console.log('🎉 処理が正常に完了しました');
      return { success: true, exitCode: 0 };
    }

    // 6. LINE API 送信
    console.log('📤 LINE通知を送信しています...');
    const requestBody = {
      to: config.LINE_USER_ID,
      messages: [
        {
          type: 'text',
          text: message
        }
      ]
    };

    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ LINE通知の送信に失敗しました:', response.status, errorText);
        errors.push(`LINE API エラー: ${response.status}`);
      } else {
        console.log('✅ 朝通知のLINE送信が完了しました');
      }
    } catch (notifyError) {
      console.error('❌ LINE通知の送信に失敗しました:', notifyError.message);
      errors.push(notifyError.message);
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
      await saveErrorScreenshot(page, 'morning-unexpected-error');
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
