/**
 * 夜通知 - メイン実行フロー
 * 毎日 JST 20:00 に両コース(小学生・中学生)の当日分を速報として通知する。
 * ストリークの確定は翌朝の朝通知が行うため、ここでは確定も保存もしない。
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersDetailedData, getTargetDates, saveErrorScreenshot } = require('./crawler');
const { formatDetailedMessage, truncateToLimit } = require('./notifier');
const { broadcastToAll, broadcastToDiscordOnly, getDiscordFailure, LINE_MAX_MESSAGE_LENGTH, DISCORD_MAX_MESSAGE_LENGTH } = require('./broadcast');
const { isStudied, getRequirementForCourse, loadStreakData } = require('./streak');

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
 * @returns {Promise<{success: boolean, exitCode: number, error?: string, errors?: string[]}>}
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

    // 4. クローリング（両コースの当日分を速報として取得する）
    console.log('🔍 詳細データを取得しています...');
    const crawlResult = await getAllUsersDetailedData(page);

    if (!crawlResult.success) {
      console.error('❌ クローリングに失敗しました:', crawlResult.error);
      await saveErrorScreenshot(page, 'crawling-failed');

      // 障害を無音にしない: 「変更なし」と偽装せず、エラー通知を送ってから異常終了する
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

      return { success: false, exitCode: 1, error: crawlResult.error };
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

    // 5. 当日のストリーク要件の達成判定
    // 夜通知はストリーク・おたすけ・ボーナスを表示しない(翌朝の確定通知がカバーする)ため
    // ストリーク値そのものは使わない。免除日(おやすみ)の判定にだけデータを読む。
    const todayDateString = getTargetDates(0).dateString;

    const streakLoadResult = await loadStreakData();
    if (!streakLoadResult.success) {
      // 免除日が分からなくても通知は続ける(免除なし扱い)。子供に見える情報を止めないため
      console.warn('⚠️ ストリークデータを読めなかったため免除日なしとして続行します:', streakLoadResult.error);

      // 未初期化(Tursoへの移行が未完了)は一時的な障害ではなく設定漏れなので、
      // 気づけるように赤くする。通常の読み取り失敗は従来どおり警告だけで流す
      if (streakLoadResult.uninitialized) {
        errors.push(streakLoadResult.error);
      }
    }
    const streakUsers = streakLoadResult.success ? streakLoadResult.data : {};

    const exemptUserNames = currentData
      .filter(user => (streakUsers[user.userName]?.exemptDates ?? []).includes(todayDateString))
      .map(user => user.userName);

    if (exemptUserNames.length > 0) {
      // 公開リポジトリのスケジュール実行のログは未認証で読めるため、実名は出さず件数だけを出す。
      // 「誰が免除か」はローカル実行の scripts/show-streak-data.js で確認できる
      console.log(`🏝️ 免除日(おやすみ)のユーザー: ${exemptUserNames.length}人`);
    }

    // 免除日のユーザーは未達に数えない(免除日のためにLINEを消費しない)
    const hasUnqualifiedUser = currentData.some(user =>
      !exemptUserNames.includes(user.userName) &&
      !isStudied(user, { minCompletedMissions: getRequirementForCourse(user.course) })
    );

    // 6. 通知メッセージの組み立て
    // ストリーク行と勉強時間は翌朝の確定通知でカバーするため夜は出さない
    const message = formatDetailedMessage(currentData, {
      showStudyTime: false,
      missionWarningStyle: 'today',
      missionWarningThresholds: {
        elementary: getRequirementForCourse('elementary'),
        juniorHigh: getRequirementForCourse('juniorHigh')
      },
      exemptUserNames,
      showExemptNotice: true
    });

    // 送信先の決定
    // 夜通知は速報のため、全員が当日のストリーク要件を達成済みの日はLINEに送らない。
    // 送信先グループへのpushは人数分カウントされ無料枠(月200)が逼迫しているため、
    // 「このままだと記録更新できないユーザーがいる」= 夜のうちに促す価値がある日だけLINEに送る。
    // ただしDiscordには月間送信数の上限がないため、全員達成の日も記録として必ず送る。
    // 詳細: docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md
    const discordOnly = !hasUnqualifiedUser;
    const discordOnlyNotice = exemptUserNames.length > 0 ? DISCORD_ONLY_NOTICE_EXEMPT : DISCORD_ONLY_NOTICE;
    const outgoingMessage = discordOnly ? `${discordOnlyNotice}\n\n${message}` : message;

    // ドライラン: DRY_RUN=true の場合はメッセージを表示して送信しない
    if (process.env.DRY_RUN === 'true') {
      // Discordは分割して全文が届くため切り詰めない。LINEは切り詰めるので実際の文面に合わせる
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(discordOnly ? outgoingMessage : truncateToLimit(outgoingMessage, LINE_MAX_MESSAGE_LENGTH));
      console.log('=== プレビュー終了 ===\n');
      console.log(discordOnly
        ? 'ℹ️ 全員達成のため、実行時はDiscordのみに送信します'
        : 'ℹ️ 実行時はLINEとDiscordの両方に送信します');
      console.log(`ℹ️ Discordへは${DISCORD_MAX_MESSAGE_LENGTH}文字ごとに分割して送信します`);
      console.log('ℹ️ ドライランモード: 通知はスキップしました');
      console.log('🎉 処理が正常に完了しました');
      return {
        success: errors.length === 0,
        exitCode: errors.length === 0 ? 0 : 1,
        errors: errors.length > 0 ? errors : undefined
      };
    }

    // 7. 通知送信（リトライ・タイムアウト・切り詰め・マスキングは送信層に委譲）
    console.log('📤 通知を送信しています...');
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
    // 全宛先で失敗した場合は上で既に errors に積んでいるため、届いた回だけ見る
    if (notifyResult.success) {
      const discordError = getDiscordFailure(notifyResult);
      if (discordError) {
        console.error('❌ Discordへの送信に失敗しました。Webhookが失効している可能性があります:', discordError);
        errors.push(`Discordへの送信に失敗しました: ${discordError}`);
      }
    }

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
      await saveErrorScreenshot(page, 'unexpected-error');
    }

    return { success: false, exitCode: 1, error: error.message, errors };

  } finally {
    // ブラウザのクリーンアップ（必ず実行）
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
