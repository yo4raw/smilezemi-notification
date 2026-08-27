/**
 * Turso移行スクリプトのテスト
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const nodeFs = require('node:fs');
const path = require('node:path');

const {
  parseArgs,
  resolveForce,
  maskUserName,
  describeSchemaFailure,
  describePostSchemaFailure,
  buildFailureAdvice,
  compareRoundTrip,
  formatUserSummaryLine,
  hasStreakData
} = require('../scripts/migrate-to-turso');

// sanitizeParseError は src/store.js に移した(実装を1つに保つため)。
// 関数そのもののテストは tests/store.test.js にある
const { sanitizeParseError } = require('../src/store');

const SCRIPT_PATH = '../scripts/migrate-to-turso';
const STORE_PATH = '../src/store';
// スクリプトは src/streak.js / src/data.js も読み込み、両者が src/store.js を
// トップレベルでrequireしているため、モック注入時はまとめてキャッシュを落とす
const MOCK_MODULE_PATHS = [SCRIPT_PATH, STORE_PATH, '../src/streak', '../src/data'];

function clearMockModuleCache() {
  for (const p of MOCK_MODULE_PATHS) {
    try { delete require.cache[require.resolve(p)]; } catch {}
  }
}

/**
 * store をモックして scripts/migrate-to-turso.js をロードする
 * (tests/data.test.js と同じ require.cache 注入方式)。
 *
 * @param {object} overrides - createSchema / readState / writeState の差し替え
 * @returns {{script: object, calls: {createSchema: number, reads: string[], writes: Array<{key: string, value: string}>}}}
 */
function loadScriptWithStore(overrides = {}) {
  clearMockModuleCache();
  const calls = { createSchema: 0, reads: [], writes: [] };
  const storePath = require.resolve(STORE_PATH);

  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      createSchema: async () => {
        calls.createSchema++;
        return overrides.createSchema ? overrides.createSchema() : { success: true };
      },
      readState: async (key) => {
        calls.reads.push(key);
        return overrides.readState
          ? overrides.readState(key, calls.reads.length)
          : { success: true, state: 'empty', value: null };
      },
      writeState: async (key, value) => {
        calls.writes.push({ key, value });
        return overrides.writeState ? overrides.writeState(key, value) : { success: true };
      },
      resolveEndpoint: () => 'https://test-db.turso.io/v2/pipeline',
      sanitizeParseError
    }
  };

  return { script: require(SCRIPT_PATH), calls };
}

/** data/ のファイル読み込みを差し替える(実ファイルは読まない) */
function stubDataFiles(files) {
  nodeFs.promises.readFile = async (filePath) => {
    const name = path.basename(String(filePath));
    if (Object.prototype.hasOwnProperty.call(files, name)) {
      return files[name];
    }
    const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    error.code = 'ENOENT';
    throw error;
  };
}

describe('Turso移行スクリプト (scripts/migrate-to-turso.js)', () => {
  describe('parseArgs()', () => {
    it('--force をフラグとして解釈する', () => {
      assert.deepStrictEqual(parseArgs(['--force']), { force: true });
    });

    it('引数なしなら空オブジェクトを返す', () => {
      assert.deepStrictEqual(parseArgs([]), {});
    });

    it('値付きの --force は文字列として拾う(resolveForceが拒否する前提)', () => {
      assert.deepStrictEqual(parseArgs(['--force', 'true']), { force: 'true' });
    });
  });

  describe('resolveForce() — M6: 値付き --force を黙って無効化しない', () => {
    it('--force なしは force:false', () => {
      assert.deepStrictEqual(resolveForce({}), { ok: true, force: false });
    });

    it('値なしの --force は force:true', () => {
      assert.deepStrictEqual(resolveForce({ force: true }), { ok: true, force: true });
    });

    it('--force true は拒否する(黙ってforceしないのを防ぐ)', () => {
      const result = resolveForce({ force: 'true' });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.force, false);
      assert.match(result.error, /--force に値を付けないでください/);
      assert.match(result.error, /"true"/);
    });

    it('--force false も拒否する(真偽値として解釈して上書きする事故を防ぐ)', () => {
      const result = resolveForce({ force: 'false' });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.force, false);
    });
  });

  describe('maskUserName()', () => {
    it('末尾1文字だけ残して伏せる(ログに実名を出さない)', () => {
      assert.strictEqual(maskUserName('やまだたろう'), '*****う');
    });

    it('1文字の名前はそのまま返す', () => {
      assert.strictEqual(maskUserName('た'), 'た');
    });

    it('空文字列は空文字列を返す', () => {
      assert.strictEqual(maskUserName(''), '');
    });
  });

  describe('describeSchemaFailure() — C1: createSchema失敗時の危険度判定', () => {
    it('probe.state===uninitializedなら安全(dangerous:false)と判定する', () => {
      const result = describeSchemaFailure('タイムアウト', { success: true, state: 'uninitialized' });
      assert.strictEqual(result.dangerous, false);
      assert.match(result.message, /uninitialized/);
      assert.match(result.message, /安全な状態/);
    });

    it('probe.state===emptyなら危険(dangerous:true)と判定し翌朝の被害を警告する', () => {
      const result = describeSchemaFailure('トリガー作成エラー', { success: true, state: 'empty' });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /危険/);
      assert.match(result.message, /state=empty/);
      assert.match(result.message, /朝通知/);
    });

    it('probe.state===okなら危険と判定する(データが既にある状態でテーブル操作が一部失敗)', () => {
      const result = describeSchemaFailure('トリガー作成エラー', { success: true, state: 'ok' });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /state=ok/);
    });

    it('probe.state===okでは「0にリセットされます」と言わない(行があればリセットは起きない)', () => {
      const result = describeSchemaFailure('トリガー作成エラー', { success: true, state: 'ok' });
      assert.doesNotMatch(result.message, /0にリセットされます/);
      assert.match(result.message, /リセットされることはありません/);
      assert.match(result.message, /スキーマが不完全/);
    });

    it('危険な文面には翌朝7:00・morning-crawlerの無効化・--forceが含まれる', () => {
      const result = describeSchemaFailure('トリガー作成エラー', { success: true, state: 'empty' });
      assert.match(result.message, /7:00/);
      assert.match(result.message, /morning-crawler/);
      assert.match(result.message, /--force/);
      assert.match(result.message, /streak \/ grace \/ bonus/);
    });

    it('probe自体が失敗(接続不能)なら安全と断定できないため危険とみなす', () => {
      const result = describeSchemaFailure('スキーマエラー', { success: false, error: 'タイムアウト' });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /確認不能/);
      assert.match(result.message, /タイムアウト/);
    });
  });

  describe('compareRoundTrip() — C3: 書き込み内容と読み戻し内容の照合', () => {
    it('一致すればokになる', () => {
      const result = compareRoundTrip('streak_data', '{"a":1}', '{"a":1}');
      assert.strictEqual(result.ok, true);
      assert.match(result.message, /一致しました/);
    });

    it('不一致ならngになり文字数を明示する', () => {
      const result = compareRoundTrip('streak_data', '{"a":1}', '{"a":2,"b":3}');
      assert.strictEqual(result.ok, false);
      assert.match(result.message, /一致しません/);
      assert.match(result.message, /書込7文字/);
      assert.match(result.message, /読戻13文字/);
    });

    it('読み戻し値がnullなら読み戻せなかった扱いにする', () => {
      const result = compareRoundTrip('streak_data', '{"a":1}', null);
      assert.strictEqual(result.ok, false);
      assert.match(result.message, /読み戻せませんでした/);
    });

    it('長さが同じでも内容が違えばngにする(長さ比較への退化を防ぐ)', () => {
      const result = compareRoundTrip('streak_data', '{"a":1}', '{"a":2}');
      assert.strictEqual(result.ok, false, '同じ7文字だが中身が違うので不一致にすべき');
      assert.match(result.message, /一致しません/);
    });
  });

  describe('formatUserSummaryLine() — 実名マスクとフィールド表示', () => {
    it('主要フィールドを1行にまとめ実名はマスクする', () => {
      const line = formatUserSummaryLine('やまだたろう', {
        streak: 5,
        grace: 2,
        bonus: 10,
        course: '小学生コース',
        lastConfirmedDate: '2026-08-26',
        history: { '2026-08-25': true, '2026-08-26': true },
        exemptDates: ['2026-08-20']
      });
      assert.match(line, /\*\*\*\*\*う/);
      assert.doesNotMatch(line, /やまだたろう/);
      assert.match(line, /streak=5/);
      assert.match(line, /grace=2/);
      assert.match(line, /bonus=10/);
      assert.match(line, /course=小学生コース/);
      assert.match(line, /履歴2日/);
      assert.match(line, /免除1日/);
    });

    it('stateがundefinedでも例外を投げずデフォルト値で表示する(I4: 破損データへの耐性)', () => {
      const line = formatUserSummaryLine('たろう', undefined);
      assert.match(line, /bonus=0/);
      assert.match(line, /course=\(未設定\)/);
      assert.match(line, /lastConfirmedDate=null/);
      assert.match(line, /履歴0日/);
      assert.match(line, /免除0日/);
    });
  });

  describe('hasStreakData() — C2追加: streak_data欠落時にcreateSchemaを呼ばせない防波堤', () => {
    it('streak_dataが含まれていればtrue', () => {
      assert.strictEqual(
        hasStreakData([{ file: 'streak_data.json', key: 'streak_data', normalized: '{}' }]),
        true
      );
    });

    it('mission_dataだけならfalse(streak_data.json欠落を検出する)', () => {
      assert.strictEqual(
        hasStreakData([{ file: 'mission_data.json', key: 'mission_data', normalized: '[]' }]),
        false
      );
    });

    it('空配列ならfalse', () => {
      assert.strictEqual(hasStreakData([]), false);
    });
  });

  describe('describePostSchemaFailure() — C1: createSchema成功後にstreak_dataを投入できなかった場合', () => {
    it('probe.state===emptyは最も危険(テーブルは実在し行が無い)と判定する', () => {
      const result = describePostSchemaFailure('streak_data の書き込みに失敗しました: タイムアウト', {
        success: true, state: 'empty'
      });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /🚨/);
      assert.match(result.message, /テーブルは作成済みで、streak_data の行がない/);
      assert.match(result.message, /翌JST 7:00の朝通知/);
      assert.match(result.message, /streak \/ grace \/ bonus/);
      assert.match(result.message, /上書きされます/);
      assert.match(result.message, /morning-crawler/);
      assert.match(result.message, /既に存在します/);
      assert.match(result.message, /--force/);
    });

    it('probe自体が失敗(確認不能)なら安全と断定できないため危険とみなす', () => {
      const result = describePostSchemaFailure('既存確認に失敗しました', { success: false, error: '接続エラー' });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /確認不能\(接続エラー\)/);
      assert.match(result.message, /🚨/);
    });

    it('probe.state===okなら行が存在するので危険ではない', () => {
      const result = describePostSchemaFailure('mission_data の書き込みに失敗しました', { success: true, state: 'ok' });
      assert.strictEqual(result.dangerous, false);
      assert.doesNotMatch(result.message, /🚨/);
      assert.match(result.message, /行は存在します/);
    });

    it('probe.state===uninitializedなら朝通知がスキップするので危険ではない', () => {
      const result = describePostSchemaFailure('既存確認に失敗しました', { success: true, state: 'uninitialized' });
      assert.strictEqual(result.dangerous, false);
      assert.match(result.message, /確定処理をスキップ/);
    });
  });

  describe('buildFailureAdvice() — C1: 「何も投入されていません」の出し分け', () => {
    it('schemaCreated:false かつ未投入なら「何も投入されていません」を出す', () => {
      const lines = buildFailureAdvice({ migrated: [], schemaCreated: false });
      assert.strictEqual(lines.length, 1);
      assert.match(lines[0], /何も投入されていません/);
    });

    it('schemaCreated:true なら「何も投入されていません」を出さない(危険状態の誤報を防ぐ)', () => {
      const lines = buildFailureAdvice({ migrated: [], schemaCreated: true, dangerous: true });
      assert.ok(
        lines.every(line => !/何も投入されていません/.test(line)),
        'テーブルが作成済みなのに「何も投入されていません」と言ってはいけない'
      );
      assert.ok(lines.some(line => /🚨/.test(line)));
    });

    it('投入済みのキーがあればそれを案内し「何も投入されていません」は出さない', () => {
      const lines = buildFailureAdvice({ migrated: ['streak_data'], schemaCreated: true });
      assert.match(lines[0], /streak_data は投入済みです/);
      assert.ok(lines.every(line => !/何も投入されていません/.test(line)));
    });

    it('dangerousでなければ🚨の行は出さない', () => {
      const lines = buildFailureAdvice({ migrated: [], schemaCreated: false, dangerous: false });
      assert.ok(lines.every(line => !/🚨/.test(line)));
    });

    it('schemaCreated:true かつ dangerous:false でも「何も投入されていません」は出さない', () => {
      // 危険フラグではなくテーブル作成の有無で出し分けること
      // (既存行があってスキップし、後続の書き込みが失敗した場合がこれに該当する)
      const lines = buildFailureAdvice({ migrated: [], schemaCreated: true, dangerous: false });
      assert.ok(
        lines.every(line => !/何も投入されていません/.test(line)),
        'テーブルが作成済みなら「何も投入されていません」は誤り'
      );
    });

    it('schemaCreated:false かつ dangerous:true のとき「何も投入されていません」を出さない(危険状態との矛盾を防ぐ)', () => {
      // createSchemaが部分成功で失敗した場合(某テーブルは作成済みだが他のテーブルは未作成)
      // 🚨危険フラグが立つため、「何も投入されていません」と矛盾する
      const lines = buildFailureAdvice({ migrated: [], schemaCreated: false, dangerous: true });
      assert.ok(
        lines.every(line => !/何も投入されていません/.test(line)),
        '危険状態では「何も投入されていません」は誤り'
      );
      assert.ok(lines.some(line => /🚨/.test(line)), '危険フラグは出すこと');
    });
  });

  describe('migrate() — I3: 一度きり・不可逆の本体', () => {
    let originalReadFile;

    beforeEach(() => {
      originalReadFile = nodeFs.promises.readFile;
    });

    afterEach(() => {
      nodeFs.promises.readFile = originalReadFile;
      clearMockModuleCache();
    });

    it('JSONが壊れていたら createSchema を1度も呼ばない(順序がload-bearing)', async () => {
      const { script, calls } = loadScriptWithStore();
      // 壊れたJSONにユーザー名を含め、エラー文に実名が乗らないことも同時に確認する
      stubDataFiles({
        'streak_data.json': '{"version":"1.4","users":{"やまだたろう":undefined}}',
        'mission_data.json': '{"version":"2.0","users":[]}'
      });

      const result = await script.migrate();

      assert.strictEqual(result.success, false);
      assert.strictEqual(calls.createSchema, 0, 'JSON破損時はテーブルを作ってはいけない');
      assert.strictEqual(calls.writes.length, 0);
      assert.strictEqual(result.schemaCreated, false);
      assert.match(result.error, /JSONが壊れています/);
      assert.doesNotMatch(result.error, /やまだたろう/, 'エラー文に実名を含めないこと');
    });

    it('streak_data.json が無ければ createSchema を呼ばない', async () => {
      const { script, calls } = loadScriptWithStore();
      stubDataFiles({ 'mission_data.json': '{"version":"2.0","users":[]}' });

      const result = await script.migrate();

      assert.strictEqual(result.success, false);
      assert.strictEqual(calls.createSchema, 0);
      assert.strictEqual(result.schemaCreated, false);
      assert.match(result.error, /streak_data.json が無いため中断/);
    });

    it('ファイルが1件も無ければ createSchema を呼ばず、書き込みも照合対象もない', async () => {
      const { script, calls } = loadScriptWithStore();
      stubDataFiles({});

      const result = await script.migrate();

      assert.strictEqual(result.success, true);
      assert.strictEqual(calls.createSchema, 0);
      assert.strictEqual(result.schemaCreated, false);
      assert.deepStrictEqual(result.writtenContent, {});
    });

    it('createSchema成功 + writeState失敗なら危険状態を示し「何も投入されていません」を出さない', async () => {
      const { script, calls } = loadScriptWithStore({
        writeState: async () => ({ success: false, error: 'タイムアウト: Turso が10000ms以内に応答しませんでした' })
      });
      stubDataFiles({
        'streak_data.json': '{"version":"1.4","users":{}}',
        'mission_data.json': '{"version":"2.0","users":[]}'
      });

      const result = await script.migrate();

      assert.strictEqual(result.success, false);
      assert.strictEqual(calls.createSchema, 1);
      assert.strictEqual(result.schemaCreated, true, 'テーブルは作成済みであることを戻り値で示すこと');
      assert.strictEqual(result.dangerous, true);
      assert.deepStrictEqual(result.migrated, []);
      assert.match(result.error, /🚨/);
      assert.match(result.error, /テーブルは作成済みで、streak_data の行がない/);
      assert.match(result.error, /--force/);

      const lines = buildFailureAdvice(result);
      assert.ok(
        lines.every(line => !/何も投入されていません/.test(line)),
        '最も危険な状態を「安全」と誤報してはいけない'
      );
      assert.ok(lines.some(line => /🚨/.test(line)));
    });

    it('createSchema成功 + 既存確認の一過性失敗でも危険状態として返す', async () => {
      const { script, calls } = loadScriptWithStore({
        readState: async () => ({ success: false, error: 'Turso 接続エラー: fetch failed' })
      });
      stubDataFiles({
        'streak_data.json': '{"version":"1.4","users":{}}',
        'mission_data.json': '{"version":"2.0","users":[]}'
      });

      const result = await script.migrate();

      assert.strictEqual(result.success, false);
      assert.strictEqual(calls.createSchema, 1);
      assert.strictEqual(result.schemaCreated, true);
      assert.strictEqual(result.dangerous, true);
      assert.strictEqual(calls.writes.length, 0);
      assert.match(result.error, /既存確認に失敗しました/);
      assert.match(result.error, /確認不能/);
    });

    it('streak_data投入後にmission_dataが失敗した場合は危険ではない(行が既にある)', async () => {
      const { script } = loadScriptWithStore({
        writeState: async (key) => key === 'mission_data'
          ? { success: false, error: 'タイムアウト' }
          : { success: true }
      });
      stubDataFiles({
        'streak_data.json': '{"version":"1.4","users":{}}',
        'mission_data.json': '{"version":"2.0","users":[]}'
      });

      const result = await script.migrate();

      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(result.migrated, ['streak_data']);
      assert.ok(!result.dangerous, 'streak_dataが投入済みなら上書き被害は起きない');

      const lines = buildFailureAdvice(result);
      assert.match(lines[0], /streak_data は投入済みです/);
      assert.ok(lines.every(line => !/何も投入されていません/.test(line)));
    });

    it('既存のstreak_dataをスキップした後にmission_dataが失敗しても危険ではないが、テーブルは作成済みと返す', async () => {
      const { script } = loadScriptWithStore({
        readState: async (key) => key === 'streak_data'
          ? { success: true, state: 'ok', value: '{"version":"1.4","users":{}}' }
          : { success: true, state: 'empty', value: null },
        writeState: async () => ({ success: false, error: 'タイムアウト' })
      });
      stubDataFiles({
        'streak_data.json': '{"version":"1.4","users":{}}',
        'mission_data.json': '{"version":"2.0","users":[]}'
      });

      const result = await script.migrate();

      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(result.migrated, []);
      assert.strictEqual(result.schemaCreated, true);
      assert.ok(!result.dangerous, 'streak_dataの行が存在するので危険ではない');

      const lines = buildFailureAdvice(result);
      assert.ok(
        lines.every(line => !/何も投入されていません/.test(line)),
        'テーブル作成後の失敗で「何も投入されていません」と言ってはいけない'
      );
    });

    it('正常系: streak_data → mission_data の順に投入し、正規化したJSONを書き込む', async () => {
      const { script, calls } = loadScriptWithStore();
      stubDataFiles({
        'streak_data.json': '{\n  "version": "1.4",\n  "users": {}\n}',
        'mission_data.json': '{"version":"2.0","users":[]}'
      });

      const result = await script.migrate();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.schemaCreated, true);
      assert.deepStrictEqual(result.migrated, ['streak_data', 'mission_data']);
      assert.deepStrictEqual(calls.writes.map(w => w.key), ['streak_data', 'mission_data']);
      assert.strictEqual(calls.writes[0].value, '{"version":"1.4","users":{}}', '改行を落として正規化すること');
      assert.deepStrictEqual(Object.keys(result.writtenContent), ['streak_data', 'mission_data']);
    });

    it('既存の行があり--forceなしならスキップし、書き込まない', async () => {
      const { script, calls } = loadScriptWithStore({
        readState: async () => ({ success: true, state: 'ok', value: '{"version":"1.4","users":{}}' })
      });
      stubDataFiles({
        'streak_data.json': '{"version":"1.4","users":{}}',
        'mission_data.json': '{"version":"2.0","users":[]}'
      });

      const result = await script.migrate();

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.migrated, []);
      assert.deepStrictEqual(result.skipped, ['streak_data', 'mission_data']);
      assert.strictEqual(calls.writes.length, 0);
      assert.deepStrictEqual(result.writtenContent, {}, '照合対象がないこと(verifyはスキップされる)');
    });
  });
});
