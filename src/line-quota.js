/**
 * LINE送信枠モジュール - 月間の残り送信可能数の取得と表示
 *
 * 無料プランの月間上限(200カウント)に対し、いま何カウント残っているかを
 * 通知の末尾に載せるためのモジュール。グループへのpushは
 * 「メッセージ数 × グループ人数」でカウントされるため、人数で割った
 * 「あと何回通知できるか」も併せて出す。
 *
 * ここでの失敗は通知本体を止めてはならない。すべて {success, data/error} に畳み込み、
 * 呼び出し側(src/broadcast.js)は失敗時に残数行を落として送信を続ける。
 */

const { maskSensitiveData } = require('./config');

const LINE_API_BASE = 'https://api.line.me/v2/bot';

// 送信枠の取得は通知本体の付帯情報にすぎないため、短めに打ち切ってリトライもしない。
// ここで粘ると本来送りたい通知そのものが遅れる
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 宛先IDからメンバー数APIのパスを決める
 *
 * LINEの宛先IDは種別が先頭1文字で分かる: C=グループ / R=ルーム / U=個人。
 * 個人宛は常に1人なのでAPIを叩かない。
 *
 * @private
 * @param {string} targetId - 送信先ID (LINE_USER_ID)
 * @returns {string|null} メンバー数APIのパス。個人宛・不明な種別なら null
 */
function resolveMemberCountPath(targetId) {
  if (targetId.startsWith('C')) {
    return `${LINE_API_BASE}/group/${targetId}/members/count`;
  }

  if (targetId.startsWith('R')) {
    return `${LINE_API_BASE}/room/${targetId}/members/count`;
  }

  return null;
}

/**
 * LINE APIをGETしてJSONを返す
 *
 * @private
 * @param {string} url - リクエストURL
 * @param {string} accessToken - LINE Channel Access Token
 * @param {number} timeoutMs - タイムアウト(ms)
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function getJson(url, accessToken, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        success: false,
        error: `LINE API エラー: ${response.status} ${response.statusText}`
      };
    }

    return { success: true, data: await response.json() };

  } catch (error) {
    const message = maskToken(error && error.message ? error.message : String(error), accessToken);

    if (error && (error.name === 'AbortError' || message.includes('abort'))) {
      return {
        success: false,
        error: `タイムアウト: LINE APIが${timeoutMs}ms以内に応答しませんでした`
      };
    }

    return { success: false, error: `送信枠の取得に失敗しました: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * エラーメッセージから実際のトークンを除去する
 *
 * このエラー文字列はログに出るため、GitHub Actionsの自動マスクが効かない経路でも
 * 漏れないようリテラル一致で落としておく。正規表現を組むとトークン中の特殊文字で破綻する。
 *
 * @private
 */
function maskToken(text, accessToken) {
  let masked = String(text);

  if (accessToken && masked.includes(accessToken)) {
    masked = masked.split(accessToken).join('***');
  }

  return maskSensitiveData(masked);
}

/**
 * 月間の送信枠の状況を取得する
 *
 * @param {{LINE_CHANNEL_ACCESS_TOKEN: string, LINE_USER_ID: string}} config - 設定オブジェクト
 * @param {object} [options] - オプション
 * @param {number} [options.timeoutMs=5000] - 1リクエストのタイムアウト(ms)
 * @returns {Promise<{success: boolean, data?: {limited: boolean, limit: number|null, used: number, remaining: number|null, memberCount: number|null}, error?: string}>}
 */
async function fetchQuotaStatus(config, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const accessToken = config && config.LINE_CHANNEL_ACCESS_TOKEN;
  const targetId = config && config.LINE_USER_ID;

  if (!accessToken || !targetId) {
    return {
      success: false,
      error: '送信枠を取得できません: LINE_CHANNEL_ACCESS_TOKEN と LINE_USER_ID が必要です'
    };
  }

  const memberCountPath = resolveMemberCountPath(targetId);

  // 3本を並行に叩く。メンバー数だけは失敗しても残数の表示を諦めない
  const [quotaResult, consumptionResult, memberResult] = await Promise.all([
    getJson(`${LINE_API_BASE}/message/quota`, accessToken, timeoutMs),
    getJson(`${LINE_API_BASE}/message/quota/consumption`, accessToken, timeoutMs),
    memberCountPath ? getJson(memberCountPath, accessToken, timeoutMs) : Promise.resolve(null)
  ]);

  if (!quotaResult.success) {
    return { success: false, error: quotaResult.error };
  }

  if (!consumptionResult.success) {
    return { success: false, error: consumptionResult.error };
  }

  const limited = quotaResult.data.type === 'limited';
  const limit = limited ? quotaResult.data.value : null;
  const used = consumptionResult.data.totalUsage ?? 0;

  // 上限に達した後もカウントは進むため、残数は0で止める
  const remaining = limited ? Math.max(0, limit - used) : null;

  // memberResult が null なら個人宛(1人)。取得に失敗したら人数不明として null
  let memberCount = null;
  if (memberCountPath === null) {
    memberCount = 1;
  } else if (memberResult && memberResult.success) {
    memberCount = memberResult.data.count ?? null;
  }

  return {
    success: true,
    data: { limited, limit, used, remaining, memberCount }
  };
}

/**
 * 送信枠の状況を通知末尾に載せる1行にする
 *
 * @param {{limited: boolean, limit: number|null, used: number, remaining: number|null, memberCount: number|null}} [status] - fetchQuotaStatus の data
 * @returns {string|null} 残数行。データがなければ null
 */
function formatQuotaLine(status) {
  if (!status) {
    return null;
  }

  // 上限なしプランでは残数の概念がないため、今月の使用数だけを出す
  if (!status.limited) {
    return `📮 LINE送信数: ${status.used}（上限なし）`;
  }

  const base = `📮 LINE残り: ${status.remaining}/${status.limit}`;

  if (!status.memberCount || status.memberCount < 1) {
    return base;
  }

  // グループへのpushは1通あたり人数分カウントされる
  return `${base}（あと${Math.floor(status.remaining / status.memberCount)}回）`;
}

module.exports = {
  fetchQuotaStatus,
  formatQuotaLine
};
