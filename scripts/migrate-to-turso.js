#!/usr/bin/env node
/**
 * actions/cache に残っている data/*.json を Turso に投入する使い捨ての移行スクリプト。
 *
 * 本番の streak_data.json は actions/cache 内にのみ存在し、キャッシュには公開
 * ダウンロードAPIがないため、このスクリプトは .github/workflows/migrate-to-turso.yml
 * から実行する(キャッシュを復元した直後の data/ を読む)。
 *
 * 二重実行の事故を防ぐため、既に app_state に該当キーの行があれば上書きしない。
 * 上書きは --force を明示したときだけ。
 *
 * 移行が完了したらこのスクリプトとワークフローは削除する。
 *
 * 使い方:
 *   node scripts/migrate-to-turso.js [--force]
 */

const fs = require('fs').promises;
const path = require('path');

const { createSchema, readState, writeState } = require('../src/store');

const DATA_DIR = path.join(__dirname, '../data');

// ファイル名 → Turso上のキー
const TARGETS = [
  { file: 'streak_data.json', key: 'streak_data' },
  { file: 'mission_data.json', key: 'mission_data' }
];

/**
 * `--force` のようなフラグを素朴にパースする
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
 * ユーザー名を伏せる
 *
 * 公開リポジトリのワークフローログに実名を出さないため、末尾1文字だけ残す
 * (src/crawler.js の maskName と同じ方針)。
 *
 * @param {string} name
 * @returns {string}
 */
function maskUserName(name) {
  if (!name || name.length <= 1) {
    return name;
  }
  return '*'.repeat(name.length - 1) + name.slice(-1);
}

/**
 * 1ファイルを読む。存在しなければ null を返す
 * @private
 */
async function readLocalJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 移行を実行する
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] - 既存の行を上書きするか
 * @returns {Promise<{success: boolean, migrated: string[], skipped: string[], error?: string}>}
 */
async function migrate(options = {}) {
  const { force = false } = options;
  const migrated = [];
  const skipped = [];

  console.log('[migrate-to-turso] スキーマを作成しています...');
  const schemaResult = await createSchema();
  if (!schemaResult.success) {
    return { success: false, migrated, skipped, error: `スキーマ作成に失敗しました: ${schemaResult.error}` };
  }
  console.log('[migrate-to-turso] スキーマの作成が完了しました');

  for (const target of TARGETS) {
    const content = await readLocalJson(target.file);
    if (content === null) {
      console.warn(`[migrate-to-turso] ${target.file} が見つかりません(スキップ)`);
      skipped.push(target.key);
      continue;
    }

    const existing = await readState(target.key);
    if (!existing.success) {
      return { success: false, migrated, skipped, error: `${target.key} の既存確認に失敗しました: ${existing.error}` };
    }

    if (existing.state === 'ok' && !force) {
      console.warn(`[migrate-to-turso] ${target.key} は既に存在します。上書きするには --force を付けてください(スキップ)`);
      skipped.push(target.key);
      continue;
    }

    // ファイルは整形済みで保存されているため、パースし直して整形なしで書く
    let normalized;
    try {
      normalized = JSON.stringify(JSON.parse(content));
    } catch (error) {
      return { success: false, migrated, skipped, error: `${target.file} のJSONが壊れています: ${error.message}` };
    }

    const writeResult = await writeState(target.key, normalized);
    if (!writeResult.success) {
      return { success: false, migrated, skipped, error: `${target.key} の書き込みに失敗しました: ${writeResult.error}` };
    }

    console.log(`[migrate-to-turso] ${target.key} を投入しました (${normalized.length}文字)`);
    migrated.push(target.key);
  }

  return { success: true, migrated, skipped };
}

/**
 * 投入結果を読み戻して照合表示する(実名はマスクする)
 * @private
 */
async function verify() {
  console.log('[migrate-to-turso] 読み戻して照合します');

  const streakResult = await readState('streak_data');
  if (!streakResult.success || streakResult.state !== 'ok') {
    console.error(`[migrate-to-turso] streak_data を読み戻せませんでした (state=${streakResult.state ?? 'error'})`);
    return false;
  }

  const streakData = JSON.parse(streakResult.value);
  const users = streakData.users ?? {};
  const keys = Object.keys(users);
  console.log(`[migrate-to-turso] streak_data: version=${streakData.version} ユーザー${keys.length}件`);
  keys.forEach(key => {
    const state = users[key];
    console.log(
      `  - "${maskUserName(key)}": streak=${state.streak} grace=${state.grace} bonus=${state.bonus ?? 0}`
      + ` course=${state.course ?? '(未設定)'} lastConfirmedDate=${state.lastConfirmedDate ?? 'null'}`
      + ` 履歴${Object.keys(state.history ?? {}).length}日 免除${(state.exemptDates ?? []).length}日`
    );
  });

  const missionResult = await readState('mission_data');
  if (missionResult.success && missionResult.state === 'ok') {
    const missionData = JSON.parse(missionResult.value);
    console.log(`[migrate-to-turso] mission_data: version=${missionData.version} ユーザー${(missionData.users ?? []).length}件`);
  } else {
    console.warn('[migrate-to-turso] mission_data は未投入です(初回実行として扱われます)');
  }

  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const force = args.force === true;

  if (force) {
    console.warn('[migrate-to-turso] --force が指定されました。既存の値を上書きします');
  }

  const result = await migrate({ force });

  if (!result.success) {
    console.error(`[migrate-to-turso] 移行に失敗しました: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[migrate-to-turso] 投入: ${result.migrated.length > 0 ? result.migrated.join(', ') : '(なし)'}`);
  console.log(`[migrate-to-turso] スキップ: ${result.skipped.length > 0 ? result.skipped.join(', ') : '(なし)'}`);

  const verified = await verify();
  if (!verified) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  maskUserName,
  migrate
};
