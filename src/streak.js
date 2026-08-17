/**
 * ストリーク(連続学習日数)管理モジュール
 *
 * データ構造 (data/streak_data.json):
 * {
 *   version: "1.4",  // 1.3未満は全ユーザーのおたすけを3にする移行、1.4未満は免除日フィールドの補完を適用
 *   timestamp: "ISO 8601",
 *   users: {
 *     "ユーザー名": {                    // クローラーの表示名。コース選択画面を経由した場合のみ "名前 (コース名)" になる
 *       streak: number,                 // 確定済み連続学習日数(リプレイの導出値)
 *       grace: number,                  // おたすけ残数 (0〜3、リプレイの導出値)
 *       bonus: number,                  // ボーナスポイント (月次清算で0にリセット。リプレイ対象外)
 *       course: string|undefined,       // 'elementary' | 'juniorHigh'。月次清算の単価判定に使う。未設定は elementary 扱い
 *       lastConfirmedDate: string|null, // 最後に確定判定した日 (YYYY-MM-DD, JST)
 *       exemptDates: string[],          // 免除日 (YYYY-MM-DD)。未来・過去を問わない
 *       history: {                      // 判定対象日 → その日に学習が成立したか。保持は90日
 *         "YYYY-MM-DD": boolean
 *       },
 *       replayBase: {                   // history より前をまとめたチェックポイント
 *         streak: number,
 *         grace: number,
 *         date: string|null             // このチェックポイントが確定済みとしている最後の日
 *       }
 *     }
 *   }
 * }
 */

const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const STREAK_FILE = path.join(DATA_DIR, 'streak_data.json');

const GRACE_MAX = 3;
const GRACE_INITIAL = 1; // 初回特典。リセット後は0から再スタート(10日連続で再獲得)
const MILESTONE_INTERVAL = 10;
const HISTORY_RETENTION_DAYS = 90; // 学習履歴の保持日数。これより古い日は replayBase に畳み込む
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ストリーク更新(カウント+1)に必要な完了数。変更時はここだけ書き換える
const STREAK_REQUIREMENTS = {
  elementaryMissions: 4, // 小学生コース: 完了ミッション数(夜通知が使用)
  juniorHighCourses: 3   // 中学生コース: 完了講座数(朝通知が使用)。曜日によらず一律
};

/**
 * ストリーク状態の初期値を生成
 */
function createInitialState() {
  return {
    streak: 0,
    grace: GRACE_INITIAL,
    bonus: 0,
    lastConfirmedDate: null,
    exemptDates: [],
    history: {},
    replayBase: { streak: 0, grace: GRACE_INITIAL, date: null }
  };
}

/**
 * 完了ミッション数を数える
 * missionCount(クローラーが数えた完了数)を優先し、なければ missions の completed 件数を使う
 *
 * @param {{missionCount?: number, missions?: Array<{completed: boolean}>}} user - v2.0形式のユーザーデータ
 * @returns {number}
 */
function countCompletedMissions(user) {
  if (typeof user.missionCount === 'number') {
    return user.missionCount;
  }
  return (user.missions ?? []).filter(mission => mission.completed).length;
}

/**
 * その日の学習件数を数える(ミッション+自主学習)
 *
 * 小学生コースのタイムラインにはミッションバッジのない自主学習も並ぶ。
 * ストリークの達成判定はこの合計件数で行う。
 * studyItemCount を持たない旧データ(actions/cache に残る過去分)は
 * missionCount にフォールバックし、従来と同じ結果になるようにする。
 *
 * @param {{studyItemCount?: number, missionCount?: number, missions?: Array<{completed: boolean}>}} user
 * @returns {number}
 */
function countStudyItems(user) {
  if (typeof user.studyItemCount === 'number') {
    return user.studyItemCount;
  }
  return countCompletedMissions(user);
}

/**
 * その日に学習したかを判定(notifier.js の未学習判定と同一基準)
 *
 * minCompletedMissions を1以上指定した場合(コース別のしきい値)は
 * 「学習件数(ミッション+自主学習) >= 指定値」のみで判定し、勉強時間は見ない。
 *
 * @param {{studyTime?: {hours: number, minutes: number}, studyItemCount?: number, missionCount?: number, missions?: Array}} user - v2.0形式のユーザーデータ
 * @param {object} [options]
 * @param {number} [options.minCompletedMissions=0] - ストリークに必要な学習件数
 * @returns {boolean}
 */
function isStudied(user, options = {}) {
  const { minCompletedMissions = 0 } = options;

  if (minCompletedMissions > 0) {
    return countStudyItems(user) >= minCompletedMissions;
  }

  const hours = user.studyTime?.hours ?? 0;
  const minutes = user.studyTime?.minutes ?? 0;
  const missions = user.missions ?? [];
  return !(hours === 0 && minutes === 0 && missions.length === 0);
}

/**
 * 1日分の確定判定(純粋関数)
 * - 判定済みの日付以前はスキップ(同日再実行の冪等性)
 * - 空白日(前回確定日との間の未判定日)は中立扱い: 対象日のみ判定する
 *
 * @param {{streak: number, grace: number, lastConfirmedDate: string|null}} state
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @param {boolean} studied - 対象日に学習したか
 * @param {object} [options]
 * @param {boolean} [options.exempt=false] - 免除日なら未学習でも罰しない
 * @returns {{state: object, event: 'milestone'|'grace_used'|'reset'|'exempt'|'none'}}
 */
function confirmDay(state, dateString, studied, options = {}) {
  // YYYY-MM-DD 形式は辞書順比較 = 日付順比較
  if (state.lastConfirmedDate && dateString <= state.lastConfirmedDate) {
    return { state, event: 'none' };
  }

  // ボーナスは全分岐で保持される(月次清算でのみ0になる)。旧データにはフィールドがないため0扱い
  const bonus = state.bonus ?? 0;

  if (studied) {
    const streak = state.streak + 1;

    // おたすけ満タン中は学習した日ごとに毎日ボーナス+1(マイルストーン判定はしない)
    if (state.grace >= GRACE_MAX) {
      return {
        state: {
          streak,
          grace: state.grace,
          bonus: bonus + 1,
          lastConfirmedDate: dateString
        },
        event: 'bonus'
      };
    }

    const isMilestoneDay = streak % MILESTONE_INTERVAL === 0;
    return {
      state: {
        streak,
        grace: isMilestoneDay ? state.grace + 1 : state.grace,
        bonus,
        lastConfirmedDate: dateString
      },
      event: isMilestoneDay ? 'milestone' : 'none'
    };
  }

  // 免除日は未学習でも罰しない: streak も grace も据え置き、日付だけ進める。
  // studied の経路は先に return しているため、ここに届くのは未学習の日だけ
  if (options.exempt) {
    return {
      state: { streak: state.streak, grace: state.grace, bonus, lastConfirmedDate: dateString },
      event: 'exempt'
    };
  }

  // 守るべき記録がないうちはおたすけを消費せず、日付だけ確定する(初回特典の無駄消費防止)
  if (state.streak === 0) {
    return {
      state: {
        streak: 0,
        grace: state.grace,
        bonus,
        lastConfirmedDate: dateString
      },
      event: 'none'
    };
  }

  if (state.grace > 0) {
    return {
      state: {
        streak: state.streak,
        grace: state.grace - 1,
        bonus,
        lastConfirmedDate: dateString
      },
      event: 'grace_used'
    };
  }

  // ボーナスは支給予定のためリセットでも消えない
  return {
    state: { streak: 0, grace: 0, bonus, lastConfirmedDate: dateString },
    event: 'reset'
  };
}

/**
 * YYYY-MM-DD を日数だけずらす(純粋関数)
 * UTC深夜として解釈するため実行環境のタイムゾーンに依存しない
 *
 * @param {string} dateString - YYYY-MM-DD
 * @param {number} days - ずらす日数(負値で過去へ)
 * @returns {string} YYYY-MM-DD
 */
function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 学習履歴のキーを検証して日付昇順に返す(壊れたエントリは無視してログに残す)
 * 履歴の不備を理由に streak を失わせないための防御
 *
 * @private
 * @param {Object<string, boolean>} history
 * @returns {string[]}
 */
function sortedHistoryDates(history) {
  if (!history || typeof history !== 'object') {
    return [];
  }

  return Object.keys(history)
    .filter(date => {
      if (!DATE_PATTERN.test(date)) {
        console.warn(`⚠️ 学習履歴の不正な日付キーを無視します: ${date}`);
        return false;
      }
      if (typeof history[date] !== 'boolean') {
        console.warn(`⚠️ 学習履歴の不正な値を無視します: ${date}=${history[date]}`);
        return false;
      }
      return true;
    })
    .toSorted();
}

/**
 * 学習履歴を日付順に confirmDay へ通してストリーク状態を導出する(純粋関数)
 *
 * bonus はどの分岐の条件にも影響しない(confirmDay は読み書きするだけ)ため
 * リプレイでは扱わない。ボーナス残高は呼び出し側が当日のイベントで加算する。
 *
 * @param {{streak: number, grace: number, date: string|null}} replayBase - history より前の状態
 * @param {Object<string, boolean>} history - 判定対象日 → その日に学習が成立したか
 * @param {string[]} [exemptDates] - 免除日
 * @returns {{streak: number, grace: number, lastConfirmedDate: string|null, events: Object<string, string>}}
 */
function replayStreak(replayBase, history, exemptDates = []) {
  const base = replayBase || {};
  const exempt = new Set(exemptDates);
  const events = {};

  let state = {
    streak: base.streak ?? 0,
    grace: base.grace ?? GRACE_INITIAL,
    bonus: 0, // リプレイでは使わないダミー値
    lastConfirmedDate: base.date ?? null
  };

  sortedHistoryDates(history).forEach(date => {
    const result = confirmDay(state, date, history[date], { exempt: exempt.has(date) });
    state = result.state;
    events[date] = result.event;
  });

  return {
    streak: state.streak,
    grace: state.grace,
    lastConfirmedDate: state.lastConfirmedDate,
    events
  };
}

/**
 * 学習履歴に1日分を追記してリプレイし、新しい状態とその日のイベントを返す(純粋関数)
 *
 * 既に履歴にある日は何もしない(同日再実行の冪等性。旧 lastConfirmedDate ガードの役割)。
 * bonus はリプレイ対象外のため、その日のイベントが bonus のときだけここで加算する。
 *
 * @param {object} state - ユーザーのストリーク状態
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @param {boolean} studied - 対象日に学習が成立したか
 * @returns {{state: object, event: string}}
 */
function confirmDayWithHistory(state, dateString, studied) {
  const history = state.history || {};
  if (Object.hasOwn(history, dateString)) {
    return { state, event: 'none' };
  }

  const nextHistory = { ...history, [dateString]: studied };
  const replayed = replayStreak(state.replayBase, nextHistory, state.exemptDates || []);
  const event = replayed.events[dateString] || 'none';

  const next = {
    ...state,
    streak: replayed.streak,
    grace: replayed.grace,
    bonus: (state.bonus ?? 0) + (event === 'bonus' ? 1 : 0),
    lastConfirmedDate: replayed.lastConfirmedDate,
    history: nextHistory
  };

  return { state: pruneHistory(next), event };
}

/**
 * 保持期間より古い学習履歴を replayBase に畳み込む(純粋関数、入力は変更しない)
 *
 * 畳み込みの際も免除日を参照するため、免除の効果はチェックポイントに正しく残る。
 * 畳み込み済みの免除日は効果が replayBase に入っているため取り除く。
 *
 * @param {object} state - ユーザーのストリーク状態
 * @param {number} [retentionDays=HISTORY_RETENTION_DAYS]
 * @returns {object} 新しい状態
 */
function pruneHistory(state, retentionDays = HISTORY_RETENTION_DAYS) {
  const dates = sortedHistoryDates(state.history);
  if (dates.length === 0) {
    return state;
  }

  const cutoff = shiftDate(dates[dates.length - 1], -retentionDays);
  const foldDates = dates.filter(date => date < cutoff);
  if (foldDates.length === 0) {
    return state;
  }

  const exemptDates = state.exemptDates || [];
  const exempt = new Set(exemptDates);

  let base = {
    streak: state.replayBase?.streak ?? 0,
    grace: state.replayBase?.grace ?? GRACE_INITIAL,
    bonus: 0,
    lastConfirmedDate: state.replayBase?.date ?? null
  };
  foldDates.forEach(date => {
    base = confirmDay(base, date, state.history[date], { exempt: exempt.has(date) }).state;
  });

  const history = {};
  dates.filter(date => date >= cutoff).forEach(date => {
    history[date] = state.history[date];
  });

  const folded = new Set(foldDates);
  return {
    ...state,
    history,
    exemptDates: exemptDates.filter(date => !folded.has(date)),
    replayBase: { streak: base.streak, grace: base.grace, date: base.lastConfirmedDate }
  };
}

/**
 * 現在の streak / grace をチェックポイントに畳み込み、学習履歴を空にする(純粋関数、入力は変更しない)
 *
 * streak / grace は学習履歴のリプレイから導出されるため、値を書き換えただけでは
 * 次回の確定でリプレイ結果に上書きされてしまう。手動変更を確定値として残すために使う。
 * この操作以降、畳み込んだ日より前の遡及免除はできなくなる(履歴が消えるため)。
 *
 * @param {object} state - ユーザーのストリーク状態
 * @returns {object} 新しい状態
 */
function collapseHistory(state) {
  return {
    ...state,
    history: {},
    replayBase: {
      streak: state.streak ?? 0,
      grace: state.grace ?? GRACE_INITIAL,
      date: state.lastConfirmedDate ?? null
    }
  };
}

/**
 * 月次清算: 全ユーザーのボーナスを0にした新しいマップと清算リストを返す(純粋関数)
 *
 * @param {object} streakUsers - userName → state のマップ
 * @returns {{streakUsers: object, settlements: Array<{userName: string, bonus: number, course: ('elementary'|'juniorHigh'|undefined)}>}}
 */
function settleBonuses(streakUsers) {
  const settled = {};
  const settlements = [];

  Object.entries(streakUsers).forEach(([userName, state]) => {
    // course は月次清算がポイント単価を決めるために使う(未設定は呼び出し側で小学生扱い)
    settlements.push({ userName, bonus: state.bonus ?? 0, course: state.course });
    settled[userName] = { ...state, bonus: 0 };
  });

  return { streakUsers: settled, settlements };
}

/**
 * 状態にコース種別を反映した新しい状態を返す(純粋関数)
 *
 * course は学習したかどうかと無関係にクロール結果から分かる情報なので、
 * 確定判定の成否によらず保存する。月次清算(src/monthly-bonus-index.js)が
 * ポイント単価を決めるために使う。course が未指定のときは状態をそのまま返す。
 *
 * @private
 * @param {object} state - ストリーク状態
 * @param {'elementary'|'juniorHigh'|undefined} course
 * @returns {object}
 */
function withCourse(state, course) {
  if (!course || state.course === course) {
    return state;
  }
  return { ...state, course };
}

/**
 * 全ユーザー分の確定判定を適用(純粋関数、入力は変更しない)
 *
 * @param {object} streakUsers - userName → state のマップ
 * @param {Array} users - 判定対象日のクロール済みユーザーデータ(v2.0形式、dataReliable省略時はtrue扱い。user.course があれば各ユーザー状態にも保存する)
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @param {object} [options] - isStudied に伝搬する判定オプション(minCompletedMissions等)
 * @returns {{streakUsers: object, results: Array<{userName: string, state: object, event: string}>}} streakUsers の各 state には course(user.course または既存値)が反映される
 */
function updateStreaks(streakUsers, users, dateString, options = {}) {
  const updated = { ...streakUsers };
  const results = [];

  users.forEach(user => {
    const current = updated[user.userName] || createInitialState();
    const studied = isStudied(user, options);

    // confirmDay() は全分岐で状態を新規に組み立て直すため course が落ちる。
    // course は連続日数の遷移と直交するメタデータなので confirmDay には持ち込まず、
    // 遷移の後段でここで付け直す。user.course 未指定時は既存値を引き継ぐ。
    const course = user.course || current.course;

    // dataReliable: false かつ未学習判定の場合、クロール部分失敗によるデフォルト値(0/[])
    // が原因の偽陰性である可能性があるため確定をスキップする(空白日の中立処理に委ねる)。
    // 学習した証跡がある場合(studied === true)は信頼して通常通り確定する。
    // 確定はしないが course だけは保存する(学習判定と無関係に分かる情報のため)。
    if (user.dataReliable === false && !studied) {
      const skipped = withCourse(current, course);
      updated[user.userName] = skipped;
      results.push({ userName: user.userName, state: skipped, event: 'none' });
      return;
    }

    const { state: confirmed, event } = confirmDayWithHistory(current, dateString, studied);
    const state = withCourse(confirmed, course);
    updated[user.userName] = state;
    results.push({ userName: user.userName, state, event });
  });

  return { streakUsers: updated, results };
}

/**
 * コースのしきい値(ストリーク成立に必要な完了数)を返す(純粋関数)
 * @param {'elementary'|'juniorHigh'|undefined} course
 * @returns {number}
 */
function getRequirementForCourse(course) {
  return course === 'juniorHigh'
    ? STREAK_REQUIREMENTS.juniorHighCourses
    : STREAK_REQUIREMENTS.elementaryMissions;
}

/**
 * コース別にしきい値を切り替えて確定判定を適用する(純粋関数、入力は変更しない)
 * user.course で elementary / juniorHigh に分割し、それぞれのしきい値で updateStreaks を連鎖適用する
 *
 * @param {object} streakUsers - userName → state のマップ
 * @param {Array} users - 判定対象日のクロール済みユーザーデータ(course フィールド付き)
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @returns {{streakUsers: object, results: Array<{userName: string, state: object, event: string}>}}
 */
function updateStreaksByCourse(streakUsers, users, dateString) {
  let current = streakUsers;
  const results = [];

  for (const course of ['elementary', 'juniorHigh']) {
    const courseUsers = users.filter(user => (user.course || 'elementary') === course);
    if (courseUsers.length === 0) continue;

    const threshold = getRequirementForCourse(course);
    const updateResult = updateStreaks(current, courseUsers, dateString, {
      minCompletedMissions: threshold
    });
    current = updateResult.streakUsers;
    results.push(...updateResult.results);
  }

  return { streakUsers: current, results };
}

/**
 * 通知メッセージ用のストリーク表示行を生成
 *
 * @param {{state: object, event: string}} result - updateStreaks の results 要素
 * @param {object} [options]
 * @param {boolean} [options.todayStudied] - 当日すでに学習済みなら暫定で+1表示(夜通知用)
 * @returns {string} 改行区切りの表示行
 */
function formatStreakInfo(result, options = {}) {
  const { state, event } = result;
  const displayStreak = state.streak + (options.todayStudied ? 1 : 0);
  const streakLabel = displayStreak > 0 ? `${displayStreak}日目` : '0日';
  const bonus = state.bonus ?? 0;

  let firstLine = `🔥 連続学習: ${streakLabel}  🛟 おたすけ: ${state.grace}/${GRACE_MAX}`;
  if (bonus > 0) {
    firstLine += `  💰 ボーナス: ${bonus}P`;
  }
  const lines = [firstLine];

  if (event === 'milestone') {
    lines.push(`🎉 ${state.streak}日連続達成!おたすけ+1(残り${state.grace})`);
  } else if (event === 'bonus') {
    lines.push(`💰 おたすけ満タンのためボーナス+1(合計${bonus}P)`);
  } else if (event === 'grace_used') {
    lines.push(`💤 昨日はおたすけを使って連続記録を守りました(残り${state.grace})`);
  } else if (event === 'reset') {
    lines.push('😢 連続記録がリセットされました。今日からまた頑張ろう!');
  } else if (event === 'exempt') {
    lines.push('😌 免除日のため記録はそのままです');
  }

  return lines.join('\n');
}

/**
 * ストリークデータを読み込む
 *
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function loadStreakData() {
  try {
    try {
      await fs.access(STREAK_FILE);
    } catch {
      // ファイルが存在しない場合(初回実行時)は空のマップを返す
      return { success: true, data: {} };
    }

    const fileContent = await fs.readFile(STREAK_FILE, 'utf-8');
    const jsonData = JSON.parse(fileContent);

    const version = jsonData.version || '1.0';
    if (!['1.0', '1.1', '1.2', '1.3', '1.4'].includes(version)) {
      return {
        success: false,
        error: `未知のストリークデータバージョン: ${version}`
      };
    }

    const users = jsonData.users || {};

    // 〜1.2 → 1.3 移行: 全ユーザーのおたすけを満タン(3)にする一度きりのチャージ。
    // (v1.2の初回チャージは小学生ユーザーがファイル未登録の時点で発火したため再適用。
    //  旧1.0→1.1移行もこの移行に包含される)
    // 1.3以降のデータには適用しない(再チャージしてしまうため)
    if (!['1.3', '1.4'].includes(version)) {
      Object.values(users).forEach(state => {
        state.grace = GRACE_MAX;
      });
    }

    // 〜1.3 → 1.4 移行: 免除日機能のフィールドを補う。
    // history は空から始まるため、移行より前の日は遡及免除できない(設計どおりの割り切り)
    if (version !== '1.4') {
      Object.values(users).forEach(state => {
        state.exemptDates = state.exemptDates || [];
        state.history = state.history || {};
        state.replayBase = state.replayBase || {
          streak: state.streak ?? 0,
          grace: state.grace ?? GRACE_INITIAL,
          date: state.lastConfirmedDate ?? null
        };
      });
    }

    return { success: true, data: users };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { success: false, error: `JSONパースエラー: ${error.message}` };
    }
    return { success: false, error: `ストリークデータ読み込みエラー: ${error.message}` };
  }
}

/**
 * ストリークデータを保存する
 *
 * @param {object} streakUsers - userName → state のマップ
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveStreakData(streakUsers) {
  try {
    if (typeof streakUsers !== 'object' || streakUsers === null || Array.isArray(streakUsers)) {
      return {
        success: false,
        error: '不正なデータ形式: オブジェクトである必要があります'
      };
    }

    await fs.mkdir(DATA_DIR, { recursive: true });

    const saveObject = {
      version: '1.4',
      timestamp: new Date().toISOString(),
      users: streakUsers
    };

    await fs.writeFile(STREAK_FILE, JSON.stringify(saveObject, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: `ストリークデータ保存エラー: ${error.message}` };
  }
}

module.exports = {
  createInitialState,
  isStudied,
  countCompletedMissions,
  countStudyItems,
  confirmDay,
  confirmDayWithHistory,
  shiftDate,
  replayStreak,
  pruneHistory,
  collapseHistory,
  HISTORY_RETENTION_DAYS,
  GRACE_INITIAL,
  STREAK_REQUIREMENTS,
  getRequirementForCourse,
  updateStreaks,
  updateStreaksByCourse,
  formatStreakInfo,
  settleBonuses,
  loadStreakData,
  saveStreakData
};
