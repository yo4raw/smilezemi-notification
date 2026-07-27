/**
 * 月次ボーナス清算エントリポイント
 *
 * 毎月1日の朝に実行し、前月に貯まったボーナスポイントを子供ごとに通知して
 * 0にリセット(清算)する。クロール不要のためブラウザは起動しない。
 */

const { loadConfig } = require('./config');
const { broadcastToAll } = require('./broadcast');
const { loadStreakData, saveStreakData, settleBonuses } = require('./streak');

// ボーナスポイント1点あたりの金額(円)。コース別に単価が違う。
// 単価を変えるときはここだけを書き換える
const BONUS_POINT_YEN = {
  elementary: 30,
  juniorHigh: 50
};

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
 * ボーナスポイントを金額(円)に換算する
 *
 * settleBonuses() が返す settlements にはコース情報が含まれず、ストリークデータにも
 * 保存されていないため、クローラーが組み立てた表示名からコースを判定する。
 * 判定方法は src/notifier.js と同じ慣例に揃えている(コース表記なしは小学生扱い)。
 *
 * @param {string} userName - 表示名(例: "はなこ (小学生コース)")
 * @param {number} bonus - ボーナスポイント数
 * @returns {number} 金額(円)
 */
function toBonusYen(userName, bonus) {
  const rate = userName.includes('中学生コース')
    ? BONUS_POINT_YEN.juniorHigh
    : BONUS_POINT_YEN.elementary;

  return bonus * rate;
}

/**
 * 清算リストを通知メッセージに整形する
 *
 * ポイント数に加えて、コース別単価で換算した金額と全員分の合計を載せる。
 * 受け取る側がそのまま現金を渡せる状態にするため。
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

  let totalYen = 0;

  settlements.forEach(settlement => {
    const yen = toBonusYen(settlement.userName, settlement.bonus);
    totalYen += yen;
    lines.push(`👤 ${settlement.userName}: ${settlement.bonus}ポイント → ¥${yen.toLocaleString('ja-JP')}`);
  });

  lines.push('');
  lines.push(`合計: ¥${totalYen.toLocaleString('ja-JP')}`);
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
      const errorNotifyResult = await broadcastToAll(errorMessage, config);
      if (!errorNotifyResult.success) {
        console.error('❌ エラー通知の送信に全宛先で失敗しました');
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
    console.log('ℹ️ ドライランモード: 通知とボーナスリセットはスキップしました');
    console.log('🎉 処理が正常に完了しました');
    return { success: true, exitCode: 0 };
  }

  // 5. 通知送信（LINEとDiscordの両方へ。Discordは年12回の疎通確認を兼ねる）
  console.log('📤 通知を送信しています...');
  const notifyResult = await broadcastToAll(message, config);

  if (!notifyResult.success) {
    // 全宛先で失敗したときはリセットせず持ち越す(次回実行で再清算できる)
    console.error('❌ 通知の送信に全宛先で失敗しました');
    return { success: false, exitCode: 1, error: '清算通知が全宛先で失敗しました' };
  }

  // どこか1つでも届いていればリセットする。届いているのに持ち越すと、
  // 次回実行で同じ月の清算が再送・再支給されてしまうため
  console.log('✅ 月次ボーナス清算の通知が完了しました');

  // 6. 送信成功後にボーナスをリセットして保存
  const saveResult = await saveStreakData(settledUsers);
  if (saveResult.success) {
    console.log('✅ ボーナスのリセット保存が完了しました');
  } else {
    console.error('❌ ボーナスのリセット保存に失敗しました:', saveResult.error);
    errors.push(saveResult.error);
  }

  // Discordへ送ったのに失敗した場合は、Webhookが失効している可能性がある。
  // 清算そのものはLINEに届いているためリセットは済ませたうえで、
  // 終了コードで知らせる(Discordはフォールバック専用で普段は叩かれないため、
  // この月次実行が唯一の定期的な疎通確認になっている)
  const discordResult = notifyResult.results.find(result => result.channel === 'discord');
  if (discordResult && !discordResult.success) {
    console.error('❌ Discordへの送信に失敗しました。Webhookが失効している可能性があります:', discordResult.error);
    errors.push(`Discordへの疎通確認に失敗しました: ${discordResult.error}`);
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
