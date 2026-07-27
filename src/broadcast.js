/**
 * 送信層
 *
 * 1本のメッセージをどの宛先へどの順序で送るかだけを担う。
 * - broadcastMessage: LINEに送り、失敗したときだけDiscordへ転送する（日次の通知が使う）
 * - broadcastToAll:   LINEの成否にかかわらずDiscordへも送る（月次清算だけが使う）
 *
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 *       docs/superpowers/specs/2026-07-27-monthly-discord-healthcheck-design.md
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
 * 設定値のシークレット（LINEトークン・ユーザーID）を文字列からマスキングする
 *
 * 例外メッセージはnotifier側のマスキングを経ていない生の文字列なので、
 * Discordへ転送する前にここで落とす。正規表現を組むとシークレットに含まれる
 * 特殊文字で破綻するため split/join でリテラル一致の全置換を行う。
 *
 * @private
 * @param {string} text - マスキング対象の文字列
 * @param {object} config - 設定オブジェクト
 * @returns {string}
 */
function maskConfigSecrets(text, config) {
  let masked = String(text);

  for (const secret of [config.LINE_CHANNEL_ACCESS_TOKEN, config.LINE_USER_ID, config.DISCORD_WEBHOOK_URL]) {
    if (secret && secret.length >= 8 && masked.includes(secret)) {
      masked = masked.split(secret).join('***');
    }
  }

  return masked;
}

/**
 * LINEへ送信する。想定外の例外も「LINE失敗」として畳み込む
 *
 * 例外がここを素通りするとDiscordが一度も呼ばれず通知が無音になるため、
 * 「LINEがどう失敗してもDiscordに回る」という不変条件をこのtry/catchで保証する。
 *
 * @private
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendToLine(message, config, options) {
  try {
    return await sendPushMessage(
      truncateToLimit(message, LINE_MAX_MESSAGE_LENGTH),
      config.LINE_CHANNEL_ACCESS_TOKEN,
      config.LINE_USER_ID,
      options
    );
  } catch (error) {
    // 例外メッセージはDiscordの理由行に載るため、シークレットを落としてから積む
    return {
      success: false,
      error: `LINE送信で予期しない例外が発生しました: ${maskConfigSecrets(error && error.message ? error.message : error, config)}`
    };
  }
}

/**
 * Discordへ送信する
 *
 * lineError が渡された場合は転送であることを示す理由行を先頭に付ける。
 * null の場合（LINEが成功しているケース）は本文をそのまま送る。
 *
 * @private
 * @param {string} message - 本文
 * @param {object} config - 設定オブジェクト
 * @param {object} options - 送信オプション
 * @param {string|null} lineError - LINE送信のエラー文字列。成功していれば null
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendToDiscord(message, config, options, lineError) {
  const body = lineError ? formatFallbackMessage(message, lineError) : message;
  return sendDiscordMessage(
    truncateToLimit(body, DISCORD_MAX_MESSAGE_LENGTH),
    config.DISCORD_WEBHOOK_URL,
    options
  );
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

  const lineResult = await sendToLine(message, config, options);
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
  const discordResult = await sendToDiscord(message, config, options, lineResult.error);
  results.push({ channel: 'discord', success: discordResult.success, error: discordResult.error });

  if (discordResult.success) {
    console.warn('⚠️ LINEには届きませんでしたが、Discordへの転送に成功しました');
  } else {
    console.error('❌ Discordへの転送にも失敗しました:', discordResult.error);
  }

  return { success: discordResult.success, results };
}

/**
 * メッセージをLINEとDiscordの両方へ送る
 *
 * LINEの成否にかかわらずDiscordへも送る。月次ボーナス清算だけがこれを使う。
 * Discordはフォールバック専用のままだとLINEが成功する限り一度も叩かれず、
 * Webhookが失効しても「LINEが落ちた当日」まで気づけない。年12回必ず走る
 * 月次清算を定期的な疎通確認に使うことで、失効を最大1か月で検知する。
 *
 * success の意味は broadcastMessage() と同じく「1つ以上の宛先に届いたか」。
 * Discord単体の失敗をどう扱うかは呼び出し側が results を見て決める。
 *
 * @param {string} message - 送信するメッセージ（切り詰めは本関数が宛先ごとに行う）
 * @param {{LINE_CHANNEL_ACCESS_TOKEN: string, LINE_USER_ID: string, DISCORD_WEBHOOK_URL?: string}} config
 * @param {object} [options] - 送信オプション（maxRetries / retryDelay / timeoutMs）。両宛先に渡る
 * @returns {Promise<{success: boolean, results: Array<{channel: string, success: boolean, error?: string}>}>}
 */
async function broadcastToAll(message, config, options = {}) {
  const results = [];

  const lineResult = await sendToLine(message, config, options);
  results.push({ channel: 'line', success: lineResult.success, error: lineResult.error });

  if (!lineResult.success) {
    console.error('❌ LINEへの送信に失敗しました:', lineResult.error);
  }

  if (!config.DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、Discordへの送信をスキップします');
    return { success: lineResult.success, results };
  }

  console.log('📤 Discordへ送信しています...');
  // LINEが失敗している場合だけ理由行を付ける（成功時は本文をそのまま送る）
  const discordResult = await sendToDiscord(
    message,
    config,
    options,
    lineResult.success ? null : lineResult.error
  );
  results.push({ channel: 'discord', success: discordResult.success, error: discordResult.error });

  if (!discordResult.success) {
    console.error('❌ Discordへの送信に失敗しました:', discordResult.error);
  }

  return { success: lineResult.success || discordResult.success, results };
}

module.exports = {
  broadcastMessage,
  broadcastToAll,
  formatFallbackMessage,
  LINE_MAX_MESSAGE_LENGTH
};
