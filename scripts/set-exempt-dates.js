#!/usr/bin/env node
/**
 * 学習免除日(おやすみ)を登録・取り消しする運用スクリプト。
 *
 * 免除日は「未学習でもストリークをリセットせず、おたすけも消費しない日」。
 * 未来日付(旅行の予定)にも過去日付(体調不良に翌日以降に気づいた)にも登録できる。
 * 過去日付を登録すると、その日の確定判定を学習履歴のリプレイで巻き戻して修復する。
 *
 * 誤操作を防ぐため、検証はすべてここに集約する:
 *   - --user と --all はどちらか一方が必須(--user は既存キーのみ)
 *   - 日付は YYYY-MM-DD 形式。--to 省略時は --from と同じ日
 *   - 開始日 <= 終了日。一度に指定できるのは31日まで
 *   - 過去日付が学習履歴の範囲外(replayBase より前)なら修復できないため中断する
 *
 * 形式・バージョン(1.4)の整合は src/streak.js の load/save を再利用して担保する。
 *
 * 使い方:
 *   node scripts/set-exempt-dates.js --user "たろう" --from 2026-08-20 --to 2026-08-22 --action add
 *   node scripts/set-exempt-dates.js --all --from 2026-08-20 --action remove [--dry-run]
 */

const { loadStreakData, saveStreakData, replayStreak, shiftDate } = require('../src/streak');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31; // 打ち間違いで大量の免除日を作らないための上限
const ACTIONS = ['add', 'remove'];

/**
 * `--key value` 形式の引数を素朴にパースする(値なしフラグは true)。
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * カレンダー上存在する日付かを検証する。存在しなければ例外を投げる。
 *
 * shiftDate は内部で Date に通すため、2026-09-31 のような日付は 2026-10-01 に
 * 正規化されて戻る。往復して一致しなければ実在しない日付と判定できる。
 *
 * @param {string} label - エラーメッセージ用のフラグ名(from / to)
 * @param {string} value - YYYY-MM-DD
 */
function assertCalendarDate(label, value) {
  let normalized;
  try {
    normalized = shiftDate(value, 0);
  } catch {
    normalized = null;
  }
  if (normalized !== value) {
    throw new Error(`--${label} は実在する日付を指定してください(指定値: ${value})`);
  }
}

/**
 * 入力を検証し、正常なら {user, all, from, to, action, dryRun} を返す。
 * 不正なら message 付きで例外を投げる(呼び出し側で終了コード1にする)。
 */
function validateInput(args) {
  const all = args.all === true;
  const user = typeof args.user === 'string' && args.user.trim() !== '' ? args.user : null;
  const dryRun = args['dry-run'] === true;

  if ((user && all) || (!user && !all)) {
    throw new Error('--user と --all はどちらか一方を指定してください');
  }

  const { from, action } = args;
  const to = args.to === undefined ? from : args.to;

  if (typeof from !== 'string' || !DATE_PATTERN.test(from)) {
    throw new Error(`--from は YYYY-MM-DD 形式で指定してください(指定値: ${from})`);
  }
  assertCalendarDate('from', from);
  if (typeof to !== 'string' || !DATE_PATTERN.test(to)) {
    throw new Error(`--to は YYYY-MM-DD 形式で指定してください(指定値: ${to})`);
  }
  assertCalendarDate('to', to);
  if (from > to) {
    throw new Error(`開始日は終了日以前にしてください(--from ${from} / --to ${to})`);
  }
  if (expandDateRange(from, to).length > MAX_RANGE_DAYS) {
    throw new Error(`一度に指定できるのは${MAX_RANGE_DAYS}日までです(--from ${from} / --to ${to})`);
  }
  if (!ACTIONS.includes(action)) {
    throw new Error(`--action は ${ACTIONS.join(' / ')} のいずれかを指定してください(指定値: ${action})`);
  }

  return { user, all, from, to, action, dryRun };
}

/**
 * 開始日から終了日までの日付を昇順で列挙する(純粋関数)
 *
 * @param {string} from - YYYY-MM-DD
 * @param {string} to - YYYY-MM-DD
 * @returns {string[]}
 */
function expandDateRange(from, to) {
  const dates = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    cursor = shiftDate(cursor, 1);
  }
  return dates;
}

/**
 * 免除日を増減してリプレイした新しい状態を返す(純粋関数、入力は変更しない)
 *
 * @param {object} state - ユーザーのストリーク状態
 * @param {string[]} dates - 対象日
 * @param {'add'|'remove'} action
 * @returns {{state: object, added: string[], removed: string[], before: {streak: number, grace: number}, after: {streak: number, grace: number}}}
 */
function applyExemptChange(state, dates, action) {
  const current = state.exemptDates || [];
  const currentSet = new Set(current);
  const targetSet = new Set(dates);

  const added = action === 'add' ? dates.filter(date => !currentSet.has(date)) : [];
  const removed = action === 'remove' ? current.filter(date => targetSet.has(date)) : [];

  const exemptDates = action === 'add'
    ? [...current, ...added].sort()
    : current.filter(date => !targetSet.has(date));

  const replayed = replayStreak(state.replayBase, state.history, exemptDates);

  return {
    state: {
      ...state,
      exemptDates,
      streak: replayed.streak,
      grace: replayed.grace,
      lastConfirmedDate: replayed.lastConfirmedDate
    },
    added,
    removed,
    before: { streak: state.streak, grace: state.grace },
    after: { streak: replayed.streak, grace: replayed.grace }
  };
}

/**
 * 対象日が学習履歴で修復できる範囲かを検証する。
 * 未来日付や、まだ確定していない日は履歴に無いのが当然なので、
 * チェックポイント(replayBase.date)以前の日だけを対象にする。
 *
 * @param {object} state
 * @param {string[]} dates
 * @returns {string[]} 修復できない日の配列
 */
function findUnrepairableDates(state, dates) {
  const baseDate = state.replayBase?.date;
  if (!baseDate) return [];
  return dates.filter(date => date <= baseDate);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let input;
  try {
    input = validateInput(args);
  } catch (error) {
    console.error(`[set-exempt-dates] 入力エラー: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { user, all, from, to, action, dryRun } = input;
  const dates = expandDateRange(from, to);

  const loadResult = await loadStreakData();
  if (!loadResult.success) {
    console.error(`[set-exempt-dates] 読み込みエラー: ${loadResult.error}`);
    process.exitCode = 1;
    return;
  }
  const users = loadResult.data;

  const targets = all ? Object.keys(users) : [user];

  if (targets.length === 0) {
    console.error('[set-exempt-dates] 登録済みユーザーは0件です(キャッシュ未復元またはデータ未生成の可能性)');
    process.exitCode = 1;
    return;
  }

  if (!all && !Object.prototype.hasOwnProperty.call(users, user)) {
    console.error(`[set-exempt-dates] 対象ユーザーが見つかりません: "${user}"`);
    console.error('[set-exempt-dates] 登録済みユーザー:');
    Object.keys(users).forEach(key => console.error(`  - "${key}"`));
    process.exitCode = 1;
    return;
  }

  console.log(`[set-exempt-dates] 対象: ${all ? '全員' : `"${user}"`}  期間: ${from}〜${to} (${dates.length}日)  操作: ${action}`);

  // 修復できない過去日が1人でもいれば、部分適用を避けるため何も変更せず中断する
  if (action === 'add') {
    const blocked = targets
      .map(key => ({ key, dates: findUnrepairableDates(users[key], dates) }))
      .filter(entry => entry.dates.length > 0);

    if (blocked.length > 0) {
      blocked.forEach(entry => {
        console.error(`[set-exempt-dates] "${entry.key}" は学習履歴の範囲外のため修復できません: ${entry.dates.join(', ')}`);
      });
      console.error('[set-exempt-dates] 履歴に残っていない古い日です。smilezemi-set-streak / smilezemi-set-grace スキルで手動調整してください');
      process.exitCode = 1;
      return;
    }
  }

  targets.forEach(key => {
    const result = applyExemptChange(users[key], dates, action);
    users[key] = result.state;

    const changed = action === 'add' ? result.added : result.removed;
    console.log(`[set-exempt-dates] "${key}": ${action === 'add' ? '追加' : '取り消し'} ${changed.length}件${changed.length > 0 ? ` (${changed.join(', ')})` : ''}`);
    console.log(`[set-exempt-dates]   変更前: streak=${result.before.streak} grace=${result.before.grace}`);
    console.log(`[set-exempt-dates]   変更後: streak=${result.after.streak} grace=${result.after.grace}`);
    console.log(`[set-exempt-dates]   免除日: ${result.state.exemptDates.length > 0 ? result.state.exemptDates.join(', ') : '(なし)'}`);
  });

  if (dryRun) {
    console.log('[set-exempt-dates] DRY_RUN のため保存しません');
    return;
  }

  const saveResult = await saveStreakData(users);
  if (!saveResult.success) {
    console.error(`[set-exempt-dates] 保存エラー: ${saveResult.error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[set-exempt-dates] 保存しました');
}

// テストから純粋関数を読み込めるよう、直接実行されたときだけ main を走らせる
if (require.main === module) {
  main();
}

module.exports = { parseArgs, validateInput, expandDateRange, applyExemptChange, findUnrepairableDates, assertCalendarDate };
