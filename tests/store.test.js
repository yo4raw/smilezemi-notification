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
});
