/**
 * 指数バックオフ付きリトライ
 *
 * ログイン(auth)・LINE送信(notifier)・Discord送信(discord)が同じ形のループを
 * それぞれ持っていたため1つに集約する。
 *
 * fn は {success: boolean, ...} を返す。success か shouldRetry(result) が false なら即返す。
 * fn が例外を投げたら onThrow(error, attempt) の戻り値を結果として扱う(省略時は再スロー)。
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.maxRetries=3] - 最大試行回数
 * @param {number} [options.retryDelay=1000] - 初回の待機(ms)。以降は2倍ずつ増える
 * @param {(result: T) => boolean} [options.shouldRetry] - 失敗結果を再試行するか(既定: 常に再試行)
 * @param {(error: Error, attempt: number) => T} [options.onThrow] - 例外を結果に畳み込む
 * @returns {Promise<T>} 最後の結果
 */
async function retry(fn, options = {}) {
  const { maxRetries = 3, retryDelay = 1000, shouldRetry = () => true, onThrow = null } = options;
  let result;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await fn(attempt);
      if (result.success || !shouldRetry(result)) {
        return result;
      }
    } catch (error) {
      if (!onThrow) {
        throw error;
      }
      result = onThrow(error, attempt);
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, retryDelay * 2 ** (attempt - 1)));
    }
  }

  return result;
}

module.exports = { retry };
