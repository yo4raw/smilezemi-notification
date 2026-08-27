/**
 * Turso状態ストアのテスト
 *
 * fetchをモックしてHTTPリクエストの内容とレスポンス解釈を検証する。
 * 実DBには接続しない。
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');

describe('Turso状態ストア (src/store.js)', () => {
  let originalFetch;
  let originalUrl;
  let originalToken;
  let fetchCalls;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalUrl = process.env.TURSO_DATABASE_URL;
    originalToken = process.env.TURSO_AUTH_TOKEN;
    process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
    process.env.TURSO_AUTH_TOKEN = 'test-token';
    fetchCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = originalUrl;
    if (originalToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = originalToken;
  });

  /** pipelineのレスポンスを組み立てる。resultsは各文の結果を順に並べる */
  function mockFetchOk(results) {
    global.fetch = async (url, options) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ baton: null, base_url: null, results })
      };
    };
  }

  /** execute成功の結果。rowsは [[{type,value}]] 形式 */
  function okExecute(rows = []) {
    return {
      type: 'ok',
      response: { type: 'execute', result: { cols: [], rows, affected_row_count: 0 } }
    };
  }

  function errorResult(message) {
    return { type: 'error', error: { message, code: 'SQLITE_UNKNOWN' } };
  }

  describe('resolveEndpoint()', () => {
    it('libsql:// を https:// に変換して /v2/pipeline を付ける', () => {
      assert.strictEqual(
        store.resolveEndpoint('libsql://test-db.turso.io'),
        'https://test-db.turso.io/v2/pipeline'
      );
    });

    it('末尾のスラッシュを重複させない', () => {
      assert.strictEqual(
        store.resolveEndpoint('libsql://test-db.turso.io/'),
        'https://test-db.turso.io/v2/pipeline'
      );
    });

    it('https:// で渡された場合もそのまま扱う', () => {
      assert.strictEqual(
        store.resolveEndpoint('https://test-db.turso.io'),
        'https://test-db.turso.io/v2/pipeline'
      );
    });

    it('空文字列は例外にする', () => {
      assert.throws(() => store.resolveEndpoint(''), /TURSO_DATABASE_URL/);
    });
  });

  describe('readState()', () => {
    it('行があれば state=ok と値を返す', async () => {
      mockFetchOk([okExecute([[{ type: 'text', value: '{"version":"2.0"}' }]]), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.readState('mission_data');

      assert.deepStrictEqual(result, { success: true, state: 'ok', value: '{"version":"2.0"}' });
    });

    it('行がなければ state=empty を返す', async () => {
      mockFetchOk([okExecute([]), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.readState('mission_data');

      assert.deepStrictEqual(result, { success: true, state: 'empty', value: null });
    });

    it('no such table は state=uninitialized を返す(移行前)', async () => {
      mockFetchOk([errorResult('SQLite error: no such table: app_state'), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.readState('streak_data');

      assert.deepStrictEqual(result, { success: true, state: 'uninitialized', value: null });
    });

    it('no such table 以外のSQLエラーは失敗にする', async () => {
      mockFetchOk([errorResult('SQLite error: database is locked'), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.readState('streak_data');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /database is locked/);
    });

    it('keyをバインド引数で渡す(文字列連結しない)', async () => {
      mockFetchOk([okExecute([]), { type: 'ok', response: { type: 'close' } }]);

      await store.readState('streak_data');

      const { body, url, options } = fetchCalls[0];
      assert.strictEqual(url, 'https://test-db.turso.io/v2/pipeline');
      assert.strictEqual(options.headers.Authorization, 'Bearer test-token');
      assert.deepStrictEqual(body.requests[0].stmt.args, [{ type: 'text', value: 'streak_data' }]);
      assert.match(body.requests[0].stmt.sql, /where key = \?/);
      assert.strictEqual(body.requests.at(-1).type, 'close', '最後にcloseを送ること');
    });

    it('HTTPステータスが200以外なら失敗にする', async () => {
      global.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) });

      const result = await store.readState('streak_data');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /401/);
    });

    it('接続情報が未設定なら失敗にする', async () => {
      delete process.env.TURSO_AUTH_TOKEN;

      const result = await store.readState('streak_data');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /TURSO_AUTH_TOKEN/);
    });
  });
});
