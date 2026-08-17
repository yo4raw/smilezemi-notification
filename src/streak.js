/**
 * ストリーク(連続学習日数)管理モジュール
 *
 * データ構造 (data/streak_data.json):
 * {
 *   version: "1.3",  // 1.3未満の読み込み時は全ユーザーのおたすけを3にする移行を適用(一度きり)
 *   timestamp: "ISO 8601",
 *   users: {
 *     "ユーザー名": {                    // クローラーの表示名。コース選択画面を経由した場合のみ "名前 (コース名)" になる
 *       streak: number,                 // 確定済み連続学習日数
 *       grace: number,                  // おたすけ残数 (0〜3)
 *       bonus: number,                  // ボーナスポイント (月次清算で0にリセット)
 *       course: string|undefined,       // 'elementary' | 'juniorHigh'。月次清算の単価判定に使う。未設定は elementary 扱い
 *       lastConfirmedDate: string|null  // 最後に確定判定した日 (YYYY-MM-DD, JST)
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

// ストリーク更新(カウント+1)に必要な完了数。変更時はここだけ書き換える
const STREAK_REQUIREMENTS = {
  elementaryMissions: 4, // 小学生コース: 完了ミッション数(夜通知が使用)
  juniorHighCourses: 3   // 中学生コース: 完了講座数(朝通知が使用)。曜日によらず一律
};

/**
 * ストリーク状態の初期値を生成
 */
function createInitialState() {
  return { streak: 0, grace: GRACE_INITIAL, bonus: 0, lastConfirmedDate: null };
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
 * @returns {{state: object, event: 'milestone'|'grace_used'|'reset'|'none'}}
 */
function confirmDay(state, dateString, studied) {
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

    const { state: confirmed, event } = confirmDay(current, dateString, studied);
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
    if (!['1.0', '1.1', '1.2', '1.3'].includes(version)) {
      return {
        success: false,
        error: `未知のストリークデータバージョン: ${version}`
      };
    }

    const users = jsonData.users || {};

    // 〜1.2 → 1.3 移行: 全ユーザーのおたすけを満タン(3)にする一度きりのチャージ。
    // (v1.2の初回チャージは小学生ユーザーがファイル未登録の時点で発火したため再適用。
    //  旧1.0→1.1移行もこの移行に包含される)
    // 次回保存で1.3になるため一度きりの適用(以降消費した分は再付与しない)
    if (version !== '1.3') {
      Object.values(users).forEach(state => {
        state.grace = GRACE_MAX;
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
      version: '1.3',
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
  STREAK_REQUIREMENTS,
  getRequirementForCourse,
  updateStreaks,
  updateStreaksByCourse,
  formatStreakInfo,
  settleBonuses,
  loadStreakData,
  saveStreakData
};
