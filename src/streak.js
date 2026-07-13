/**
 * ストリーク(連続学習日数)管理モジュール
 *
 * データ構造 (data/streak_data.json):
 * {
 *   version: "1.3",  // 1.3未満の読み込み時は全ユーザーのおたすけを3にする移行を適用(一度きり)
 *   timestamp: "ISO 8601",
 *   users: {
 *     "ユーザー名 (コース名)": {
 *       streak: number,                 // 確定済み連続学習日数
 *       grace: number,                  // おたすけ残数 (0〜3)
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
  elementaryMissions: 4,                        // 小学生コース: 完了ミッション数(夜通知が使用)
  juniorHighCourses: { weekday: 3, weekend: 5 } // 中学生コース: 完了講座数(朝通知が使用)。祝日は曜日のみで判定
};

/**
 * 中学生コースの必要講座数を判定対象日の曜日から返す(純粋関数)
 * 土曜・日曜は weekend、月〜金曜は weekday。祝日は考慮しない(意図的な割り切り)
 *
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD, JSTのカレンダー日付)
 * @returns {number} 必要講座数
 */
function getJuniorHighRequirement(dateString) {
  // YYYY-MM-DDをUTC深夜として解釈しgetUTCDay()で曜日を引くことで、実行環境のTZに依存しない
  const dayOfWeek = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  return isWeekend
    ? STREAK_REQUIREMENTS.juniorHighCourses.weekend
    : STREAK_REQUIREMENTS.juniorHighCourses.weekday;
}

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
 * その日に学習したかを判定(notifier.js の未学習判定と同一基準)
 *
 * minCompletedMissions を1以上指定した場合(小学生コースの5個ルール)は
 * 「完了ミッション数 >= 指定値」のみで判定し、勉強時間は見ない。
 *
 * @param {{studyTime?: {hours: number, minutes: number}, missionCount?: number, missions?: Array}} user - v2.0形式のユーザーデータ
 * @param {object} [options]
 * @param {number} [options.minCompletedMissions=0] - ストリークに必要な完了ミッション数
 * @returns {boolean}
 */
function isStudied(user, options = {}) {
  const { minCompletedMissions = 0 } = options;

  if (minCompletedMissions > 0) {
    return countCompletedMissions(user) >= minCompletedMissions;
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
 * @returns {{streakUsers: object, settlements: Array<{userName: string, bonus: number}>}}
 */
function settleBonuses(streakUsers) {
  const settled = {};
  const settlements = [];

  Object.entries(streakUsers).forEach(([userName, state]) => {
    settlements.push({ userName, bonus: state.bonus ?? 0 });
    settled[userName] = { ...state, bonus: 0 };
  });

  return { streakUsers: settled, settlements };
}

/**
 * 全ユーザー分の確定判定を適用(純粋関数、入力は変更しない)
 *
 * @param {object} streakUsers - userName → state のマップ
 * @param {Array} users - 判定対象日のクロール済みユーザーデータ(v2.0形式、dataReliable省略時はtrue扱い)
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @param {object} [options] - isStudied に伝搬する判定オプション(minCompletedMissions等)
 * @returns {{streakUsers: object, results: Array<{userName: string, state: object, event: string}>}}
 */
function updateStreaks(streakUsers, users, dateString, options = {}) {
  const updated = { ...streakUsers };
  const results = [];

  users.forEach(user => {
    const current = updated[user.userName] || createInitialState();
    const studied = isStudied(user, options);

    // dataReliable: false かつ未学習判定の場合、クロール部分失敗によるデフォルト値(0/[])
    // が原因の偽陰性である可能性があるため確定をスキップする(空白日の中立処理に委ねる)。
    // 学習した証跡がある場合(studied === true)は信頼して通常通り確定する。
    if (user.dataReliable === false && !studied) {
      results.push({ userName: user.userName, state: current, event: 'none' });
      return;
    }

    const { state, event } = confirmDay(current, dateString, studied);
    updated[user.userName] = state;
    results.push({ userName: user.userName, state, event });
  });

  return { streakUsers: updated, results };
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
    } catch (error) {
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
  confirmDay,
  STREAK_REQUIREMENTS,
  getJuniorHighRequirement,
  updateStreaks,
  formatStreakInfo,
  settleBonuses,
  loadStreakData,
  saveStreakData
};
