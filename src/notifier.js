/**
 * 通知モジュール - LINE Messaging API統合
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 7.1, 7.2, 9.4
 */

const { maskSensitiveData } = require('./config');
const { countStudyItems } = require('./streak');

// LINE Push Message APIエンドポイント
const LINE_API_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

// メッセージの最大長（LINE APIの制限）
const MAX_MESSAGE_LENGTH = 5000;

// 通知に並べる講座の最大件数。超過分は「ほか◯件」にまとめる。
// クローラー側では全件取得しており、合計点や学習件数は全件から計算される。
const MAX_LISTED_COURSES = 10;

// 学習件数がしきい値に届かないときに出す警告文言。
// 使うのは前日確定の結果を伝える朝通知だけなので過去形にする。
// 残り件数だけを出すため、コース別の単位ラベル(学習/講座)は使わない。
const formatMissionWarning = remaining => `😢😢 あと${remaining}件たりなかった… 😢😢`;

// 免除日(おやすみ)の見出し。夜通知だけが出す(朝はストリーク行が伝えるため)
const EXEMPT_NOTICE = '🏝️ 今日はおやすみ（免除日）';

// 夜通知の名前一覧。1行1名で並べる
const listUserNames = names => names.map(name => `👤 ${name}`).join('\n');

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
  // メッセージを構築して送信（リトライ等はsendPushMessageに委譲）
  return sendPushMessage(formatMessage(changes), accessToken, userId, options);
}

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

  // パラメータ検証
  if (!accessToken || !userId) {
    return {
      success: false,
      error: '必須パラメータが欠けています: accessToken と userId が必要です'
    };
  }

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
      const result = await attemptSendNotification(requestBody, accessToken, timeoutMs);

      if (result.success) {
        return result;
      }

      // リトライで解決しないエラーは即失敗にする:
      // 401=トークン無効、429=月間送信数上限またはレート制限
      if (result.error && (result.error.includes('401') || result.error.includes('429'))) {
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
async function attemptSendNotification(requestBody, accessToken, timeoutMs = 10000) {
  // タイムアウト付きでLINE Push Message APIを呼び出し
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(LINE_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    // レスポンスステータスを確認
    if (!response.ok) {
      // LINE APIはエラー理由をボディで返す（例: "You have reached your monthly limit."）。
      // 原因調査に必須のためエラーメッセージに含める。取得失敗時はstatusのみで続行
      let detail = '';
      try {
        if (typeof response.text === 'function') {
          const body = (await response.text()).trim();
          if (body) {
            detail = ` - ${maskTokenInError(body, accessToken)}`;
          }
        }
      } catch {
        // ボディ取得失敗は無視（statusだけでも報告する）
      }

      // 認証エラー（401）
      if (response.status === 401) {
        return {
          success: false,
          error: `認証エラー: アクセストークンが無効です (401 Unauthorized)${detail}`
        };
      }

      // その他のAPIエラー
      return {
        success: false,
        error: `LINE API エラー: ${response.status} ${response.statusText}${detail}`
      };
    }

    // 送信成功
    return {
      success: true
    };

  } catch (error) {
    // エラーメッセージをマスキング
    const maskedError = maskTokenInError(error.message, accessToken);

    // タイムアウト（AbortControllerによる中断）
    if (error.name === 'AbortError' || error.message.includes('abort')) {
      return {
        success: false,
        error: `タイムアウト: LINE APIが${timeoutMs}ms以内に応答しませんでした`
      };
    }

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
  } finally {
    clearTimeout(timer);
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
  // 正規表現を組み立てると、トークンに含まれる特殊文字（+ * [ ( 等）が
  // メタ文字として解釈されてマスクが空振りしたり、SyntaxError を投げたりする。
  // このエラー文字列はDiscordへの転送でGitHub Actionsの自動マスクが効かない場所へ出るため、
  // 正規表現を使わない split/join でリテラル一致の全置換を行う
  if (masked.includes(token)) {
    masked = masked.split(token).join('***');
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
  for (const [index, change] of changes.entries()) {
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

    const entry = `${changeIcon} ${change.userName}\n${changeText}\n\n`;

    // メッセージ長を確認（5000文字制限）: 追加すると省略行の余地がなくなる場合は打ち切り
    if (message.length + entry.length > MAX_MESSAGE_LENGTH - 100) {
      const remaining = changes.length - index;
      message += `... 他${remaining}件の変更があります`;
      break;
    }

    message += entry;
  }

  // メッセージが5000文字を超えていた場合は切り詰め
  if (message.length > MAX_MESSAGE_LENGTH) {
    const suffix = '\n\n（メッセージが長すぎたため省略されました）';
    message = message.substring(0, MAX_MESSAGE_LENGTH - suffix.length) + suffix;
  }

  return message.trim();
}

/**
 * 詳細データをLINE通知用のメッセージにフォーマット
 * Requirements: 4.1, 4.2, 4.3, 4.4
 *
 * @param {Array<{userName: string, missionCount: number, date: string, studyTime: {hours: number, minutes: number}, totalScore: number, missions: Array<{name: string, score: number, completed: boolean}>}>} userData - ユーザーデータ配列（v2.0形式）
 * @param {Array<{userName: string, missionCount: number, date: string, studyTime: {hours: number, minutes: number}, totalScore: number, missions: Array<{name: string, score: number, completed: boolean}>}>} [previousData] - 前回のユーザーデータ配列（v2.0形式、オプション）
 * @param {object} [options] - 表示オプション
 * @param {string[]} [options.exemptUserNames=null] - 免除日のユーザー名。未達警告を出さない
 * @returns {string} - フォーマットされたメッセージ
 */
function formatDetailedMessage(userData, missionChanges = null, options = {}) {
  const {
    dateLabel = null,
    showNoStudyWarning = false,
    streaks = null,
    missionWarningThreshold = null,
    missionWarningThresholds = null,
    exemptUserNames = null
  } = options;

  // ヘッダー（dateLabel 指定時は「昨日(MM/DD)の学習状況」等になる）
  let message = dateLabel
    ? `📊 スマイルゼミ ${dateLabel}の学習状況\n\n`
    : '📊 スマイルゼミ 学習状況\n\n';

  // データがない場合
  if (!userData || userData.length === 0) {
    message += dateLabel ? `${dateLabel}のデータはありません。` : '本日のデータはありません。';
    return message.trim();
  }

  // ミッション変化情報をユーザー名でマッピング
  const changesMap = new Map();
  if (missionChanges && missionChanges.userChanges) {
    missionChanges.userChanges.forEach(userChange => {
      const missionMap = new Map();
      userChange.missionChanges.forEach(change => {
        missionMap.set(change.missionName, change);
      });
      changesMap.set(userChange.userName, missionMap);
    });
  }

  // 各ユーザーのデータを追加
  userData.forEach((user, index) => {
    // ユーザー名
    message += `👤 ${user.userName}\n`;

    // ストリーク(連続学習日数)情報
    if (streaks && streaks[user.userName]) {
      message += `${streaks[user.userName]}\n`;
    }

    // データ取得に失敗したユーザーは学習有無を判定できないため、専用の警告を出す
    // (学習件数0件と区別できないままだと未取得なのか未学習なのか読み取れない)
    if (user.dataReliable === false) {
      message += '⚠️ データを取得できませんでした\n';
    }

    // 勉強時間
    const hours = user.studyTime?.hours ?? 0;
    const minutes = user.studyTime?.minutes ?? 0;
    message += `⏱️ 勉強時間: ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}\n`;

    // コース種別: course フィールド優先、なければ名前サフィックスで判定
    const course = user.course || (user.userName.includes('中学生コース') ? 'juniorHigh' : 'elementary');
    const isJuniorHigh = course === 'juniorHigh';
    const scoreUnit = isJuniorHigh ? '%' : '点';
    const detailLabel = isJuniorHigh ? '学習詳細' : 'ミッション詳細';
    // 中学生コースはミッション以外の自主学習概念がないため件数行も「講座」表記にする。
    // 小学生コースはミッション以外の自主学習も件数に含めるため「学習」表記のまま
    const unitLabel = isJuniorHigh ? '講座' : '学習';

    const missions = user.missions ?? [];
    const isNoStudy = hours === 0 && minutes === 0 && missions.length === 0;

    // 学習件数(ミッション+自主)。自主学習があるときだけ内訳を出す
    const studyItemCount = countStudyItems(user);
    const missionOnlyCount = user.missionCount ?? studyItemCount;
    const selfStudyCount = Math.max(0, studyItemCount - missionOnlyCount);

    if (!(showNoStudyWarning && isNoStudy) && studyItemCount > 0) {
      message += selfStudyCount > 0
        ? `✅ ${unitLabel}${studyItemCount}件（ミッション${missionOnlyCount}・自主${selfStudyCount}）\n`
        : `✅ ${unitLabel}${studyItemCount}件\n`;
    }

    // 完了数未達の警告。コース別しきい値(missionWarningThresholds)を優先し、
    // なければ単一の missionWarningThreshold を使う(後方互換)。
    // 免除日(おやすみ)のユーザーには警告を出さない。
    const warnThreshold = missionWarningThresholds
      ? (isJuniorHigh ? missionWarningThresholds.juniorHigh : missionWarningThresholds.elementary)
      : missionWarningThreshold;

    const isExempt = Array.isArray(exemptUserNames) && exemptUserNames.includes(user.userName);

    if (!isExempt && warnThreshold && user.dataReliable !== false && !(showNoStudyWarning && isNoStudy)) {
      const completedCount = countStudyItems(user);
      if (completedCount < warnThreshold) {
        message += `${formatMissionWarning(warnThreshold - completedCount)}\n`;
      }
    }

    // ミッション詳細（朝通知では未学習の場合に警告文言のみ表示）

    if (showNoStudyWarning && isNoStudy && user.dataReliable !== false) {
      message += '⚠️ 昨日は学習していません\n';
    } else if (missions.length > 0) {
      message += `\n📋 ${detailLabel}:\n`;

      // ユーザーの変化情報を取得
      const userChangesMap = changesMap.get(user.userName);

      // 同名ミッションを集約（最初の点数→最後の点数）
      const missionGroups = new Map();
      missions.forEach(mission => {
        if (!missionGroups.has(mission.name)) {
          missionGroups.set(mission.name, []);
        }
        missionGroups.get(mission.name).push(mission);
      });

      // 表示は先頭 MAX_LISTED_COURSES 件まで。超過分は「ほか◯件」にまとめる
      const groupEntries = Array.from(missionGroups.entries());
      const listedEntries = groupEntries.slice(0, MAX_LISTED_COURSES);
      const omittedCount = groupEntries.length - listedEntries.length;

      listedEntries.forEach(([missionName, group]) => {
        let scoreDisplay;
        let changeIcon = '';

        const lastEntry = group[group.length - 1];

        // 正答数タイプ(9/10 等)は点数ではないので、そのまま分数表記で出す
        if (lastEntry.questionCount != null) {
          scoreDisplay = `${lastEntry.correctAnswers ?? 0}/${lastEntry.questionCount}`;
        } else if (group.length === 1) {
          // 1回のみ実施
          const mission = group[0];

          if (userChangesMap) {
            const change = userChangesMap.get(mission.name);

            if (change) {
              if (change.type === 'score_change') {
                scoreDisplay = `${change.previousScore}→${change.currentScore}${scoreUnit}`;
                changeIcon = change.scoreChange > 0 ? ' 📈' : ' 📉';
              } else if (change.type === 'new_mission') {
                scoreDisplay = `${change.currentScore}${scoreUnit}（NEW）`;
                changeIcon = ' ✨';
              } else {
                scoreDisplay = `${change.currentScore}${scoreUnit}`;
              }
            } else {
              scoreDisplay = `${mission.score}${scoreUnit}`;
              if (!mission.completed) {
                changeIcon = ' ✨';
              }
            }
          } else {
            scoreDisplay = `${mission.score}${scoreUnit}`;
            if (!mission.completed) {
              changeIcon = ' ✨';
            }
          }
        } else {
          // 複数回実施（最初→最後の点数で表示）
          const firstMission = group[0];
          const lastMission = group[group.length - 1];

          if (firstMission.score !== lastMission.score) {
            scoreDisplay = `${firstMission.score}→${lastMission.score}${scoreUnit}`;
            changeIcon = lastMission.score > firstMission.score ? ' 📈' : ' 📉';
          } else {
            scoreDisplay = `${lastMission.score}${scoreUnit}`;
          }

          // NEWマーク判定（最後の実施が未完了）
          if (!lastMission.completed) {
            changeIcon += ' ✨';
          }
        }

        // 同名グループが全て自主学習のときだけ（自主）を付ける
        const selfStudyMark = group.every(mission => mission.isMission === false) ? '（自主）' : '';

        message += `  ・${missionName}: ${scoreDisplay}${selfStudyMark}${changeIcon}\n`;
      });

      if (omittedCount > 0) {
        message += `  ・ほか${omittedCount}件\n`;
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
 * 夜通知用のメッセージを組み立てる
 *
 * 夜通知は速報であり、当日中に挽回してほしいユーザーを知らせることだけが目的のため、
 * 学習件数・ミッション詳細・勉強時間は出さず名前だけを並べる(翌朝の確定通知が詳細をカバーする)。
 * データ取得に失敗したユーザーは未達と断定できないため、別枠に分けて並べる。
 *
 * @param {object} [params]
 * @param {Array<string>} [params.unqualifiedNames=[]] - 当日のストリーク要件が未達のユーザー名
 * @param {Array<string>} [params.unreliableNames=[]] - データ取得に失敗したユーザー名
 * @param {Array<string>} [params.exemptNames=[]] - 免除日(おやすみ)のユーザー名
 * @returns {string} - フォーマットされたメッセージ
 */
function formatUnqualifiedMessage({ unqualifiedNames = [], unreliableNames = [], exemptNames = [] } = {}) {
  const sections = ['📊 スマイルゼミ 学習状況'];

  if (unqualifiedNames.length > 0) {
    sections.push('🚨 まだ今日のノルマが終わっていません');
    sections.push(listUserNames(unqualifiedNames));
  }

  if (unreliableNames.length > 0) {
    sections.push('⚠️ データを取得できませんでした');
    sections.push(listUserNames(unreliableNames));
  }

  // 呼びかける相手がいない日でも、クローリングが回ったことが分かるように結果を1行残す
  if (unqualifiedNames.length === 0 && unreliableNames.length === 0) {
    sections.push(exemptNames.length > 0
      ? '✅ おやすみの人以外は本日のノルマを達成しました'
      : '✅ 全員が本日のノルマを達成しました');
  }

  if (exemptNames.length > 0) {
    sections.push(EXEMPT_NOTICE);
    sections.push(listUserNames(exemptNames));
  }

  return sections.join('\n\n');
}

/**
 * メッセージを指定文字数以内に切り詰める
 *
 * 上限は宛先ごとに異なる（LINE=5000, Discord=2000）ため引数で受け取る。
 * Requirements: 4.5
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
  // 末尾が高サロゲートなら1コードユニット削って正しい文字列に整える
  if (body.length > 0 && isHighSurrogate(body.charCodeAt(body.length - 1))) {
    body = body.slice(0, -1);
  }

  return body + suffix;
}

/**
 * UTF-16 の高サロゲート（サロゲートペアの前半）かどうか
 * @private
 */
function isHighSurrogate(charCode) {
  return charCode >= 0xD800 && charCode <= 0xDBFF;
}

module.exports = {
  sendNotification,
  sendPushMessage,
  formatMessage,
  formatDetailedMessage,
  formatUnqualifiedMessage,
  truncateToLimit
};
