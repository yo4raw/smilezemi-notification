/**
 * 通知モジュール - LINE Messaging API統合
 */

const { maskLiterals } = require('./config');
const { countStudyItems } = require('./streak');
const { retry } = require('./retry');

// LINE Push Message APIエンドポイント
const LINE_API_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

// メッセージの最大長（LINE APIの制限）
const MAX_MESSAGE_LENGTH = 5000;

// 通知に並べる講座の最大件数。超過分は「ほか◯件」にまとめる。
// クローラー側では全件取得しており、合計点や学習件数は全件から計算される。
const MAX_LISTED_COURSES = 10;

// 学習件数がしきい値に届かないときに出す警告文言。
// 夜通知(today)は当日中に挽回できるため励まし、朝通知(past)は前日確定の結果報告なので過去形にする。
// 残り件数だけを出すため、コース別の単位ラベル(学習/講座)は使わない。
const MISSION_WARNING_STYLES = {
  today: remaining => `🚨🚨 あと${remaining}件! がんばろう! 🚨🚨`,
  past: remaining => `😢😢 あと${remaining}件たりなかった… 😢😢`
};

// 免除日(おやすみ)の告知行。夜通知だけが出す(朝はストリーク行が伝えるため)
const EXEMPT_NOTICE = '🏝️ 今日はおやすみ（免除日）';

/**
 * 整形済みメッセージをLINEに送信する
 *
 * @param {string} message - 送信する整形済みメッセージ
 * @param {string} accessToken - LINE Channel Access Token
 * @param {string} userId - LINE User ID
 * @param {object} [options] - オプション設定
 * @param {number} [options.maxRetries=3] - 最大リトライ回数
 * @param {number} [options.retryDelay=1000] - リトライ間隔（ms、指数バックオフ）
 * @param {number} [options.timeoutMs=10000] - 1試行あたりのHTTPタイムアウト（ms）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendPushMessage(message, accessToken, userId, options = {}) {
  const { maxRetries = 3, retryDelay = 1000, timeoutMs = 10000 } = options;

  if (!accessToken || !userId) {
    return {
      success: false,
      error: '必須パラメータが欠けています: accessToken と userId が必要です'
    };
  }

  const requestBody = {
    to: userId,
    messages: [{ type: 'text', text: message }]
  };

  return retry(() => attemptSendNotification(requestBody, accessToken, timeoutMs), {
    maxRetries,
    retryDelay,
    // 401=トークン無効、429=月間送信数上限またはレート制限。リトライで解決しないため即失敗にする
    shouldRetry: result => !/401|429/.test(result.error ?? ''),
    onThrow: (error, attempt) => ({
      success: false,
      error: `通知送信失敗（${attempt}回試行）: ${maskLiterals(error.message, accessToken)}`
    })
  });
}

/**
 * 1回の通知送信試行
 * @private
 */
async function attemptSendNotification(requestBody, accessToken, timeoutMs = 10000) {
  try {
    const response = await fetch(LINE_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      // LINE APIはエラー理由をボディで返す（例: "You have reached your monthly limit."）。
      // 原因調査に必須のためエラーメッセージに含める。取得失敗時はstatusのみで続行
      let detail = '';
      try {
        if (typeof response.text === 'function') {
          const body = (await response.text()).trim();
          if (body) {
            detail = ` - ${maskLiterals(body, accessToken)}`;
          }
        }
      } catch {
        // ボディ取得失敗は無視（statusだけでも報告する）
      }

      if (response.status === 401) {
        return {
          success: false,
          error: `認証エラー: アクセストークンが無効です (401 Unauthorized)${detail}`
        };
      }

      return {
        success: false,
        error: `LINE API エラー: ${response.status} ${response.statusText}${detail}`
      };
    }

    return { success: true };

  } catch (error) {
    const maskedError = maskLiterals(error.message, accessToken);

    if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message.includes('abort')) {
      return {
        success: false,
        error: `タイムアウト: LINE APIが${timeoutMs}ms以内に応答しませんでした`
      };
    }

    if (error.message.includes('network') || error.message.includes('fetch')) {
      return {
        success: false,
        error: `ネットワークエラー: ${maskedError}`
      };
    }

    return {
      success: false,
      error: `通知送信エラー: ${maskedError}`
    };
  }
}

/**
 * 詳細データをLINE通知用のメッセージにフォーマット
 *
 * @param {Array<{userName: string, course?: string, studyItemCount?: number, missionCount?: number, studyTime?: {hours: number, minutes: number}, missions?: Array<{name: string, score: number, isMission?: boolean, correctAnswers?: number|null, questionCount?: number|null}>, dataReliable?: boolean}>} userData - ユーザーデータ配列
 * @param {object} [options] - 表示オプション
 * @param {string|null} [options.dateLabel=null] - ヘッダの日付ラベル(「昨日(MM/DD)」等)
 * @param {boolean} [options.showNoStudyWarning=false] - 完全未学習の日に「学習していません」を出すか(朝通知は true)
 * @param {boolean} [options.showStudyTime=true] - 勉強時間行を表示するか(夜通知は false)
 * @param {Object<string, string>|null} [options.streaks=null] - ユーザー名→ストリーク表示行
 * @param {{elementary: number, juniorHigh: number}|null} [options.missionWarningThresholds=null] - コース別の未達警告しきい値
 * @param {'today'|'past'} [options.missionWarningStyle='past'] - 未達警告の文言(夜通知は 'today')
 * @param {string[]|null} [options.exemptUserNames=null] - 免除日のユーザー名。未達警告を出さない
 * @param {boolean} [options.showExemptNotice=false] - 免除ユーザーに「おやすみ」行を出すか(夜通知は true)
 * @returns {string} - フォーマットされたメッセージ
 */
function formatDetailedMessage(userData, options = {}) {
  const {
    dateLabel = null,
    showNoStudyWarning = false,
    showStudyTime = true,
    streaks = null,
    missionWarningThresholds = null,
    missionWarningStyle = 'past',
    exemptUserNames = null,
    showExemptNotice = false
  } = options;

  let message = dateLabel
    ? `📊 スマイルゼミ ${dateLabel}の学習状況\n\n`
    : '📊 スマイルゼミ 学習状況\n\n';

  if (!userData || userData.length === 0) {
    message += dateLabel ? `${dateLabel}のデータはありません。` : '本日のデータはありません。';
    return message.trim();
  }

  const formatWarning = MISSION_WARNING_STYLES[
    Object.hasOwn(MISSION_WARNING_STYLES, missionWarningStyle) ? missionWarningStyle : 'past'
  ];

  userData.forEach((user, index) => {
    message += `👤 ${user.userName}\n`;

    if (streaks && streaks[user.userName]) {
      message += `${streaks[user.userName]}\n`;
    }

    // データ取得に失敗したユーザーは学習有無を判定できないため、専用の警告を出す
    // (学習件数0件と区別できないままだと未取得なのか未学習なのか読み取れない)
    if (user.dataReliable === false) {
      message += '⚠️ データを取得できませんでした\n';
    }

    // 勉強時間(夜通知は翌朝の確定通知でカバーするため出さない)
    const hours = user.studyTime?.hours ?? 0;
    const minutes = user.studyTime?.minutes ?? 0;
    if (showStudyTime) {
      message += `⏱️ 勉強時間: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}\n`;
    }

    const isJuniorHigh = user.course === 'juniorHigh';
    const scoreUnit = isJuniorHigh ? '%' : '点';
    const detailLabel = isJuniorHigh ? '学習詳細' : 'ミッション詳細';
    // 中学生コースはミッション以外の自主学習概念がないため件数行も「講座」表記にする
    const unitLabel = isJuniorHigh ? '講座' : '学習';

    const missions = user.missions ?? [];
    const noStudyDay = showNoStudyWarning && hours === 0 && minutes === 0 && missions.length === 0;

    // 学習件数(ミッション+自主)。自主学習があるときだけ内訳を出す
    const studyItemCount = countStudyItems(user);
    const missionOnlyCount = user.missionCount ?? studyItemCount;
    const selfStudyCount = Math.max(0, studyItemCount - missionOnlyCount);

    if (!noStudyDay && studyItemCount > 0) {
      message += selfStudyCount > 0
        ? `✅ ${unitLabel}${studyItemCount}件（ミッション${missionOnlyCount}・自主${selfStudyCount}）\n`
        : `✅ ${unitLabel}${studyItemCount}件\n`;
    }

    // 完了数未達の警告(コース別しきい値)。免除日(おやすみ)のユーザーには出さない
    const warnThreshold = missionWarningThresholds
      ? (isJuniorHigh ? missionWarningThresholds.juniorHigh : missionWarningThresholds.elementary)
      : null;
    const isExempt = Array.isArray(exemptUserNames) && exemptUserNames.includes(user.userName);

    if (isExempt) {
      if (showExemptNotice) {
        message += `${EXEMPT_NOTICE}\n`;
      }
    } else if (warnThreshold && user.dataReliable !== false && !noStudyDay && studyItemCount < warnThreshold) {
      message += `${formatWarning(warnThreshold - studyItemCount)}\n`;
    }

    // ミッション詳細（朝通知では未学習の場合に警告文言のみ表示）
    if (noStudyDay && user.dataReliable !== false) {
      message += '⚠️ 昨日は学習していません\n';
    } else if (missions.length > 0) {
      message += `\n📋 ${detailLabel}:\n`;

      // 同名講座を集約（最初の点数→最後の点数）
      const groups = new Map();
      missions.forEach(mission => groups.set(mission.name, [...(groups.get(mission.name) ?? []), mission]));
      const entries = [...groups.entries()];

      // 表示は先頭 MAX_LISTED_COURSES 件まで。超過分は「ほか◯件」にまとめる
      entries.slice(0, MAX_LISTED_COURSES).forEach(([missionName, group]) => {
        const first = group[0];
        const last = group[group.length - 1];
        let scoreDisplay;
        let changeIcon = '';

        if (last.questionCount != null) {
          // 正答数タイプ(9/10 等)は点数ではないので、そのまま分数表記で出す
          scoreDisplay = `${last.correctAnswers ?? 0}/${last.questionCount}`;
        } else if (group.length > 1 && first.score !== last.score) {
          scoreDisplay = `${first.score}→${last.score}${scoreUnit}`;
          changeIcon = last.score > first.score ? ' 📈' : ' 📉';
        } else {
          scoreDisplay = `${last.score}${scoreUnit}`;
        }

        // 同名グループが全て自主学習のときだけ（自主）を付ける
        const selfStudyMark = group.every(mission => mission.isMission === false) ? '（自主）' : '';

        message += `  ・${missionName}: ${scoreDisplay}${selfStudyMark}${changeIcon}\n`;
      });

      if (entries.length > MAX_LISTED_COURSES) {
        message += `  ・ほか${entries.length - MAX_LISTED_COURSES}件\n`;
      }
    } else {
      message += `\n📋 ${detailLabel}なし\n`;
    }

    // ユーザー間のセパレータ（最後のユーザー以外）
    if (index < userData.length - 1) {
      message += '\n';
    }
  });

  return message.trim();
}

/**
 * メッセージを指定文字数以内に切り詰める
 *
 * 上限は宛先ごとに異なる（LINE=5000, Discord=2000）ため引数で受け取る。
 *
 * @param {string} message - メッセージ文字列
 * @param {number} [maxLength=5000] - 上限文字数
 * @returns {string} - 切り詰められたメッセージ
 */
function truncateToLimit(message, maxLength = MAX_MESSAGE_LENGTH) {
  if (message.length <= maxLength) {
    return message;
  }

  const suffix = '\n\n...（メッセージが長すぎるため省略）';
  let body = message.substring(0, maxLength - suffix.length);

  // substring は UTF-16 コードユニット単位で切るため、👤 📊 のような BMP 外の絵文字の
  // 途中で切れると末尾に孤立した高サロゲートが残る。不正なUTF-16を含むJSONは
  // 転送先(Discord)に400で弾かれ、非リトライ判定でメッセージが丸ごと失われるため、
  // 不正なUTF-16(isWellFormed が false)なら1コードユニット削って正しい文字列に整える
  if (!body.isWellFormed()) {
    body = body.slice(0, -1);
  }

  return body + suffix;
}

module.exports = {
  sendPushMessage,
  formatDetailedMessage,
  truncateToLimit
};
