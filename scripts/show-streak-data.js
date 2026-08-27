#!/usr/bin/env node
/**
 * ストリークデータの現在値を読み取り専用で表示する運用スクリプト。
 *
 * 手動変更(set-streak-field.js)の前に、正確なユーザーキーと現在の
 * grace / streak / bonus / course を確認するために使う。データは書き換えない。
 * ユーザーキーはクローラーの表示名で、コース選択画面を経由しないユーザーは
 * コース名が付かない素の名前になる(本番は全員この形式)。
 * 免除日(おやすみ)の登録前に、対象日が学習履歴に残っているかを確認するためにも使う。
 *
 * 使い方:
 *   node scripts/show-streak-data.js
 */

const { loadStreakData } = require('../src/streak');

async function main() {
  const result = await loadStreakData();
  if (!result.success) {
    console.error(`[show-streak-data] 読み込みエラー: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  const users = result.data;
  const keys = Object.keys(users);

  if (keys.length === 0) {
    console.log('[show-streak-data] 登録済みユーザーは0件です(テーブルはあるがまだデータがありません。初回実行前の可能性があります)');
    return;
  }

  console.log(`[show-streak-data] 登録済みユーザー: ${keys.length}件`);
  keys.forEach(key => {
    const s = users[key];
    console.log(
      `  - "${key}": streak=${s.streak} grace=${s.grace} bonus=${s.bonus ?? 0} course=${s.course ?? '(未設定)'} lastConfirmedDate=${s.lastConfirmedDate ?? 'null'}`
    );

    const exemptDates = s.exemptDates ?? [];
    console.log(`      免除日: ${exemptDates.length > 0 ? exemptDates.join(', ') : '(なし)'}`);

    // 直近7日ぶんの履歴。免除日の登録可否(履歴の範囲内か)を判断するために出す
    const recent = Object.keys(s.history ?? {}).sort().slice(-7);
    const summary = recent.map(date => `${date}=${s.history[date] ? '学習' : '未学習'}`).join(' ');
    console.log(`      直近の履歴: ${recent.length > 0 ? summary : '(なし)'}`);
  });
}

main();
