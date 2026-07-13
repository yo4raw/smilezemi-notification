/**
 * 月次ボーナス清算エントリポイント
 *
 * 毎月1日の朝に実行し、前月に貯まったボーナスポイントを子供ごとにLINE通知して
 * 0にリセット(清算)する。クロール不要のためブラウザは起動しない。
 */

const { loadConfig } = require('./config');
const { sendPushMessage } = require('./notifier');
const { loadStreakData, saveStreakData, settleBonuses } = require('./streak');

/**
 * 前月の月ラベルを返す(JST基準)
 *
 * @param {Date} [now] - 現在時刻(テスト用に注入可能)
 * @returns {string} 例: "7月"
 */
function getPreviousMonthLabel(now = new Date()) {
  // UTC+9時間ずらしてUTCゲッターで読むことでJSTの年月を得る
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const month = jst.getUTCMonth() + 1;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevMonth}月`;
}

/**
 * 清算リストを通知メッセージに整形する
 *
 * @param {Array<{userName: string, bonus: number}>} settlements
 * @param {string} monthLabel - 例: "7月"
 * @returns {string}
 */
function formatMonthlyBonusMessage(settlements, monthLabel) {
  const lines = [`💰 ボーナスポイント清算(${monthLabel}分)`, ''];

  if (settlements.length === 0) {
    lines.push('対象のユーザーがいませんでした。');
    return lines.join('\n');
  }

  settlements.forEach(settlement => {
    lines.push(`👤 ${settlement.userName}: ${settlement.bonus}ポイント`);
  });
  lines.push('');
  lines.push('ボーナスポイントはお小遣いとして支給してね!');

  return lines.join('\n');
}

/**
 * メイン実行フロー
 *
 * @returns {Promise<{success: boolean, exitCode: number, error?: string, errors?: Array<string>}>}
 */
async function main() {
  const errors = [];

  console.log('💰 月次ボーナス清算を開始します...');

  // 1. 設定読み込み
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('❌ 設定の読み込みに失敗しました:', error.message);
    return { success: false, exitCode: 1, error: error.message };
  }

  // 2. ストリークデータ読み込み
  const streakLoadResult = await loadStreakData();

  if (!streakLoadResult.success) {
    console.error('❌ ストリークデータの読み込みに失敗しました:', streakLoadResult.error);

    // 障害を無音にしない: エラー通知を送ってから異常終了する(清算はしない)
    if (process.env.DRY_RUN === 'true') {
      console.log('ℹ️ ドライランモード: エラー通知はスキップしました');
    } else {
      const errorMessage = [
        '⚠️ スマイルゼミ通知でエラーが発生しました',
        '',
        '月次ボーナス清算のデータ読み込みに失敗したため、今月の清算をお届けできません。',
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

    return { success: false, exitCode: 1, error: streakLoadResult.error };
  }

  // 3. 清算とメッセージ生成
  const { streakUsers: settledUsers, settlements } = settleBonuses(streakLoadResult.data);
  const monthLabel = getPreviousMonthLabel();
  const message = formatMonthlyBonusMessage(settlements, monthLabel);

  console.log(`📋 清算対象: ${settlements.length}人`);

  // 4. ドライラン: DRY_RUN=true の場合はプレビュー表示のみ(送信・リセット保存なし)
  if (process.env.DRY_RUN === 'true') {
    console.log('\n📋 === 通知メッセージプレビュー ===');
    console.log(message);
    console.log('=== プレビュー終了 ===\n');
    console.log('ℹ️ ドライランモード: LINE通知とボーナスリセットはスキップしました');
    console.log('🎉 処理が正常に完了しました');
    return { success: true, exitCode: 0 };
  }

  // 5. LINE通知送信
  console.log('📤 LINE通知を送信しています...');
  const notifyResult = await sendPushMessage(
    message,
    config.LINE_CHANNEL_ACCESS_TOKEN,
    config.LINE_USER_ID
  );

  if (!notifyResult.success) {
    // 送信失敗時はリセットせず持ち越す(次回実行で再清算できる)
    console.error('❌ LINE通知の送信に失敗しました:', notifyResult.error);
    return { success: false, exitCode: 1, error: notifyResult.error };
  }

  console.log('✅ 月次ボーナス清算のLINE通知が完了しました');

  // 6. 送信成功後にボーナスをリセットして保存
  const saveResult = await saveStreakData(settledUsers);
  if (saveResult.success) {
    console.log('✅ ボーナスのリセット保存が完了しました');
  } else {
    console.error('❌ ボーナスのリセット保存に失敗しました:', saveResult.error);
    errors.push(saveResult.error);
  }

  console.log('🎉 処理が正常に完了しました');

  return {
    success: errors.length === 0,
    exitCode: errors.length === 0 ? 0 : 1,
    errors: errors.length > 0 ? errors : undefined
  };
}

// CLI実行時のブートストラップ
if (require.main === module) {
  main()
    .then(result => {
      process.exit(result.exitCode);
    })
    .catch(error => {
      console.error('❌ 予期しないエラーが発生しました:', error);
      process.exit(1);
    });
}

module.exports = { main, getPreviousMonthLabel, formatMonthlyBonusMessage };
