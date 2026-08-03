/**
 * Discord通知モジュール - Webhook送信
 *
 * 全通知の送信先。2000文字を超える本文は分割して複数通で送る。
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 *       docs/superpowers/specs/2026-08-03-discord-message-split-design.md
 */

// Discordメッセージの最大長（Discord APIの制限。LINEの5000より短い）
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// ページ番号ヘッダー "(10/10)\n" のための予約幅。
// ヘッダーの長さは総チャンク数が決まるまで確定しないため、余裕を持った固定値で先に引いておく
const CHUNK_HEADER_RESERVE = 16;

// Webhook URL のトークン部分（末尾セグメント）を検出する
const WEBHOOK_URL_PATTERN = /(https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+)\/[\w-]+/g;

/**
 * Webhook URL のトークン部分をマスキングする
 *
 * Webhook URL は実質的なパスワードで、漏れると誰でもそのチャンネルに投稿できる。
 * ログ・エラーメッセージに出す前に必ず通すこと。
 *
 * @param {string} text - マスキング対象の文字列
 * @param {string} [webhookUrl] - 既知のWebhook URL（パターンに合わない形式への保険）
 * @returns {string} マスキング済み文字列
 */
function maskWebhookUrl(text, webhookUrl) {
  if (typeof text !== 'string') {
    return text;
  }

  let masked = text.replace(WEBHOOK_URL_PATTERN, '$1/***');

  // パターンに合わないホストで運用された場合に備え、既知のトークン文字列も直接置換する
  if (webhookUrl) {
    const token = webhookUrl.split('/').pop();
    if (token && token.length >= 8 && masked.includes(token)) {
      masked = masked.split(token).join('***');
    }
  }

  return masked;
}

/**
 * UTF-16 の高サロゲート（サロゲートペアの前半）かどうか
 * @private
 */
function isHighSurrogate(charCode) {
  return charCode >= 0xD800 && charCode <= 0xDBFF;
}

/**
 * 1行が上限を超える場合に、その行を文字単位で分割する
 *
 * サロゲートペアの途中で切ると孤立サロゲートが残り、不正なUTF-16を含むJSONは
 * Discordに400で弾かれる（非リトライ判定なのでその通が丸ごと失われる）。
 * 末尾が高サロゲートなら1コードユニット手前で切る。
 *
 * @private
 * @param {string} line - 分割する行
 * @param {number} maxLength - 1片の最大長
 * @returns {string[]}
 */
function splitLongLine(line, maxLength) {
  const pieces = [];
  let rest = line;

  while (rest.length > maxLength) {
    let cut = maxLength;
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) {
      cut -= 1;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest.length > 0) {
    pieces.push(rest);
  }

  return pieces;
}

/**
 * 本文を上限以内のチャンクへ分割する
 *
 * 行の境界で詰め込むため、ユーザーごとのブロックが途中で割れにくい。
 * 2チャンク以上になる場合は各チャンクの先頭に "(1/3)" の行を付ける。
 * 途中の通が届かなかったときに欠けへ気づけるようにするためで、1通で収まるなら付けない。
 *
 * @param {string} message - 分割する本文
 * @param {number} [maxLength=2000] - 1通の最大長（ページ番号を含めた長さ）
 * @returns {string[]} 分割済みメッセージ。空文字なら空配列
 */
function splitIntoChunks(message, maxLength = DISCORD_MAX_MESSAGE_LENGTH) {
  if (!message) {
    return [];
  }

  // まず上限そのままで詰めてみる。1通に収まるならページ番号は不要
  const plain = packLines(message, maxLength);
  if (plain.length <= 1) {
    return plain;
  }

  // 2通以上になるならページ番号の分だけ幅を狭めて詰め直す
  const chunks = packLines(message, maxLength - CHUNK_HEADER_RESERVE);

  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}

/**
 * 行を上限以内へ詰め込む（ページ番号は付けない）
 * @private
 * @returns {string[]}
 */
function packLines(message, maxLength) {
  const chunks = [];
  let current = '';

  const appendCurrent = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (const line of message.split('\n')) {
    // 1行だけで上限を超える行は、先に文字単位へ割ってから詰める
    for (const piece of (line.length > maxLength ? splitLongLine(line, maxLength) : [line])) {
      // 空行(piece === '')も改行1文字分を消費するため、長さ計算は current が空かどうかで分ける
      const candidate = current.length === 0 ? piece : `${current}\n${piece}`;

      if (candidate.length <= maxLength) {
        current = candidate;
      } else {
        appendCurrent();
        current = piece;
      }
    }
  }

  appendCurrent();

  return chunks;
}

/**
 * Discord Webhook にメッセージを送信する
 *
 * 2000文字を超える本文は分割して複数通で送る。途中の通が失敗しても残りは送り、
 * 1つでも失敗したら全体を失敗として返す（届く分は届けたうえで異常を報告する）。
 *
 * @param {string} message - 送信するメッセージ（長さの調整は本関数が行う）
 * @param {string} webhookUrl - Discord Webhook URL
 * @param {object} [options] - オプション設定
 * @param {number} [options.maxRetries=3] - 最大リトライ回数
 * @param {number} [options.retryDelay=1000] - リトライ間隔（ms、指数バックオフ）
 * @param {number} [options.timeoutMs=10000] - 1試行あたりのHTTPタイムアウト（ms）
 * @param {number} [options.chunkDelay=300] - 分割送信時のチャンク間の待機（ms）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendDiscordMessage(message, webhookUrl, options = {}) {
  const { chunkDelay = 300 } = options;

  if (!webhookUrl) {
    return { success: false, error: 'Discord Webhook URLが設定されていません' };
  }

  if (!message) {
    return { success: false, error: '送信するメッセージが空です' };
  }

  const chunks = splitIntoChunks(message, DISCORD_MAX_MESSAGE_LENGTH);
  const failures = [];

  for (const [index, chunk] of chunks.entries()) {
    // レート制限(429)はリトライで吸収できるが、無駄な往復を減らすため間隔を空ける
    if (index > 0 && chunkDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, chunkDelay));
    }

    const result = await sendSingleMessage(chunk, webhookUrl, options);

    if (!result.success) {
      // 1通でも欠ければ通知は不完全なので、どの通が落ちたかを添えて失敗を積む
      console.error(`❌ Discordへの送信に失敗しました (${index + 1}/${chunks.length}):`, result.error);
      failures.push(`(${index + 1}/${chunks.length}) ${result.error}`);
    }
  }

  if (failures.length > 0) {
    return { success: false, error: failures.join(' / ') };
  }

  return { success: true };
}

/**
 * 分割済みの1通を送る（リトライ込み）
 * @private
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendSingleMessage(message, webhookUrl, options = {}) {
  const { maxRetries = 3, retryDelay = 1000, timeoutMs = 10000 } = options;

  const requestBody = { content: message };
  let lastError = 'Discord送信に失敗しました';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await attemptSendDiscord(requestBody, webhookUrl, timeoutMs);

    if (result.success) {
      return { success: true };
    }

    lastError = result.error;

    // 429以外の4xxはリトライしても解決しない（404=Webhook削除, 400=ペイロード不正, 401=認証）
    if (!result.retryable) {
      return { success: false, error: lastError };
    }

    if (attempt < maxRetries) {
      const delay = retryDelay * Math.pow(2, attempt - 1); // 指数バックオフ
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: `${lastError}（${maxRetries}回試行）` };
}

/**
 * 1回の送信試行
 * @private
 * @returns {Promise<{success: boolean, error?: string, retryable?: boolean}>}
 */
async function attemptSendDiscord(requestBody, webhookUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      // Discordはエラー理由をボディで返す（例: {"message": "Unknown Webhook"}）。
      // 原因調査に必須のためエラーメッセージに含める。取得失敗時はstatusのみで続行
      let detail = '';
      try {
        if (typeof response.text === 'function') {
          const body = (await response.text()).trim();
          if (body) {
            detail = ` - ${body}`;
          }
        }
      } catch {
        // ボディ取得失敗は無視（statusだけでも報告する）
      }

      // 429はレート制限（Retry-After付きの「後で再送せよ」）なのでリトライする。
      // LINEの429=月間送信上限とは意味が違い、少し待てば送れる
      return {
        success: false,
        retryable: response.status === 429 || response.status >= 500,
        error: maskWebhookUrl(
          `Discord API エラー: ${response.status} ${response.statusText}${detail}`,
          webhookUrl
        )
      };
    }

    return { success: true };

  } catch (error) {
    const masked = maskWebhookUrl(error.message, webhookUrl);

    if (error.name === 'AbortError' || masked.includes('abort')) {
      return {
        success: false,
        retryable: true,
        error: `タイムアウト: Discord Webhookが${timeoutMs}ms以内に応答しませんでした`
      };
    }

    return { success: false, retryable: true, error: `Discord送信エラー: ${masked}` };

  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sendDiscordMessage,
  splitIntoChunks,
  maskWebhookUrl,
  DISCORD_MAX_MESSAGE_LENGTH
};
