/**
 * Discord通知モジュール - Webhook送信
 *
 * LINE送信が失敗したときのフォールバック先。
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 */

// Discordメッセージの最大長（Discord APIの制限。LINEの5000より短い）
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

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
 * Discord Webhook にメッセージを送信する
 *
 * @param {string} message - 送信するメッセージ（2000文字以内に切り詰め済みであること）
 * @param {string} webhookUrl - Discord Webhook URL
 * @param {object} [options] - オプション設定
 * @param {number} [options.maxRetries=3] - 最大リトライ回数
 * @param {number} [options.retryDelay=1000] - リトライ間隔（ms、指数バックオフ）
 * @param {number} [options.timeoutMs=10000] - 1試行あたりのHTTPタイムアウト（ms）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendDiscordMessage(message, webhookUrl, options = {}) {
  const { maxRetries = 3, retryDelay = 1000, timeoutMs = 10000 } = options;

  if (!webhookUrl) {
    return { success: false, error: 'Discord Webhook URLが設定されていません' };
  }

  if (!message) {
    return { success: false, error: '送信するメッセージが空です' };
  }

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
  maskWebhookUrl,
  DISCORD_MAX_MESSAGE_LENGTH
};
