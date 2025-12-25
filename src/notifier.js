/**
 * 通知モジュール - LINE Messaging API統合
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 7.1, 7.2, 9.4
 */

const { maskSensitiveData } = require('./config');

// LINE Push Message APIエンドポイント
const LINE_API_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

// メッセージの最大長（LINE APIの制限）
const MAX_MESSAGE_LENGTH = 5000;

/**
 * LINE通知を送信する
 *
 * @param {Array} changes - 変更情報の配列
 * @param {string} accessToken - LINE Channel Access Token
 * @param {string} userId - LINE User ID
 * @param {object} [options] - オプション設定
 * @param {number} [options.maxRetries=3] - 最大リトライ回数
 * @param {number} [options.retryDelay=1000] - リトライ間隔（ms、指数バックオフ）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendNotification(changes, accessToken, userId, options = {}) {
  const { maxRetries = 3, retryDelay = 1000 } = options;

  // パラメータ検証
  if (!accessToken || !userId) {
    return {
      success: false,
      error: '必須パラメータが欠けています: accessToken と userId が必要です'
    };
  }

  // メッセージを構築
  const message = formatMessage(changes);

  // リクエストボディを構築
  const requestBody = {
    to: userId,
    messages: [
      {
        type: 'text',
        text: message
      }
    ]
  };

  // リトライロジック
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await attemptSendNotification(requestBody, accessToken);

      if (result.success) {
        return result;
      }

      // 認証エラー（401）の場合はリトライしない
      if (result.error && result.error.includes('401')) {
        return result;
      }

      // 最後の試行でなければリトライ
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1); // 指数バックオフ
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // 最後の試行でも失敗
      return result;

    } catch (error) {
      const maskedError = maskTokenInError(error.message, accessToken);

      // 最後の試行でなければリトライ
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // 最後の試行でも失敗
      return {
        success: false,
        error: `通知送信失敗（${attempt}回試行）: ${maskedError}`
      };
    }
  }

  // ここには到達しないはずだが、念のため
  return {
    success: false,
    error: `通知送信失敗: 最大リトライ回数（${maxRetries}回）に達しました`
  };
}

/**
 * 1回の通知送信試行
 * @private
 */
async function attemptSendNotification(requestBody, accessToken) {
  try {
    // LINE Push Message APIを呼び出し
    const response = await fetch(LINE_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody)
    });

    // レスポンスステータスを確認
    if (!response.ok) {
      // 認証エラー（401）
      if (response.status === 401) {
        return {
          success: false,
          error: '認証エラー: アクセストークンが無効です (401 Unauthorized)'
        };
      }

      // その他のAPIエラー
      return {
        success: false,
        error: `LINE API エラー: ${response.status} ${response.statusText}`
      };
    }

    // 送信成功
    return {
      success: true
    };

  } catch (error) {
    // エラーメッセージをマスキング
    const maskedError = maskTokenInError(error.message, accessToken);

    // ネットワークエラー
    if (error.message.includes('network') || error.message.includes('fetch')) {
      return {
        success: false,
        error: `ネットワークエラー: ${maskedError}`
      };
    }

    // その他のエラー
    return {
      success: false,
      error: `通知送信エラー: ${maskedError}`
    };
  }
}

/**
 * エラーメッセージから実際のトークンを除去
 * @private
 */
function maskTokenInError(errorMessage, token) {
  if (!token) {
    return errorMessage;
  }

  // トークンの値を *** に置換
  let masked = errorMessage;

  // 実際のトークン値を置換
  if (masked.includes(token)) {
    masked = masked.replace(new RegExp(token, 'g'), '***');
  }

  // 一般的なトークンパターンもマスキング
  masked = maskSensitiveData(masked);

  return masked;
}

/**
 * 変更情報をLINE通知用のメッセージにフォーマット
 *
 * @param {Array} changes - 変更情報の配列
 * @returns {string} - フォーマットされたメッセージ
 */
function formatMessage(changes) {
  // 変更がない場合
  if (changes.length === 0) {
    return '📊 スマイルゼミ ミッション数\n\n本日は変更ありませんでした。';
  }

  // ヘッダー
  let message = '📊 スマイルゼミ ミッション数\n\n';

  // 変更がある場合
  message += `🔔 ${changes.length}件の変更がありました\n\n`;

  // 各変更を追加
  changes.forEach((change, index) => {
    let changeIcon = '';
    let changeText = '';

    switch (change.type) {
      case 'increase':
        changeIcon = '📈';
        changeText = `${change.previousCount} → ${change.currentCount} (+${change.diff})`;
        break;
      case 'decrease':
        changeIcon = '📉';
        changeText = `${change.previousCount} → ${change.currentCount} (${change.diff})`;
        break;
      case 'new':
        changeIcon = '✨';
        changeText = `新規: ${change.currentCount}ミッション`;
        break;
      default:
        changeIcon = '📊';
        changeText = `${change.previousCount} → ${change.currentCount}`;
    }

    message += `${changeIcon} ${change.userName}\n${changeText}\n\n`;

    // メッセージ長を確認（5000文字制限）
    if (message.length > MAX_MESSAGE_LENGTH - 100) {
      // 残りの件数を表示して終了
      const remaining = changes.length - index - 1;
      if (remaining > 0) {
        message += `... 他${remaining}件の変更があります`;
      }
      return message;
    }
  });

  // メッセージが5000文字を超えていた場合は切り詰め
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.substring(0, MAX_MESSAGE_LENGTH - 20) + '\n\n（メッセージが長すぎたため省略されました）';
  }

  return message.trim();
}

/**
 * ユーザー一覧をLINEに通知する
 *
 * @param {Array<{name: string, index: number}>} users - ユーザー一覧
 * @param {string} accessToken - LINE Channel Access Token
 * @param {string} userId - LINE User ID
 * @param {object} [options] - オプション設定
 * @param {number} [options.maxRetries=3] - 最大リトライ回数
 * @param {number} [options.retryDelay=1000] - リトライ間隔（ms、指数バックオフ）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendUserListNotification(users, accessToken, userId, options = {}) {
  const { maxRetries = 3, retryDelay = 1000 } = options;

  // パラメータ検証
  if (!accessToken || !userId) {
    return {
      success: false,
      error: '必須パラメータが欠けています: accessToken と userId が必要です'
    };
  }

  if (!users || users.length === 0) {
    return {
      success: false,
      error: 'ユーザー一覧が空です'
    };
  }

  // メッセージを構築
  const message = formatUserListMessage(users);

  // リクエストボディを構築
  const requestBody = {
    to: userId,
    messages: [
      {
        type: 'text',
        text: message
      }
    ]
  };

  // リトライロジック
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await attemptSendNotification(requestBody, accessToken);

      if (result.success) {
        return result;
      }

      // 認証エラー（401）の場合はリトライしない
      if (result.error && result.error.includes('401')) {
        return result;
      }

      // 最後の試行でなければリトライ
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1); // 指数バックオフ
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // 最後の試行でも失敗
      return result;

    } catch (error) {
      const maskedError = maskTokenInError(error.message, accessToken);

      // 最後の試行でなければリトライ
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // 最後の試行でも失敗
      return {
        success: false,
        error: `ユーザー一覧通知送信失敗（${attempt}回試行）: ${maskedError}`
      };
    }
  }

  // ここには到達しないはずだが、念のため
  return {
    success: false,
    error: `ユーザー一覧通知送信失敗: 最大リトライ回数（${maxRetries}回）に達しました`
  };
}

/**
 * ユーザー一覧をLINE通知用のメッセージにフォーマット
 *
 * @param {Array<{name: string, index: number}>} users - ユーザー一覧
 * @returns {string} - フォーマットされたメッセージ
 */
function formatUserListMessage(users) {
  // ヘッダー
  let message = '👥 スマイルゼミ ユーザー一覧\n\n';

  // ユーザー数のみ表示
  message += `登録ユーザー数: ${users.length}名`;

  return message.trim();
}

module.exports = {
  sendNotification,
  formatMessage,
  sendUserListNotification
};
