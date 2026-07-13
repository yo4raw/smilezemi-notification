/**
 * ストリーク管理モジュールのテスト
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');

const {
  createInitialState,
  isStudied,
  confirmDay,
  updateStreaks,
  formatStreakInfo,
  loadStreakData,
  saveStreakData
} = require('../src/streak');

const DATA_DIR = path.join(__dirname, '../data');
const STREAK_FILE = path.join(DATA_DIR, 'streak_data.json');

describe('isStudied', () => {
  it('勉強時間もミッションもない場合は未学習', () => {
    assert.strictEqual(isStudied({ studyTime: { hours: 0, minutes: 0 }, missions: [] }), false);
  });

  it('勉強時間があれば学習済み', () => {
    assert.strictEqual(isStudied({ studyTime: { hours: 0, minutes: 5 }, missions: [] }), true);
  });

  it('ミッションがあれば学習済み', () => {
    assert.strictEqual(
      isStudied({ studyTime: { hours: 0, minutes: 0 }, missions: [{ name: '算数', score: 80, completed: true }] }),
      true
    );
  });

  it('studyTime / missions が欠けていても未学習として扱える', () => {
    assert.strictEqual(isStudied({}), false);
  });
});

describe('confirmDay', () => {
  it('学習した日はストリークが+1される', () => {
    const { state, event } = confirmDay(createInitialState(), '2026-07-12', true);
    assert.deepStrictEqual(state, { streak: 1, grace: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'none');
  });

  it('10日到達でおたすけ+1(milestone)', () => {
    const { state, event } = confirmDay(
      { streak: 9, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 10);
    assert.strictEqual(state.grace, 1);
    assert.strictEqual(event, 'milestone');
  });

  it('20日到達でもおたすけ+1', () => {
    const { state, event } = confirmDay(
      { streak: 19, grace: 1, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.grace, 2);
    assert.strictEqual(event, 'milestone');
  });

  it('おたすけは上限3を超えない(milestoneイベントも発生しない)', () => {
    const { state, event } = confirmDay(
      { streak: 39, grace: 3, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 40);
    assert.strictEqual(state.grace, 3);
    assert.strictEqual(event, 'none');
  });

  it('未学習でもおたすけがあれば消費してストリーク維持(+1されない)', () => {
    const { state, event } = confirmDay(
      { streak: 12, grace: 2, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.deepStrictEqual(state, { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'grace_used');
  });

  it('未学習でおたすけがなければストリークもおたすけも0にリセット', () => {
    const { state, event } = confirmDay(
      { streak: 12, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.deepStrictEqual(state, { streak: 0, grace: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'reset');
  });

  it('ストリーク0で未学習の場合はresetイベントを出さない', () => {
    const { state, event } = confirmDay(
      { streak: 0, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.strictEqual(state.streak, 0);
    assert.strictEqual(event, 'none');
  });

  it('判定済みの日付は再判定しない(冪等)', () => {
    const before = { streak: 5, grace: 1, lastConfirmedDate: '2026-07-12' };
    const { state, event } = confirmDay(before, '2026-07-12', true);
    assert.deepStrictEqual(state, before);
    assert.strictEqual(event, 'none');
  });

  it('過去の日付も再判定しない', () => {
    const before = { streak: 5, grace: 1, lastConfirmedDate: '2026-07-12' };
    const { state, event } = confirmDay(before, '2026-07-10', true);
    assert.deepStrictEqual(state, before);
    assert.strictEqual(event, 'none');
  });

  it('空白日(前回確定日から日が飛んでいる)は中立扱いで、対象日のみ判定される', () => {
    // 07-08 まで確定 → 07-09〜07-11 はCI障害等で未判定 → 07-12 を判定
    const { state } = confirmDay(
      { streak: 5, grace: 1, lastConfirmedDate: '2026-07-08' }, '2026-07-12', true
    );
    assert.deepStrictEqual(state, { streak: 6, grace: 1, lastConfirmedDate: '2026-07-12' });
  });
});

describe('loadStreakData / saveStreakData', () => {
  beforeEach(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.unlink(STREAK_FILE);
    } catch (e) {
      // ファイルなしは無視
    }
  });

  afterEach(async () => {
    try {
      await fs.unlink(STREAK_FILE);
    } catch (e) {
      // ファイルなしは無視
    }
  });

  it('ファイルが存在しない場合は空のマップを返す(初回実行)', async () => {
    const result = await loadStreakData();
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, {});
  });

  it('保存したデータを読み込める(ラウンドトリップ)', async () => {
    const users = {
      '光志郎 (中学生コース)': { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' }
    };
    const saveResult = await saveStreakData(users);
    assert.strictEqual(saveResult.success, true);

    const loadResult = await loadStreakData();
    assert.strictEqual(loadResult.success, true);
    assert.deepStrictEqual(loadResult.data, users);
  });

  it('保存ファイルに version と ISO 8601 timestamp が含まれる', async () => {
    await saveStreakData({});
    const content = JSON.parse(await fs.readFile(STREAK_FILE, 'utf-8'));
    assert.strictEqual(content.version, '1.0');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(content.timestamp));
  });

  it('不正なJSONの場合はエラーを返す', async () => {
    await fs.writeFile(STREAK_FILE, '{invalid json', 'utf-8');
    const result = await loadStreakData();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('JSONパースエラー'));
  });

  it('未知のバージョンはエラーを返す', async () => {
    await fs.writeFile(STREAK_FILE, JSON.stringify({ version: '9.9', users: {} }), 'utf-8');
    const result = await loadStreakData();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('未知のストリークデータバージョン'));
  });

  it('配列を渡すと保存エラーになる', async () => {
    const result = await saveStreakData([]);
    assert.strictEqual(result.success, false);
  });
});

describe('updateStreaks', () => {
  const studiedUser = {
    userName: '光志郎 (中学生コース)',
    studyTime: { hours: 0, minutes: 45 },
    missions: [{ name: '数学', score: 80, completed: true }]
  };
  const notStudiedUser = {
    userName: '祥吾 (小学生コース)',
    studyTime: { hours: 0, minutes: 0 },
    missions: []
  };

  it('複数ユーザーをそれぞれ独立に判定する', () => {
    const { streakUsers, results } = updateStreaks({}, [studiedUser, notStudiedUser], '2026-07-12');
    assert.strictEqual(streakUsers['光志郎 (中学生コース)'].streak, 1);
    assert.strictEqual(streakUsers['祥吾 (小学生コース)'].streak, 0);
    assert.strictEqual(results.length, 2);
  });

  it('既存の状態から更新される', () => {
    const initial = {
      '光志郎 (中学生コース)': { streak: 9, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    const { streakUsers, results } = updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.strictEqual(streakUsers['光志郎 (中学生コース)'].streak, 10);
    assert.strictEqual(results[0].event, 'milestone');
  });

  it('入力のマップを変更しない(純粋関数)', () => {
    const initial = {
      '光志郎 (中学生コース)': { streak: 5, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.strictEqual(initial['光志郎 (中学生コース)'].streak, 5);
  });

  it('クロール対象にいないユーザーの状態は変更されない', () => {
    const initial = {
      '別の子 (小学生コース)': { streak: 3, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    const { streakUsers } = updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.deepStrictEqual(
      streakUsers['別の子 (小学生コース)'],
      { streak: 3, grace: 0, lastConfirmedDate: '2026-07-11' }
    );
  });

  it('dataReliable:false かつ未学習の場合は確定をスキップし状態を維持する(誤リセット防止)', () => {
    const initial = {
      '光志郎 (中学生コース)': { streak: 5, grace: 1, lastConfirmedDate: '2026-07-11' }
    };
    const unreliableNotStudiedUser = {
      userName: '光志郎 (中学生コース)',
      studyTime: { hours: 0, minutes: 0 },
      missions: [],
      dataReliable: false
    };
    const { streakUsers, results } = updateStreaks(initial, [unreliableNotStudiedUser], '2026-07-12');

    assert.deepStrictEqual(streakUsers['光志郎 (中学生コース)'], initial['光志郎 (中学生コース)']);
    assert.strictEqual(results[0].event, 'none');
    assert.deepStrictEqual(results[0].state, initial['光志郎 (中学生コース)']);
  });

  it('dataReliable:false でも学習実績があれば通常通り確定する(正の証跡は信頼する)', () => {
    const unreliableStudiedUser = {
      userName: '光志郎 (中学生コース)',
      studyTime: { hours: 0, minutes: 30 },
      missions: [{ name: '数学', score: 80, completed: true }],
      dataReliable: false
    };
    const { streakUsers, results } = updateStreaks({}, [unreliableStudiedUser], '2026-07-12');

    assert.strictEqual(streakUsers['光志郎 (中学生コース)'].streak, 1);
    assert.strictEqual(streakUsers['光志郎 (中学生コース)'].lastConfirmedDate, '2026-07-12');
    assert.strictEqual(results[0].event, 'none');
  });

  it('dataReliable が未指定の場合は信頼できるものとして通常通り確定する(既存呼び出し互換)', () => {
    const { streakUsers } = updateStreaks({}, [notStudiedUser], '2026-07-12');

    assert.deepStrictEqual(
      streakUsers['祥吾 (小学生コース)'],
      { streak: 0, grace: 0, lastConfirmedDate: '2026-07-12' }
    );
  });
});

describe('formatStreakInfo', () => {
  it('基本表示(ストリークとおたすけ)', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'none'
    });
    assert.strictEqual(text, '🔥 連続学習: 12日目  🛟 おたすけ: 1/3');
  });

  it('todayStudied で暫定+1表示(夜通知用)', () => {
    const text = formatStreakInfo(
      { state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' }, event: 'none' },
      { todayStudied: true }
    );
    assert.ok(text.includes('13日目'));
  });

  it('ストリーク0のときは「0日」表示', () => {
    const text = formatStreakInfo({
      state: { streak: 0, grace: 0, lastConfirmedDate: null },
      event: 'none'
    });
    assert.ok(text.includes('🔥 連続学習: 0日'));
  });

  it('milestoneイベントでお祝い行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 10, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'milestone'
    });
    assert.ok(text.includes('🎉 10日連続達成!おたすけ+1(残り1)'));
  });

  it('grace_usedイベントでおたすけ使用行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'grace_used'
    });
    assert.ok(text.includes('💤 昨日はおたすけを使って連続記録を守りました(残り1)'));
  });

  it('resetイベントでリセット行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 0, grace: 0, lastConfirmedDate: '2026-07-12' },
      event: 'reset'
    });
    assert.ok(text.includes('😢 連続記録がリセットされました'));
  });
});
