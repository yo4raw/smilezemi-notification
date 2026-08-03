/**
 * 送信層
 *
 * 1本のメッセージをどの宛先へどの順序で送るかだけを担う。
 * - broadcastToAll:   LINEの成否にかかわらずDiscordへも送る（LINEを使う全通知が使う）
 * - broadcastToDiscordOnly: Discordだけへ送る（夜通知の全員達成日だけが使う）
 *
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 *       docs/superpowers/specs/2026-07-27-monthly-discord-healthcheck-design.md
 *       docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md
 *       docs/superpowers/specs/2026-08-03-always-dual-notification-design.md
 */

const { sendPushMessage, truncateToLimit } = require('./notifier');
const { sendDiscordMessage, DISCORD_MAX_MESSAGE_LENGTH } = require('./discord');

// LINEメッセージの最大長（LINE APIの制限）
const LINE_MAX_MESSAGE_LENGTH = 5000;

/**
 * Discordへ送る本文の先頭にLINE失敗の理由行を付ける
 *
 * 通常はLINEにも同じ内容が届いているため、Discordだけに届いた回であることを
 * 受信者が判別できるようにする。「月間枠切れ」なのか「障害」なのかを見分けられるよう
 * 理由も載せる。lineError は notifier 側でトークンがマスキング済みの文字列であること。
 *
 * @param {string} message - 本文
 * @param {string} lineError - LINE送信のエラー文字列
 * @returns {string}
 */
function formatFallbackMessage(message, lineError) {
  return [
    '⚠️ LINEへの送信に失敗しました（この通知はDiscordにのみ届いています）',
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
 * Discordへ送信する。想定外の例外も「Discord失敗」として畳み込む
 *
 * 本文はすでに完成した状態で渡される。理由行を付けるかどうかは
 * 呼び出し側の宛先ポリシーが決めることで、この関数はLINEの結果を知らない。
 *
 * 例外を畳み込むのは主に broadcastToAll() のため。LINE成功後にDiscordで例外が抜けると
 * 呼び出し元（月次清算）の後続処理に到達せず、清算メッセージはLINEに届いているのに
 * ボーナスがリセットされない = 翌月に同じ分が再清算される二重支給になる。
 *
 * @private
 * @param {string} body - 送信する本文（理由行の付加は呼び出し側で済ませておく）
 * @param {object} config - 設定オブジェクト
 * @param {object} options - 送信オプション
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function postToDiscord(body, config, options) {
  try {
    // 2000文字を超える本文の分割は sendDiscordMessage が行うため、ここでは切り詰めない
    return await sendDiscordMessage(body, config.DISCORD_WEBHOOK_URL, options);
  } catch (error) {
    // 例外メッセージはログに残るため、シークレット（Webhook URL・LINEトークン）を落としてから積む
    return {
      success: false,
      error: `Discord送信で予期しない例外が発生しました: ${maskConfigSecrets(error && error.message ? error.message : error, config)}`
    };
  }
}

/**
 * メッセージをLINEとDiscordの両方へ送る
 *
 * LINEの成否にかかわらずDiscordへも送る。LINEを使う通知はすべてこれを使う。
 * Discordをフォールバック専用にしていた頃はLINEが成功する限り一度も叩かれず、
 * Webhookが失効しても「LINEが落ちた当日」まで気づけなかった。毎回両方へ送ることで
 * Discordが常時の記録先になり、失効も翌日には検知できる。
 *
 * success は「1つ以上の宛先に届いたか」を表す。LINEの月間枠が尽きている間ずっと
 * 通知が届かなかったと扱われる状態を避けるため、この定義にしている。
 * Discord単体の失敗をどう扱うかは呼び出し側が getDiscordFailure() で決める。
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
  const discordResult = await postToDiscord(
    lineResult.success ? message : formatFallbackMessage(message, lineResult.error || '不明なエラー'),
    config,
    options
  );
  results.push({ channel: 'discord', success: discordResult.success, error: discordResult.error });

  if (!discordResult.success) {
    console.error('❌ Discordへの送信に失敗しました:', discordResult.error);
  }

  return { success: lineResult.success || discordResult.success, results };
}

/**
 * メッセージをDiscordだけへ送る（LINEには送らない）
 *
 * 夜通知で全ユーザーが当日のストリーク要件を達成した日に使う。LINEグループへのpushは
 * 人数分カウントされ無料枠(月200)が逼迫しているため、この日はLINEを消費しない。
 * 一方Discordには月間送信数の上限がないので、記録としては必ず残す。
 *
 * success の意味は broadcastToAll() と同じく「1つ以上の宛先に届いたか」。
 * DISCORD_WEBHOOK_URL 未設定のときは「宛先がないから送らなかった」ことを skipped で示す。
 * この設定は任意扱いのため、未設定環境で毎晩ワークフローが赤くなるのを避けたい呼び出し側が
 * 「送って失敗した(success:false)」と区別できるようにしている。
 *
 * 本文に転送の理由行は付けない。LINEを試していないので「失敗して転送した」わけではなく、
 * 送らなかった理由を知っているのは呼び出し側（src/index.js）だからである。
 *
 * 設計: docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md
 *
 * @param {string} message - 送信するメッセージ（切り詰めは本関数が行う）
 * @param {{DISCORD_WEBHOOK_URL?: string}} config
 * @param {object} [options] - 送信オプション（maxRetries / retryDelay / timeoutMs）
 * @returns {Promise<{success: boolean, skipped?: boolean, results: Array<{channel: string, success: boolean, error?: string}>}>}
 */
async function broadcastToDiscordOnly(message, config, options = {}) {
  if (!config.DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、Discordへの送信をスキップします');
    return { success: false, skipped: true, results: [] };
  }

  console.log('📤 Discordへ送信しています...');
  const discordResult = await postToDiscord(message, config, options);

  if (!discordResult.success) {
    console.error('❌ Discordへの送信に失敗しました:', discordResult.error);
  }

  return {
    success: discordResult.success,
    results: [{ channel: 'discord', success: discordResult.success, error: discordResult.error }]
  };
}

/**
 * 送信結果からDiscordの失敗理由を取り出す
 *
 * Webhookの失効を検知するため、Discordだけが失敗した場合も呼び出し側で異常終了させたい。
 * その判定を各エントリポイントに散らかさないようここへ集約する。
 *
 * DISCORD_WEBHOOK_URL 未設定のときは results にDiscordのエントリ自体が入らない。
 * これは「宛先がないから送らなかった」であって失敗ではないため null を返し、
 * Discord連携を任意にしている環境でワークフローが赤くならないようにする。
 *
 * @param {{results?: Array<{channel: string, success: boolean, error?: string}>}} notifyResult
 * @returns {string|null} 失敗理由。失敗していなければ null
 */
function getDiscordFailure(notifyResult) {
  const discordResult = (notifyResult && notifyResult.results || []).find(result => result.channel === 'discord');

  if (!discordResult || discordResult.success) {
    return null;
  }

  return discordResult.error || '不明なエラー';
}

module.exports = {
  broadcastToAll,
  broadcastToDiscordOnly,
  formatFallbackMessage,
  getDiscordFailure,
  LINE_MAX_MESSAGE_LENGTH,
  // 呼び出し側（DRY_RUNプレビュー）が分割の単位を表示できるよう再エクスポートする
  DISCORD_MAX_MESSAGE_LENGTH
};
