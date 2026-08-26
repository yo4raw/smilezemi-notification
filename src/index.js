/**
 * オーケストレーションモジュール - メイン実行フロー
 * Requirements: 1.1, 1.2, 1.3, 1.4, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 9.6
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersDetailedData, getAllUsersMissionCounts, getUserList, getTargetDates } = require('./crawler');
const { loadPreviousData, compareData, saveData } = require('./data');
const { formatMessage, formatUnqualifiedMessage, truncateToLimit } = require('./notifier');
const { broadcastToAll, broadcastToDiscordOnly, getDiscordFailure, LINE_MAX_MESSAGE_LENGTH, DISCORD_MAX_MESSAGE_LENGTH } = require('./broadcast');
const { isStudied, getRequirementForCourse, loadStreakData } = require('./streak');
const fs = require('fs').promises;
const path = require('path');

/**
 * 全員がストリーク要件を達成した日にDiscordへ付ける断り行
 *
 * DiscordにはLINE失敗時のフォールバック転送（先頭が「⚠️ LINEへの送信に失敗した…」）も
 * 届くため、受信側が両者を区別できるよう、送らなかった理由を明示する。
 */
const DISCORD_ONLY_NOTICE = 'ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します(送信数節約)';

// 免除日のユーザーがいる日は「全員達成」ではないため、断り行を切り替える
const DISCORD_ONLY_NOTICE_EXEMPT = 'ℹ️ おやすみ登録のユーザーがいて、それ以外の人は本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します(送信数節約)';

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

    // 4. ユーザー一覧取得と通知
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
          const errorNotifyResult = await broadcastToAll(errorMessage, config);
          if (!errorNotifyResult.success) {
            console.error('❌ エラー通知の送信に全宛先で失敗しました');
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
        console.log('ℹ️ ドライランモード: 基本モードの通知とデータ保存はスキップしました');
        return {
          success: errors.length === 0,
          exitCode: errors.length === 0 ? 0 : 1,
          errors: errors.length > 0 ? errors : undefined
        };
      }

      const notifyResult = await broadcastToAll(
        formatMessage(compareResult.changes),
        config
      );

      if (notifyResult.success) {
        console.log('✅ 基本モードでの通知が完了しました');
      } else {
        console.error('❌ 基本モードでの通知に失敗しました');
        errors.push('基本モードの通知が全宛先で失敗しました');
      }

      // LINEに届いていてもDiscordが失敗していれば異常終了させる(Webhook失効の検知)
      // 全宛先で失敗した場合は上で既に errors に積んでいるため、届いた回だけ見る
      if (notifyResult.success) {
        const basicDiscordError = getDiscordFailure(notifyResult);
        if (basicDiscordError) {
          console.error('❌ Discordへの送信に失敗しました。Webhookが失効している可能性があります:', basicDiscordError);
          errors.push(`Discordへの送信に失敗しました: ${basicDiscordError}`);
        }
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

    // 6.5 当日のストリーク要件の達成判定
    // 夜通知はストリーク・おたすけ・ボーナスを表示しない(翌朝の確定通知がカバーする)ため
    // ストリーク値そのものは使わない。免除日(おやすみ)の判定にだけデータを読む。
    // 通知本文と送信先の判定には達成状況を使い、データ取得に失敗したユーザーは
    // 未達と断定できないため判定にかけず別枠に分ける。
    const todayDateString = getTargetDates(0).dateString;

    const streakLoadResult = await loadStreakData();
    if (!streakLoadResult.success) {
      // 免除日が分からなくても通知は続ける(免除なし扱い)。子供に見える情報を止めないため
      console.warn('⚠️ ストリークデータを読めなかったため免除日なしとして続行します:', streakLoadResult.error);
    }
    const streakUsers = streakLoadResult.success ? streakLoadResult.data : {};

    const exemptNames = [];
    const unqualifiedNames = [];
    const unreliableNames = [];
    currentData.forEach(user => {
      // 免除日のユーザーは未達に数えない(免除日のためにLINEを消費しない)
      if ((streakUsers[user.userName]?.exemptDates ?? []).includes(todayDateString)) {
        exemptNames.push(user.userName);
        return;
      }
      if (user.dataReliable === false) {
        unreliableNames.push(user.userName);
        return;
      }
      const threshold = getRequirementForCourse(user.course);
      if (!isStudied(user, { minCompletedMissions: threshold })) {
        unqualifiedNames.push(user.userName);
      }
    });

    if (exemptNames.length > 0) {
      console.log(`🏝️ 免除日のユーザー: ${exemptNames.join(', ')}`);
    }

    // 7. データ比較（変更検出）
    console.log('🔄 データを比較しています...');

    // ミッション数の変化（ログ用。夜通知の本文には使わない）
    const compareResult = compareData(previousData, currentData);

    if (compareResult.success) {
      console.log(`✅ データ比較が完了しました（${compareResult.changes.length}件の変更）`);
    } else {
      console.error('❌ データ比較に失敗しました:', compareResult.error);
      errors.push(compareResult.error);
    }

    // 8. 通知送信（詳細データモード）
    // Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
    console.log('📤 通知を送信しています...');

    // 夜通知は「まだ今日のノルマが終わっていない人」を知らせるのが目的のため、
    // 学習件数・ミッション詳細・勉強時間は出さず名前だけを並べる(翌朝の確定通知が詳細をカバーする)
    const message = formatUnqualifiedMessage({ unqualifiedNames, unreliableNames, exemptNames });

    // 送信先の決定
    // 夜通知は速報のため、全員が当日のストリーク要件を達成済みの日はLINEに送らない。
    // 送信先グループへのpushは人数分カウントされ無料枠(月200)が逼迫しているため、
    // 「このままだと記録更新できないユーザーがいる」= 夜のうちに促す価値がある日だけLINEに送る。
    // ただしDiscordには月間送信数の上限がないため、全員達成の日も記録として必ず送る。
    // 確定通知は翌朝の朝通知が毎日必ず送る。
    // 詳細: docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md
    const discordOnly = unqualifiedNames.length === 0 && unreliableNames.length === 0;
    const discordOnlyNotice = exemptNames.length > 0 ? DISCORD_ONLY_NOTICE_EXEMPT : DISCORD_ONLY_NOTICE;
    const outgoingMessage = discordOnly ? `${discordOnlyNotice}\n\n${message}` : message;

    // ドライラン: DRY_RUN=true の場合はメッセージを表示して送信・保存しない
    if (process.env.DRY_RUN === 'true') {
      // Discordは分割して全文が届くため切り詰めない。LINEは切り詰めるので実際の文面に合わせる
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(discordOnly ? outgoingMessage : truncateToLimit(outgoingMessage, LINE_MAX_MESSAGE_LENGTH));
      console.log('=== プレビュー終了 ===\n');
      console.log(discordOnly
        ? 'ℹ️ 全員達成のため、実行時はDiscordのみに送信します'
        : 'ℹ️ 実行時はLINEとDiscordの両方に送信します');
      console.log(`ℹ️ Discordへは${DISCORD_MAX_MESSAGE_LENGTH}文字ごとに分割して送信します`);
      console.log('ℹ️ ドライランモード: 通知とデータ保存はスキップしました');
      console.log('🎉 処理が正常に完了しました');
      return {
        success: errors.length === 0,
        exitCode: errors.length === 0 ? 0 : 1,
        errors: errors.length > 0 ? errors : undefined
      };
    }

    // 通知送信（リトライ・タイムアウト・切り詰め・マスキングは送信層に委譲）
    if (discordOnly) {
      console.log('ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します');
    }
    const notifyResult = discordOnly
      ? await broadcastToDiscordOnly(outgoingMessage, config)
      : await broadcastToAll(outgoingMessage, config);

    if (notifyResult.success) {
      console.log('✅ 通知の送信が完了しました');
    } else if (notifyResult.skipped) {
      // 宛先が1つも設定されていないだけなので、ワークフローは赤くしない
      console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、全員達成日の記録を送信しませんでした');
    } else {
      console.error('❌ 通知の送信に全宛先で失敗しました');
      errors.push('通知が全宛先で失敗しました');
    }

    // LINEに届いていてもDiscordが失敗していれば異常終了させる(Webhook失効の検知)
    // 全員達成日(Discord単独)の失敗は上のブロックで既に errors に積まれているため、
    // 二重に積まないよう success の判定を経たここで getDiscordFailure を見る
    if (notifyResult.success) {
      const discordError = getDiscordFailure(notifyResult);
      if (discordError) {
        console.error('❌ Discordへの送信に失敗しました。Webhookが失効している可能性があります:', discordError);
        errors.push(`Discordへの送信に失敗しました: ${discordError}`);
      }
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
