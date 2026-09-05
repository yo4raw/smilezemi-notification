/**
 * 環境変数管理とシークレット処理モジュール
 */

const REQUIRED_SECRETS = [
  'SMILEZEMI_USERNAME',
  'SMILEZEMI_PASSWORD',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_USER_ID',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN'
];

/**
 * 環境変数から設定をロードする
 * @returns {object} 設定オブジェクト
 * @throws {Error} 必須環境変数が欠落している場合
 */
function loadConfig() {
  const secrets = Object.fromEntries(REQUIRED_SECRETS.map(key => [key, process.env[key]?.trim()]));

  const { valid, missing } = validateSecrets(secrets);
  if (!valid) {
    throw new Error(`必須環境変数が設定されていません: ${missing.join(', ')}`);
  }

  // 任意: 未設定ならDiscordへ送らないだけで通知そのものは動くため必須にしない
  return { ...secrets, DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL?.trim() || undefined };
}

/**
 * シークレットの存在を検証する
 * @param {object} secrets - 検証するシークレットオブジェクト
 * @returns {{valid: boolean, missing: string[]}}
 */
function validateSecrets(secrets) {
  const missing = REQUIRED_SECRETS.filter(key => !secrets[key] || secrets[key].trim() === '');
  return { valid: missing.length === 0, missing };
}

/**
 * 文字列中の `password=...` / `token=...` パターンを伏せる
 * @param {string} text
 * @returns {string}
 */
function maskSensitiveData(text) {
  if (typeof text !== 'string') {
    return text;
  }
  return text.replace(/(password|token)=\w+/gi, '$1=***');
}

/**
 * 既知の秘密値をリテラル一致で全置換し、パターンマスクも通す
 *
 * 正規表現を組み立てると秘密値に含まれる特殊文字(+ * [ ( 等)がメタ文字として
 * 解釈されてマスクが空振りしたり SyntaxError を投げたりするため、split/join で置換する。
 * このエラー文字列はDiscordへの転送でGitHub Actionsの自動マスクが効かない場所へ出る。
 *
 * @param {string} text - マスキング対象
 * @param {...(string|undefined)} secrets - 伏せる値。空・未設定は無視する
 * @returns {string}
 */
function maskLiterals(text, ...secrets) {
  let masked = String(text);
  for (const secret of secrets) {
    if (secret && masked.includes(secret)) {
      masked = masked.split(secret).join('***');
    }
  }
  return maskSensitiveData(masked);
}

module.exports = {
  loadConfig,
  validateSecrets,
  maskSensitiveData,
  maskLiterals
};
