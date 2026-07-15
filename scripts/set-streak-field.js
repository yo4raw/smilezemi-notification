#!/usr/bin/env node
/**
 * ストリークデータの1ユーザーの1フィールドを絶対値で設定する運用スクリプト。
 *
 * おたすけ(grace)・連続日数(streak)・ボーナス(bonus)を手動調整するための共通土台。
 * 誤操作を防ぐため、検証はすべてここに集約する:
 *   - 変更できるフィールドは grace / streak / bonus のみ
 *   - 対象ユーザーは既存キーのみ(未知キーはエラー。タイプミスで幽霊ユーザーを作らない)
 *   - 範囲検証: grace は 0〜3、streak / bonus は 0 以上の整数
 *   - 変更前→後を必ず表示し、--dry-run では保存しない
 *
 * 形式・バージョン(1.3)の整合は src/streak.js の load/save を再利用して担保する。
 *
 * 使い方:
 *   node scripts/set-streak-field.js --user "名前 (コース名)" --field grace --value 3 [--dry-run]
 */

const { loadStreakData, saveStreakData } = require('../src/streak');

// フィールドごとの制約。変更時はここだけ書き換える
const FIELD_CONSTRAINTS = {
  grace: { min: 0, max: 3, label: 'おたすけ' },
  streak: { min: 0, max: null, label: '連続学習日数' },
  bonus: { min: 0, max: null, label: 'ボーナスポイント' }
};

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
 * 入力を検証し、正常なら {user, field, value, dryRun} を返す。
 * 不正なら message 付きで例外を投げる(呼び出し側で終了コード1にする)。
 */
function validateInput(args) {
  const { user, field, value } = args;
  const dryRun = args['dry-run'] === true;

  if (typeof user !== 'string' || user.trim() === '') {
    throw new Error('--user は必須です(例: --user "たろう (小学生コース)")');
  }

  if (!Object.prototype.hasOwnProperty.call(FIELD_CONSTRAINTS, field)) {
    throw new Error(
      `--field は ${Object.keys(FIELD_CONSTRAINTS).join(' / ')} のいずれかを指定してください(指定値: ${field})`
    );
  }

  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`--value は整数で指定してください(指定値: ${value})`);
  }
  const numValue = Number(value);
  const { min, max } = FIELD_CONSTRAINTS[field];
  if (numValue < min || (max !== null && numValue > max)) {
    const range = max === null ? `${min} 以上` : `${min}〜${max}`;
    throw new Error(`${field} は ${range} の範囲で指定してください(指定値: ${numValue})`);
  }

  return { user, field, value: numValue, dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let input;
  try {
    input = validateInput(args);
  } catch (error) {
    console.error(`[set-streak-field] 入力エラー: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { user, field, value, dryRun } = input;

  const loadResult = await loadStreakData();
  if (!loadResult.success) {
    console.error(`[set-streak-field] 読み込みエラー: ${loadResult.error}`);
    process.exitCode = 1;
    return;
  }
  const users = loadResult.data;

  // 既存ユーザーのみ変更可。未知キーは候補を提示して中断する
  if (!Object.prototype.hasOwnProperty.call(users, user)) {
    const known = Object.keys(users);
    console.error(`[set-streak-field] 対象ユーザーが見つかりません: "${user}"`);
    if (known.length > 0) {
      console.error('[set-streak-field] 登録済みユーザー:');
      known.forEach(key => console.error(`  - "${key}"`));
    } else {
      console.error('[set-streak-field] 登録済みユーザーは0件です(キャッシュ未復元またはデータ未生成の可能性)');
    }
    process.exitCode = 1;
    return;
  }

  const state = users[user];
  const before = state[field];

  console.log(`[set-streak-field] 対象: "${user}"  フィールド: ${field} (${FIELD_CONSTRAINTS[field].label})`);
  console.log(`[set-streak-field] 変更前: ${field}=${before}`);

  if (before === value) {
    console.log(`[set-streak-field] 変更なし: 既に ${field}=${value} です`);
    return;
  }

  state[field] = value;
  console.log(`[set-streak-field] 変更後: ${field}=${value}`);

  if (dryRun) {
    console.log('[set-streak-field] DRY_RUN のため保存しません');
    return;
  }

  const saveResult = await saveStreakData(users);
  if (!saveResult.success) {
    console.error(`[set-streak-field] 保存エラー: ${saveResult.error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[set-streak-field] 保存しました');
}

main();
