/**
 * データ管理モジュールのテスト
 * Requirements: 3.6, 3.9, 4.6, 4.7
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

// src/data.js はトップレベルで store を require しているため、
// require.cache にモックを注入してからモジュールをロードする
// (tests/index.test.js と同じ方式)。
function resolveModule(p) {
  return require.resolve(p);
}

const MODULE_PATHS = ['../src/data', '../src/store'];

// sanitizeParseError は実装を差し替える意図がないため、モックにも本物を通す
// (差し替えるとJSONパースエラーのマスキングを検証できなくなる)
const { sanitizeParseError } = require('../src/store');

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    try { delete require.cache[resolveModule(p)]; } catch {}
  }
}

/**
 * storeをモックしてsrc/data.jsをロードする
 *
 * @param {object} overrides - readState / writeState の差し替え
 * @returns {{dataModule: object, writes: Array<{key: string, value: string}>}}
 */
function loadDataWithStore(overrides = {}) {
  clearModuleCache();
  const writes = [];

  require.cache[resolveModule('../src/store')] = {
    id: resolveModule('../src/store'),
    filename: resolveModule('../src/store'),
    loaded: true,
    exports: {
      readState: overrides.readState || (async () => ({ success: true, state: 'empty', value: null })),
      writeState: overrides.writeState || (async (key, value) => {
        writes.push({ key, value });
        return { success: true };
      }),
      resolveEndpoint: () => 'https://test-db.turso.io/v2/pipeline',
      createSchema: async () => ({ success: true }),
      sanitizeParseError
    }
  };

  return { dataModule: require('../src/data'), writes };
}

describe('データ管理モジュール - Turso永続化', () => {
  afterEach(() => {
    clearModuleCache();
  });

  it('state=empty なら空配列を返す(初回実行)', async () => {
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'empty', value: null })
    });

    const result = await dataModule.loadPreviousData();

    assert.deepStrictEqual(result, { success: true, data: [] });
  });

  it('state=uninitialized なら uninitialized フラグ付きで失敗を返す(移行前)', async () => {
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'uninitialized', value: null })
    });

    const result = await dataModule.loadPreviousData();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.uninitialized, true);
    assert.match(result.error, /未初期化/);
  });

  it('mission_data キーで読み出す', async () => {
    const readKeys = [];
    const { dataModule } = loadDataWithStore({
      readState: async (key) => {
        readKeys.push(key);
        return { success: true, state: 'empty', value: null };
      }
    });

    await dataModule.loadPreviousData();

    assert.deepStrictEqual(readKeys, ['mission_data']);
  });

  it('v2.0のJSONを読み出してusersを返す', async () => {
    const stored = JSON.stringify({
      version: '2.0',
      timestamp: '2026-08-27T00:00:00.000Z',
      users: [{ userName: 'たろう', missionCount: 4, date: '2026-08-26', studyTime: { hours: 0, minutes: 30 }, totalScore: 300, missions: [] }]
    });
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await dataModule.loadPreviousData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].userName, 'たろう');
  });

  it('users が空配列のJSONも空配列として読み出す', async () => {
    const stored = JSON.stringify({ version: '2.0', timestamp: '2026-08-27T00:00:00.000Z', users: [] });
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await dataModule.loadPreviousData();

    assert.deepStrictEqual(result, { success: true, data: [] });
  });

  it('v1.0のJSONは自動マイグレーションしてv2.0形式のusersを返す', async () => {
    // v1.0形式には studyTime / totalScore / missions が存在しない。
    // migrateDataV1toV2 (src/data.js) がこれらを補って初期値を埋める経路を検証する。
    const stored = JSON.stringify({
      version: '1.0',
      timestamp: '2025-12-24T09:00:00.000Z',
      users: [{ userName: 'たろう', missionCount: 5, date: '2025-12-24' }]
    });
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await dataModule.loadPreviousData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].userName, 'たろう');
    assert.strictEqual(result.data[0].missionCount, 5);
    // migrateDataV1toV2 が補う3フィールド
    assert.deepStrictEqual(result.data[0].studyTime, { hours: 0, minutes: 0 });
    assert.strictEqual(result.data[0].totalScore, 0);
    assert.deepStrictEqual(result.data[0].missions, []);
  });

  it('v1.0でusersが空配列の場合も空配列を返す', async () => {
    const stored = JSON.stringify({
      version: '1.0',
      timestamp: '2025-12-24T09:00:00.000Z',
      users: []
    });
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await dataModule.loadPreviousData();

    assert.deepStrictEqual(result, { success: true, data: [] });
  });

  it('壊れたJSONはパースエラーとして返す', async () => {
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'ok', value: '{ broken' })
    });

    const result = await dataModule.loadPreviousData();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /JSONパースエラー/);
  });

  it('読み出しの失敗はそのままエラーとして返す', async () => {
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: false, error: 'タイムアウト: Turso が10000ms以内に応答しませんでした' })
    });

    const result = await dataModule.loadPreviousData();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /タイムアウト/);
  });

  it('saveDataはmission_dataキーに整形なしJSONを書く', async () => {
    const { dataModule, writes } = loadDataWithStore();

    const result = await dataModule.saveData([{ userName: 'はなこ', missionCount: 4 }]);

    assert.deepStrictEqual(result, { success: true });
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].key, 'mission_data');
    assert.ok(!writes[0].value.includes('\n'), '整形せず1行で保存すること');

    const saved = JSON.parse(writes[0].value);
    assert.strictEqual(saved.version, '2.0');
    assert.strictEqual(saved.users[0].userName, 'はなこ');
    assert.match(saved.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('saveDataは配列以外を拒否する', async () => {
    const { dataModule, writes } = loadDataWithStore();

    const result = await dataModule.saveData({ notAnArray: true });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /配列/);
    assert.strictEqual(writes.length, 0, '検証に失敗したら書き込まないこと');
  });

  it('書き込みの失敗はエラーとして返す', async () => {
    const { dataModule } = loadDataWithStore({
      writeState: async () => ({ success: false, error: 'SQL エラー: no such table: app_state' })
    });

    const result = await dataModule.saveData([]);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /no such table/);
  });

  it('空配列も保存できる', async () => {
    const { dataModule, writes } = loadDataWithStore();

    const result = await dataModule.saveData([]);

    assert.deepStrictEqual(result, { success: true });
    assert.deepStrictEqual(JSON.parse(writes[0].value).users, []);
  });
});

describe('データ管理モジュール (src/data.js)', () => {
  const data = require('../src/data');

  describe('compareData() - 新旧データ比較', () => {
    it('正常系: ミッション数が増加したユーザーを検出する', () => {
      const previousData = [
        { userName: '太郎', missionCount: 5, date: '2025-12-24' }
      ];
      const currentData = [
        { userName: '太郎', missionCount: 8, date: '2025-12-25' }
      ];

      const result = data.compareData(previousData, currentData);

      assert.strictEqual(result.success, true, 'データ比較が成功すること');
      assert.strictEqual(Array.isArray(result.changes), true, 'changesが配列であること');
      assert.strictEqual(result.changes.length, 1, '変更が1件検出されること');
      assert.strictEqual(result.changes[0].userName, '太郎', 'ユーザー名が正しいこと');
      assert.strictEqual(result.changes[0].previousCount, 5, '前回値が正しいこと');
      assert.strictEqual(result.changes[0].currentCount, 8, '現在値が正しいこと');
      assert.strictEqual(result.changes[0].diff, 3, '差分が正しいこと');
      assert.strictEqual(result.changes[0].type, 'increase', '変更タイプが正しいこと');
    });

    it('正常系: ミッション数が減少したユーザーを検出する', () => {
      const previousData = [
        { userName: '花子', missionCount: 10, date: '2025-12-24' }
      ];
      const currentData = [
        { userName: '花子', missionCount: 7, date: '2025-12-25' }
      ];

      const result = data.compareData(previousData, currentData);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].diff, -3, '負の差分が計算されること');
      assert.strictEqual(result.changes[0].type, 'decrease', '減少タイプが検出されること');
    });

    it('正常系: 変更がないユーザーは含まれない', () => {
      const previousData = [
        { userName: '太郎', missionCount: 5, date: '2025-12-24' },
        { userName: '花子', missionCount: 3, date: '2025-12-24' }
      ];
      const currentData = [
        { userName: '太郎', missionCount: 5, date: '2025-12-25' },
        { userName: '花子', missionCount: 3, date: '2025-12-25' }
      ];

      const result = data.compareData(previousData, currentData);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.changes.length, 0, '変更なしの場合、空配列を返すこと');
    });

    it('正常系: 新規ユーザーを検出する', () => {
      const previousData = [
        { userName: '太郎', missionCount: 5, date: '2025-12-24' }
      ];
      const currentData = [
        { userName: '太郎', missionCount: 5, date: '2025-12-25' },
        { userName: '次郎', missionCount: 2, date: '2025-12-25' }
      ];

      const result = data.compareData(previousData, currentData);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.changes.length, 1, '新規ユーザーが検出されること');
      assert.strictEqual(result.changes[0].userName, '次郎');
      assert.strictEqual(result.changes[0].previousCount, 0, '前回値が0であること');
      assert.strictEqual(result.changes[0].currentCount, 2);
      assert.strictEqual(result.changes[0].type, 'new', '新規タイプが検出されること');
    });

    it('正常系: 複数ユーザーの変更を検出する', () => {
      const previousData = [
        { userName: '太郎', missionCount: 5, date: '2025-12-24' },
        { userName: '花子', missionCount: 3, date: '2025-12-24' }
      ];
      const currentData = [
        { userName: '太郎', missionCount: 8, date: '2025-12-25' },
        { userName: '花子', missionCount: 2, date: '2025-12-25' }
      ];

      const result = data.compareData(previousData, currentData);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.changes.length, 2, '2件の変更が検出されること');
    });

    it('正常系: 前回データが空配列の場合、全て新規として扱う', () => {
      const previousData = [];
      const currentData = [
        { userName: '太郎', missionCount: 5, date: '2025-12-25' }
      ];

      const result = data.compareData(previousData, currentData);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].type, 'new');
    });

    it('studyItemCount の増加を検出する', () => {
      const previous = [{ userName: 'たろう', studyItemCount: 3, missionCount: 3 }];
      const current = [{ userName: 'たろう', studyItemCount: 5, missionCount: 3 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].type, 'increase');
      assert.strictEqual(result.changes[0].previousCount, 3);
      assert.strictEqual(result.changes[0].currentCount, 5);
      assert.strictEqual(result.changes[0].diff, 2);
    });

    it('自主学習だけ増えた日も差分として検出する', () => {
      const previous = [{ userName: 'たろう', studyItemCount: 4, missionCount: 4 }];
      const current = [{ userName: 'たろう', studyItemCount: 6, missionCount: 4 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].diff, 2);
    });

    it('studyItemCount のない旧データは missionCount で比較する', () => {
      const previous = [{ userName: 'たろう', missionCount: 2 }];
      const current = [{ userName: 'たろう', missionCount: 4 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].diff, 2);
    });

    it('studyItemCount が 0 のとき missionCount にフォールバックしない', () => {
      const previous = [{ userName: 'たろう', studyItemCount: 3, missionCount: 3 }];
      const current = [{ userName: 'たろう', studyItemCount: 0, missionCount: 3 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].type, 'decrease');
      assert.strictEqual(result.changes[0].currentCount, 0);
    });

    it('前回が studyItemCount: 0 でも新規ユーザーと誤判定しない', () => {
      const previous = [{ userName: 'たろう', studyItemCount: 0, missionCount: 0 }];
      const current = [{ userName: 'たろう', studyItemCount: 2, missionCount: 2 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].type, 'increase');
      assert.strictEqual(result.changes[0].previousCount, 0);
      assert.strictEqual(result.changes[0].diff, 2);
    });
  });

});
