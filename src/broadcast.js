/**
 * 送信フォールバック層
 *
 * 1本のメッセージをどの宛先へどの順序で送るかだけを担う。
 * LINEに送り、成功したら終了。失敗したときだけDiscordへ転送する。
 *
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 */

const { sendPushMessage, truncateToLimit } = require('./notifier');
const { sendDiscordMessage, DISCORD_MAX_MESSAGE_LENGTH } = require('./discord');

// LINEメッセージの最大長（LINE APIの制限）
const LINE_MAX_MESSAGE_LENGTH = 5000;

/**
 * Discord転送用にフォールバックの理由行を先頭に付ける
 *
 * 受信者が「LINEの月間枠切れ」なのか「障害」なのかを判別できるように理由を載せる。
 * lineError は notifier 側でトークンがマスキング済みの文字列であること。
 *
 * @param {string} message - 本文
 * @param {string} lineError - LINE送信のエラー文字列
 * @returns {string}
 */
function formatFallbackMessage(message, lineError) {
  return [
    '⚠️ LINEへの送信に失敗したためDiscordに転送しました',
    `理由: ${lineError}`,
    '',
    message
  ].join('\n');
}

/**
 * メッセージをLINEへ送り、失敗した場合のみDiscordへ転送する
 *
 * success は「1つ以上の宛先に届いたか」を表す。LINEの月間枠が尽きている間ずっと
 * ワークフローが赤くなり毎日失敗通知が届く状態を避けるため、この定義にしている。
 *
 * @param {string} message - 送信するメッセージ（切り詰めは本関数が宛先ごとに行う）
 * @param {{LINE_CHANNEL_ACCESS_TOKEN: string, LINE_USER_ID: string, DISCORD_WEBHOOK_URL?: string}} config
 * @param {object} [options] - 送信オプション（maxRetries / retryDelay / timeoutMs）。両宛先に渡る
 * @returns {Promise<{success: boolean, results: Array<{channel: string, success: boolean, error?: string}>}>}
 */
async function broadcastMessage(message, config, options = {}) {
  const results = [];

  const lineResult = await sendPushMessage(
    truncateToLimit(message, LINE_MAX_MESSAGE_LENGTH),
    config.LINE_CHANNEL_ACCESS_TOKEN,
    config.LINE_USER_ID,
    options
  );
  results.push({ channel: 'line', success: lineResult.success, error: lineResult.error });

  if (lineResult.success) {
    return { success: true, results };
  }

  console.error('❌ LINEへの送信に失敗しました:', lineResult.error);

  if (!config.DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、Discordへのフォールバックをスキップします');
    return { success: false, results };
  }

  console.log('📤 Discordへフォールバック送信しています...');
  const fallbackMessage = truncateToLimit(
    formatFallbackMessage(message, lineResult.error),
    DISCORD_MAX_MESSAGE_LENGTH
  );
  const discordResult = await sendDiscordMessage(
    fallbackMessage,
    config.DISCORD_WEBHOOK_URL,
    options
  );
  results.push({ channel: 'discord', success: discordResult.success, error: discordResult.error });

  if (discordResult.success) {
    console.warn('⚠️ LINEには届きませんでしたが、Discordへの転送に成功しました');
  } else {
    console.error('❌ Discordへの転送にも失敗しました:', discordResult.error);
  }

  return { success: discordResult.success, results };
}

module.exports = {
  broadcastMessage,
  formatFallbackMessage,
  LINE_MAX_MESSAGE_LENGTH
};
