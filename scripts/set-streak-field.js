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
 * 形式・バージョン(1.4)の整合は src/streak.js の load/save を再利用して担保する。
 *
 * --user に渡すユーザーキーはクローラーの表示名で、コース選択画面を経由しないユーザーは
 * コース名が付かない素の名前になる(本番は全員この形式)。
 *
 * 使い方:
 *   node scripts/set-streak-field.js --user "たろう" --field grace --value 3 [--dry-run]
 */

const { parseArgs } = require('node:util');
const { loadStreakData, saveStreakData, collapseHistory } = require('../src/streak');

// フィールドごとの制約。変更時はここだけ書き換える
const FIELD_CONSTRAINTS = {
  grace: { min: 0, max: 3, label: 'おたすけ' },
  streak: { min: 0, max: null, label: '連続学習日数' },
  bonus: { min: 0, max: null, label: 'ボーナスポイント' }
};

/**
 * 入力を検証し、正常なら {user, field, value, dryRun} を返す。
 * 不正なら message 付きで例外を投げる(呼び出し側で終了コード1にする)。
 */
function validateInput(args) {
  const { user, field, value } = args;
  const dryRun = args['dry-run'] === true;

  if (typeof user !== 'string' || user.trim() === '') {
    throw new Error('--user は必須です(例: --user "たろう")');
  }

  if (!Object.hasOwn(FIELD_CONSTRAINTS, field)) {
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
  let input;
  try {
    const { values } = parseArgs({
      options: {
        user: { type: 'string' },
        field: { type: 'string' },
        value: { type: 'string' },
        'dry-run': { type: 'boolean' }
      }
    });
    input = validateInput(values);
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
  if (!Object.hasOwn(users, user)) {
    const known = Object.keys(users);
    console.error(`[set-streak-field] 対象ユーザーが見つかりません: "${user}"`);
    if (known.length > 0) {
      console.error('[set-streak-field] 登録済みユーザー:');
      known.forEach(key => console.error(`  - "${key}"`));
    } else {
      console.error('[set-streak-field] 登録済みユーザーは0件です(テーブルはあるがまだデータがありません。初回実行前の可能性があります)');
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

  // streak / grace は学習履歴のリプレイから導出されるため、値を書き換えただけでは
  // 次回の確定で上書きされてしまう。チェックポイントに畳み込んで確定させる。
  // bonus はリプレイ対象外なので畳み込み不要。
  if (field === 'streak' || field === 'grace') {
    users[user] = collapseHistory(users[user]);
    console.log('[set-streak-field] 手動変更のため学習履歴を畳み込みました(この日以前の遡及免除はできなくなります)');
  }

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
