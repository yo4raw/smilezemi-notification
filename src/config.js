/**
 * 環境変数管理とシークレット処理モジュール
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.2, 9.3, 9.4
 */

const REQUIRED_SECRETS = [
  'SMILEZEMI_USERNAME',
  'SMILEZEMI_PASSWORD',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_USER_ID'
];

const SENSITIVE_FIELDS = [
  'password',
  'token',
  'channelAccessToken',
  'accessToken',
  'secret',
  'key'
];

/**
 * 環境変数から設定をロードする
 * @returns {object} 設定オブジェクト
 * @throws {Error} 必須環境変数が欠落している場合
 */
function loadConfig() {
  const secrets = {
    SMILEZEMI_USERNAME: process.env.SMILEZEMI_USERNAME,
    SMILEZEMI_PASSWORD: process.env.SMILEZEMI_PASSWORD,
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    LINE_USER_ID: process.env.LINE_USER_ID
  };

  const validation = validateSecrets(secrets);

  if (!validation.valid) {
    throw new Error(
      `必須環境変数が設定されていません: ${validation.missing.join(', ')}`
    );
  }

  return {
    smilezemi: {
      username: secrets.SMILEZEMI_USERNAME,
      password: secrets.SMILEZEMI_PASSWORD
    },
    line: {
      channelAccessToken: secrets.LINE_CHANNEL_ACCESS_TOKEN,
      userId: secrets.LINE_USER_ID
    }
  };
}

/**
 * シークレットの存在を検証する
 * @param {object} secrets - 検証するシークレットオブジェクト
 * @returns {object} { valid: boolean, missing: string[] }
 */
function validateSecrets(secrets) {
  const missing = [];

  for (const key of REQUIRED_SECRETS) {
    if (!secrets[key] || secrets[key].trim() === '') {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * センシティブデータをマスキングする
 * @param {string|object} data - マスキングするデータ
 * @returns {string|object} マスキングされたデータ
 */
function maskSensitiveData(data) {
  // 文字列の場合
  if (typeof data === 'string') {
    let masked = data;

    // パスワード、トークンのパターンをマスキング
    masked = masked.replace(/password=[\w]+/gi, 'password=***');
    masked = masked.replace(/token=[\w]+/gi, 'token=***');

    return masked;
  }

  // オブジェクトの場合
  if (typeof data === 'object' && data !== null) {
    const masked = { ...data };

    for (const key in masked) {
      const lowerKey = key.toLowerCase();

      // センシティブフィールドをマスキング
      const isSensitive = SENSITIVE_FIELDS.some(field =>
        lowerKey.includes(field.toLowerCase())
      );

      if (isSensitive) {
        masked[key] = '***';
      }
    }

    return masked;
  }

  return data;
}

module.exports = {
  loadConfig,
  validateSecrets,
  maskSensitiveData
};
