#!/usr/bin/env node
/**
 * ストリークデータの現在値を読み取り専用で表示する運用スクリプト。
 *
 * 手動変更(set-streak-field.js)の前に、正確なユーザーキー "名前 (コース名)" と
 * 現在の grace / streak / bonus を確認するために使う。データは書き換えない。
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
    console.log('[show-streak-data] 登録済みユーザーは0件です(キャッシュ未復元またはデータ未生成の可能性)');
    return;
  }

  console.log(`[show-streak-data] 登録済みユーザー: ${keys.length}件`);
  keys.forEach(key => {
    const s = users[key];
    console.log(
      `  - "${key}": streak=${s.streak} grace=${s.grace} bonus=${s.bonus ?? 0} lastConfirmedDate=${s.lastConfirmedDate ?? 'null'}`
    );
  });
}

main();
