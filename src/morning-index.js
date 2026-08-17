/**
 * 朝通知 - メイン実行フロー
 * 毎朝 JST 7:00 に両コース(小学生・中学生)の前日学習実績を通知する。
 * 前日は確定データのため差分比較・mission_data.json への保存は行わない。
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersDetailedData, getTargetDates } = require('./crawler');
const { formatDetailedMessage, truncateToLimit } = require('./notifier');
const { broadcastToAll, getDiscordFailure, LINE_MAX_MESSAGE_LENGTH, DISCORD_MAX_MESSAGE_LENGTH } = require('./broadcast');
const {
  loadStreakData,
  saveStreakData,
  updateStreaksByCourse,
  formatStreakInfo,
  STREAK_REQUIREMENTS
} = require('./streak');
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
    console.log('🚀 スマイルゼミ 朝通知(両コース・前日分) 開始');

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

    // 4. 両コースの前日分データを取得
    const targetDates = getTargetDates(-1);
    console.log(`🔍 前日(${targetDates.withPadding})の両コースデータを取得しています...`);
    const crawlResult = await getAllUsersDetailedData(page, {
      courseFilter: null,
      dateOffset: -1
    });

    if (!crawlResult.success) {
      console.error('❌ クローリングに失敗しました:', crawlResult.error);
      await saveErrorScreenshot(page, 'morning-crawling-failed');

      // 障害を無音にしない: 「0件でも必ず通知」の仕様を障害時にも守るため、エラー通知を送ってから異常終了する
      if (process.env.DRY_RUN === 'true') {
        console.log('ℹ️ ドライランモード: エラー通知はスキップしました');
      } else {
        const errorMessage = [
          '⚠️ スマイルゼミ通知でエラーが発生しました',
          '',
          '朝通知のデータ取得に失敗したため、昨日分の通知をお届けできません。',
          'GitHub Actions のログを確認してください。'
        ].join('\n');
        const errorNotifyResult = await broadcastToAll(errorMessage, config);
        if (!errorNotifyResult.success) {
          console.error('❌ エラー通知の送信に全宛先で失敗しました');
        }
      }

      return { success: false, exitCode: 1, error: crawlResult.error };
    }

    if (crawlResult.partialFailure) {
      console.warn('⚠️ 一部のデータ取得に失敗しました');
    }

    // 対象ユーザーがいない場合は通知せず正常終了
    if (crawlResult.data.length === 0) {
      console.log('ℹ️ 対象ユーザーがいないため、通知をスキップして終了します');
      return { success: true, exitCode: 0 };
    }

    console.log(`✅ データの取得が完了しました（${crawlResult.data.length}件）`);

    // 4.5 ストリーク(連続学習日数)の確定判定
    // 前日分は確定データのため、そのままストリークを確定する
    let streaks = null;
    console.log('🔥 ストリークを更新しています...');
    const streakLoadResult = await loadStreakData();

    let previousStreakUsers;
    if (streakLoadResult.success) {
      previousStreakUsers = streakLoadResult.data;
    } else {
      // 読み込み失敗はエラーとして記録しつつ、空状態で続行して次回保存時に自己修復させる
      // (システム側の問題で子供にペナルティを与えず、通知処理も止め続けないため)
      console.error('❌ ストリークデータの読み込みに失敗しました:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
      console.warn('⚠️ ストリークデータを初期化して続行します');
      previousStreakUsers = {};
    }

    // 前日は確定データ。コース別しきい値で確定する(小学生4 / 中学生3)
    const { streakUsers, results } = updateStreaksByCourse(
      previousStreakUsers,
      crawlResult.data,
      targetDates.dateString
    );

    streaks = {};
    results.forEach(result => {
      streaks[result.userName] = formatStreakInfo(result);
    });

    // 免除日のユーザーには未達警告を出さない(ストリーク行が「記録はそのまま」と伝える)
    const exemptUserNames = results
      .filter(result => result.event === 'exempt')
      .map(result => result.userName);

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

    // 5. メッセージフォーマット（前日は確定データのため差分比較なし。未学習でも必ず通知）
    const message = formatDetailedMessage(crawlResult.data, null, {
      dateLabel: `昨日(${targetDates.withPadding})`,
      showNoStudyWarning: true,
      streaks,
      missionWarningStyle: 'past',
      missionWarningThresholds: {
        elementary: STREAK_REQUIREMENTS.elementaryMissions,
        juniorHigh: STREAK_REQUIREMENTS.juniorHighCourses
      },
      exemptUserNames
    });

    // ドライラン: DRY_RUN=true の場合はメッセージを表示して送信しない
    if (process.env.DRY_RUN === 'true') {
      // 実送信ではbroadcastが宛先ごとに切り詰めるため、プレビューもLINEの上限で切って表示する
      // （送信経路には手を入れず、表示だけを実際の文面に合わせる）
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(truncateToLimit(message, LINE_MAX_MESSAGE_LENGTH));
      console.log('=== プレビュー終了 ===\n');
      console.log('ℹ️ 実行時はLINEとDiscordの両方に送信します');
      console.log(`ℹ️ Discordへは${DISCORD_MAX_MESSAGE_LENGTH}文字ごとに分割して送信します`);
      console.log('ℹ️ ドライランモード: 通知はスキップしました');
      console.log('🎉 処理が正常に完了しました');
      return { success: true, exitCode: 0 };
    }

    // 6. 通知送信（リトライ・タイムアウト・切り詰め・マスキングはbroadcastToAllに委譲）
    console.log('📤 通知を送信しています...');
    const notifyResult = await broadcastToAll(message, config);

    if (notifyResult.success) {
      console.log('✅ 朝通知の送信が完了しました');
    } else {
      console.error('❌ 朝通知の送信に全宛先で失敗しました');
      errors.push('朝通知が全宛先で失敗しました');
    }

    // LINEに届いていてもDiscordが失敗していれば異常終了させる(Webhook失効の検知)
    // 全宛先で失敗した場合は上で既に errors に積んでいるため、届いた回だけ見る
    if (notifyResult.success) {
      const discordError = getDiscordFailure(notifyResult);
      if (discordError) {
        console.error('❌ Discordへの送信に失敗しました。Webhookが失効している可能性があります:', discordError);
        errors.push(`Discordへの送信に失敗しました: ${discordError}`);
      }
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
