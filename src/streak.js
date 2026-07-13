/**
 * ストリーク(連続学習日数)管理モジュール
 *
 * データ構造 (data/streak_data.json):
 * {
 *   version: "1.0",
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

const GRACE_MAX = 3;
const MILESTONE_INTERVAL = 10;

/**
 * ストリーク状態の初期値を生成
 */
function createInitialState() {
  return { streak: 0, grace: 0, lastConfirmedDate: null };
}

/**
 * その日に学習したかを判定(notifier.js の未学習判定と同一基準)
 *
 * @param {{studyTime?: {hours: number, minutes: number}, missions?: Array}} user - v2.0形式のユーザーデータ
 * @returns {boolean}
 */
function isStudied(user) {
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

  if (studied) {
    const streak = state.streak + 1;
    const isMilestone = streak % MILESTONE_INTERVAL === 0 && state.grace < GRACE_MAX;
    return {
      state: {
        streak,
        grace: isMilestone ? state.grace + 1 : state.grace,
        lastConfirmedDate: dateString
      },
      event: isMilestone ? 'milestone' : 'none'
    };
  }

  if (state.grace > 0) {
    return {
      state: {
        streak: state.streak,
        grace: state.grace - 1,
        lastConfirmedDate: dateString
      },
      event: 'grace_used'
    };
  }

  return {
    state: { streak: 0, grace: 0, lastConfirmedDate: dateString },
    event: state.streak > 0 ? 'reset' : 'none'
  };
}

module.exports = {
  createInitialState,
  isStudied,
  confirmDay
};
