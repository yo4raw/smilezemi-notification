# データ永続化の Turso 移行 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `data/mission_data.json` と `data/streak_data.json` の置き場を GitHub Actions キャッシュから Turso へ移し、公開リポジトリから子どもの実名が読み取れる状態を解消する。

**Architecture:** `src/store.js` を新設して Turso の HTTP API（`/v2/pipeline`）を `fetch` で直接叩く。`data.js` / `streak.js` の4つの公開関数（`loadPreviousData` / `saveData` / `loadStreakData` / `saveStreakData`）の中身だけを差し替え、戻り値の形は変えない。これによりエントリポイントと運用スクリプトの呼び出し側は原則そのまま動く。例外は「Turso が未初期化（移行前）」の判別で、これだけは夜通知と朝通知に分岐を足す。

**Tech Stack:** Node.js 24 / CommonJS / Turso (libSQL) HTTP API / Node.js built-in test runner

**Spec:** `docs/superpowers/specs/2026-08-27-turso-migration-design.md`

## Global Constraints

- **本番依存パッケージを増やさない。** `@libsql/client` は導入しない。`package.json` の `dependencies` は `playwright` のみを維持する
- Module System は CommonJS（`require` / `module.exports`）
- テストは `node --test --test-force-exit --experimental-test-isolation=none tests/*.test.js`。単一ファイル実行時もこの2つのオプションは必須
- lint は `npm run lint`（`oxlint --deny-warnings src`）。警告もエラー扱い
- プロジェクトに書く Markdown はすべて日本語
- 子どもの実名は絶対に出さない。コミットメッセージ、コード、ドキュメント、ログのすべてで架空名（たろう / はなこ / じろう / やまだ）を使う
- **`writeState` はテーブルを作成してはならない。** スキーマ作成は移行スクリプトだけの責務
- `readState` は `'ok'` / `'empty'` / `'uninitialized'` の3状態を区別する。`'uninitialized'` を `'empty'` と同一視するとストリークが 0 にリセットされる
- Turso の pipeline は文がエラーでも HTTP 200 を返す。`results[i].type === 'error'` を必ず検査する
- 作業範囲は **Pull Request の作成まで**。main へのマージは行わない
- 作業ブランチは `feature/turso-migration`（既存）

---

### Task 1: `src/store.js` — Turso アクセス層

**Files:**
- Create: `src/store.js`
- Create: `tests/store.test.js`

**Interfaces:**
- Consumes: なし（このタスクが最初）
- Produces:
  - `resolveEndpoint(databaseUrl: string) => string` — `libsql://host` を `https://host/v2/pipeline` に変換する
  - `readState(key: string) => Promise<{success: true, state: 'ok'|'empty'|'uninitialized', value: string|null} | {success: false, error: string}>`
  - `writeState(key: string, value: string) => Promise<{success: true} | {success: false, error: string}>`
  - `createSchema() => Promise<{success: true} | {success: false, error: string}>` — 移行スクリプト専用
  - 接続情報は `process.env.TURSO_DATABASE_URL` / `process.env.TURSO_AUTH_TOKEN` から都度読む（テストで差し替えられるようにモジュールロード時にキャプチャしない）

- [ ] **Step 1: `resolveEndpoint` の失敗するテストを書く**

`tests/store.test.js` を新規作成する。

```js
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js`
Expected: FAIL（`Cannot find module '../src/store'`）

- [ ] **Step 3: `src/store.js` に `resolveEndpoint` だけを実装する**

```js
/**
 * Turso(libSQL)の状態ストア
 *
 * TursoのHTTP API(/v2/pipeline)をfetchで直接叩く。@libsql/clientは導入しない
 * (本番依存をplaywrightのみに保ち、Dockerイメージを重くしないため)。
 * 用途は「1行読んで1行書く」だけなのでSDKの機能は不要。
 *
 * データモデルと未初期化の扱いは
 * docs/superpowers/specs/2026-08-27-turso-migration-design.md を参照。
 */

// notifier.jsのLINE送信と同じ既定値に揃える
const REQUEST_TIMEOUT_MS = 10000;

// 書き込みの再試行間隔。bonusは実際のお小遣いなので、一瞬のネットワーク断で
// 1日分を取りこぼさないよう1度だけ待って再送する
const WRITE_RETRY_DELAY_MS = 1000;

/**
 * データベースURLからpipelineエンドポイントを導出する
 *
 * @param {string} databaseUrl - libsql:// または https:// で始まるURL
 * @returns {string}
 * @throws {Error} URLが空の場合
 */
function resolveEndpoint(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('TURSO_DATABASE_URL が設定されていません');
  }

  const httpsUrl = databaseUrl.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  return `${httpsUrl}/v2/pipeline`;
}

module.exports = {
  resolveEndpoint
};
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js`
Expected: PASS（4件）

- [ ] **Step 5: コミット**

```bash
git add src/store.js tests/store.test.js
git commit -m "feat: Tursoのpipelineエンドポイント導出を追加する"
```

- [ ] **Step 6: `readState` の失敗するテストを書く**

`tests/store.test.js` の `describe('resolveEndpoint()')` ブロックの直後（同じ外側 describe の中）に追加する。

```js
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
```

- [ ] **Step 7: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js`
Expected: FAIL（`store.readState is not a function`）

- [ ] **Step 8: `pipeline` と `readState` を実装する**

`src/store.js` の `resolveEndpoint` の下に追加し、`module.exports` に `readState` を足す。

```js
/**
 * pipelineリクエストを1回送る
 *
 * TursoのpipelineはSQL文ごとに独立して実行され、途中の文がエラーでも
 * HTTP 200を返して後続を実行する。そのため各結果のtypeを検査する必要がある。
 *
 * @param {Array<{sql: string, args?: Array<{type: string, value: string}>}>} statements
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @returns {Promise<{success: boolean, results?: Array<object>, error?: string}>}
 * @private
 */
async function pipeline(statements, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS } = options;

  const databaseUrl = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (!databaseUrl) {
    return { success: false, error: 'TURSO_DATABASE_URL が設定されていません' };
  }
  if (!authToken) {
    return { success: false, error: 'TURSO_AUTH_TOKEN が設定されていません' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(resolveEndpoint(databaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        requests: [
          ...statements.map(stmt => ({ type: 'execute', stmt })),
          { type: 'close' }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Turso API エラー: ${response.status} ${response.statusText}`
      };
    }

    const body = await response.json();
    const results = body.results ?? [];

    const failed = results.find(result => result.type === 'error');
    if (failed) {
      return { success: false, error: `SQL エラー: ${failed.error?.message ?? '詳細不明'}` };
    }

    return { success: true, results };
  } catch (error) {
    if (error.name === 'AbortError') {
      return {
        success: false,
        error: `タイムアウト: Turso が${timeoutMs}ms以内に応答しませんでした`
      };
    }
    return { success: false, error: `Turso 接続エラー: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * app_stateテーブルが存在しないことを示すエラーか
 * @private
 */
function isMissingTableError(message) {
  return typeof message === 'string' && message.includes('no such table');
}

/**
 * 状態を1件読み出す
 *
 * テーブルが存在しない場合は state='uninitialized' を返す。呼び出し側は
 * これを「初回実行(empty)」と区別し、ストリークの確定処理をスキップしなければならない。
 * 同一視すると移行前に連続日数が0にリセットされる。
 *
 * @param {string} key - 'mission_data' | 'streak_data'
 * @returns {Promise<{success: boolean, state?: 'ok'|'empty'|'uninitialized', value?: string|null, error?: string}>}
 */
async function readState(key) {
  const result = await pipeline([
    {
      sql: 'select value from app_state where key = ?',
      args: [{ type: 'text', value: key }]
    }
  ]);

  if (!result.success) {
    if (isMissingTableError(result.error)) {
      return { success: true, state: 'uninitialized', value: null };
    }
    return { success: false, error: result.error };
  }

  const rows = result.results[0]?.response?.result?.rows ?? [];

  if (rows.length === 0) {
    return { success: true, state: 'empty', value: null };
  }

  return { success: true, state: 'ok', value: rows[0][0].value };
}
```

- [ ] **Step 9: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js`
Expected: PASS（11件）

- [ ] **Step 10: コミット**

```bash
git add src/store.js tests/store.test.js
git commit -m "feat: Tursoからの状態読み出しを追加する(未初期化を初回実行と区別する)"
```

- [ ] **Step 11: `writeState` の失敗するテストを書く**

`tests/store.test.js` の `describe('readState()')` の直後に追加する。

```js
  describe('writeState()', () => {
    it('app_stateのupsertを1文だけ送る(監査行はトリガーが積む)', async () => {
      mockFetchOk([okExecute(), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.writeState('streak_data', '{"version":"1.4"}');

      assert.deepStrictEqual(result, { success: true });

      const { body } = fetchCalls[0];
      const executes = body.requests.filter(request => request.type === 'execute');
      assert.strictEqual(executes.length, 1, 'execute文は1つだけであること');
      assert.match(executes[0].stmt.sql, /insert into app_state/);
      assert.match(executes[0].stmt.sql, /on conflict\(key\) do update/);
      assert.doesNotMatch(executes[0].stmt.sql, /state_audit/, 'アプリからstate_auditへ直接書かないこと');
      assert.doesNotMatch(executes[0].stmt.sql, /create table/i, 'テーブルを作成しないこと');
    });

    it('keyとvalueとupdated_atをバインド引数で渡す', async () => {
      mockFetchOk([okExecute(), { type: 'ok', response: { type: 'close' } }]);

      await store.writeState('mission_data', '{"a":1}');

      const args = fetchCalls[0].body.requests[0].stmt.args;
      assert.strictEqual(args.length, 3);
      assert.deepStrictEqual(args[0], { type: 'text', value: 'mission_data' });
      assert.deepStrictEqual(args[1], { type: 'text', value: '{"a":1}' });
      assert.strictEqual(args[2].type, 'text');
      assert.match(args[2].value, /^\d{4}-\d{2}-\d{2}T/, 'updated_atがISO 8601であること');
    });

    it('失敗したら1度だけ再送し、成功すればsuccessを返す', async () => {
      let attempts = 0;
      global.fetch = async (url, options) => {
        attempts++;
        fetchCalls.push({ url, options, body: JSON.parse(options.body) });
        if (attempts === 1) {
          throw new Error('network down');
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ results: [okExecute(), { type: 'ok', response: { type: 'close' } }] })
        };
      };

      const result = await store.writeState('streak_data', '{}');

      assert.deepStrictEqual(result, { success: true });
      assert.strictEqual(attempts, 2, '1度だけ再送すること');
    });

    it('再送しても失敗したら諦めてエラーを返す', async () => {
      let attempts = 0;
      global.fetch = async (url, options) => {
        attempts++;
        fetchCalls.push({ url, options, body: JSON.parse(options.body) });
        throw new Error('network down');
      };

      const result = await store.writeState('streak_data', '{}');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /network down/);
      assert.strictEqual(attempts, 2, '3回以上は試さないこと');
    });

    it('テーブルがない状態の書き込みは失敗にする(自動作成しない)', async () => {
      mockFetchOk([errorResult('SQLite error: no such table: app_state'), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.writeState('streak_data', '{}');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /no such table/);
    });
  });
```

`writeState` の再送は 1000ms 待つため、この describe の実行には約2秒かかる。`--test-force-exit` を付けているのでプロセスが残ることはない。

- [ ] **Step 12: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js`
Expected: FAIL（`store.writeState is not a function`）

- [ ] **Step 13: `writeState` を実装する**

`src/store.js` の `readState` の下に追加し、`module.exports` に `writeState` を足す。

```js
/**
 * 状態を1件書き込む
 *
 * 送るのはapp_stateのupsert 1文だけ。state_auditへの追記はトリガーが行う。
 * pipelineは文ごとに独立して実行されるため、2文に分けると片方だけ成立する
 * 状態が起こりうる。トリガーは元の文と同じ暗黙のトランザクションで動くので、
 * 現在値と監査行が必ず揃う。
 *
 * テーブルは作成しない。スキーマ作成は移行スクリプト(createSchema)だけの責務。
 * ここで自動作成すると、未移行の状態で夜通知がテーブルを作ってしまい、
 * 翌朝の読み出しが'uninitialized'ではなく'empty'になってストリークが0にリセットされる。
 *
 * @param {string} key - 'mission_data' | 'streak_data'
 * @param {string} value - JSON文字列
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function writeState(key, value) {
  const statements = [
    {
      sql: 'insert into app_state (key, value, updated_at) values (?, ?, ?)'
        + ' on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at',
      args: [
        { type: 'text', value: key },
        { type: 'text', value },
        { type: 'text', value: new Date().toISOString() }
      ]
    }
  ];

  const first = await pipeline(statements);
  if (first.success) {
    return { success: true };
  }

  await new Promise(resolve => setTimeout(resolve, WRITE_RETRY_DELAY_MS));

  const second = await pipeline(statements);
  if (second.success) {
    return { success: true };
  }

  return { success: false, error: second.error };
}
```

- [ ] **Step 14: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js`
Expected: PASS（16件）

- [ ] **Step 15: コミット**

```bash
git add src/store.js tests/store.test.js
git commit -m "feat: Tursoへの状態書き込みを追加する(監査行はトリガーに任せる)"
```

- [ ] **Step 16: `createSchema` の失敗するテストを書く**

`tests/store.test.js` の `describe('writeState()')` の直後に追加する。

```js
  describe('createSchema()', () => {
    it('テーブル2つとトリガー2つをif not existsで作る', async () => {
      mockFetchOk([okExecute(), okExecute(), okExecute(), okExecute(), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.createSchema();

      assert.deepStrictEqual(result, { success: true });

      const sqls = fetchCalls[0].body.requests
        .filter(request => request.type === 'execute')
        .map(request => request.stmt.sql);

      assert.strictEqual(sqls.length, 4);
      assert.ok(sqls.some(sql => /create table if not exists app_state/.test(sql)));
      assert.ok(sqls.some(sql => /create table if not exists state_audit/.test(sql)));
      assert.ok(sqls.some(sql => /create trigger if not exists app_state_audit_insert/.test(sql)));
      assert.ok(sqls.some(sql => /create trigger if not exists app_state_audit_update/.test(sql)));
    });

    it('SQLエラーは失敗として返す', async () => {
      mockFetchOk([errorResult('SQLite error: syntax error'), { type: 'ok', response: { type: 'close' } }]);

      const result = await store.createSchema();

      assert.strictEqual(result.success, false);
      assert.match(result.error, /syntax error/);
    });
  });
```

- [ ] **Step 17: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js`
Expected: FAIL（`store.createSchema is not a function`）

- [ ] **Step 18: `createSchema` を実装する**

`src/store.js` の `writeState` の下に追加し、`module.exports` を最終形にする。

```js
/**
 * スキーマを作成する(移行スクリプト専用)
 *
 * ランタイム(readState/writeState)からは絶対に呼ばない。未移行の状態を
 * 「初回実行」と誤認させないため、テーブルの存在自体が移行完了の印になっている。
 *
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function createSchema() {
  const result = await pipeline([
    {
      sql: 'create table if not exists app_state ('
        + ' key text primary key,'
        + ' value text not null,'
        + ' updated_at text not null'
        + ')'
    },
    {
      sql: 'create table if not exists state_audit ('
        + ' id integer primary key autoincrement,'
        + ' key text not null,'
        + ' value text not null,'
        + ' written_at text not null'
        + ')'
    },
    {
      sql: 'create trigger if not exists app_state_audit_insert'
        + ' after insert on app_state'
        + ' begin'
        + ' insert into state_audit (key, value, written_at) values (new.key, new.value, new.updated_at);'
        + ' end'
    },
    {
      sql: 'create trigger if not exists app_state_audit_update'
        + ' after update on app_state'
        + ' begin'
        + ' insert into state_audit (key, value, written_at) values (new.key, new.value, new.updated_at);'
        + ' end'
    }
  ]);

  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true };
}

module.exports = {
  resolveEndpoint,
  readState,
  writeState,
  createSchema
};
```

- [ ] **Step 19: テストと lint を実行する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/store.test.js && npm run lint`
Expected: PASS（18件）、lint はエラーなし

- [ ] **Step 20: コミット**

```bash
git add src/store.js tests/store.test.js
git commit -m "feat: Tursoのスキーマ作成を追加する(移行スクリプト専用)"
```

---

### Task 2: `src/data.js` をファイルから Turso に差し替える

**Files:**
- Modify: `src/data.js`（先頭の `fs` / `path` / `DATA_DIR` / `DATA_FILE`、`loadPreviousData`、`saveData`）
- Modify: `tests/data.test.js`（実ファイル I/O 前提の箇所）

**Interfaces:**
- Consumes: `readState` / `writeState`（Task 1）
- Produces:
  - `loadPreviousData() => Promise<{success: true, data: Array} | {success: false, uninitialized?: true, error: string}>`
  - `saveData(users: Array) => Promise<{success: true} | {success: false, error: string}>`
  - `compareData` / `compareMissionDetails` は変更なし

- [ ] **Step 1: 現在のテストがファイル I/O に依存している箇所を確認する**

Run: `grep -n "DATA_FILE\|writeFile\|readFile\|mkdir\|rm(" tests/data.test.js`

このタスクではこれらを store のモックに置き換える。

- [ ] **Step 2: 失敗するテストを書く**

`tests/data.test.js` の先頭付近（`require('../src/data')` より前）に store モックの注入ヘルパーを追加する。

```js
// src/data.js はトップレベルで store を require しているため、
// require.cache にモックを注入してからモジュールをロードする
// (tests/index.test.js と同じ方式)。
function resolveModule(p) {
  return require.resolve(p);
}

const MODULE_PATHS = ['../src/data', '../src/store'];

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
      createSchema: async () => ({ success: true })
    }
  };

  return { dataModule: require('../src/data'), writes };
}
```

そして新しい describe ブロックを追加する。

```js
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
});
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/data.test.js`
Expected: FAIL（`state=uninitialized` などが未実装のため）

- [ ] **Step 4: `src/data.js` を差し替える**

先頭の import と定数を置き換える。

```js
const { readState, writeState } = require('./store');

// Turso上のキー。1キー = 1JSONドキュメント
const STATE_KEY = 'mission_data';
```

（`const fs = require('fs').promises;` / `const path = require('path');` / `DATA_DIR` / `DATA_FILE` の4行を削除する）

`loadPreviousData` を置き換える。

```js
async function loadPreviousData() {
  const stateResult = await readState(STATE_KEY);

  if (!stateResult.success) {
    return { success: false, error: `データ読み込みエラー: ${stateResult.error}` };
  }

  // 移行前(app_stateテーブルなし)。初回実行と区別できるようフラグを立てる
  if (stateResult.state === 'uninitialized') {
    return {
      success: false,
      uninitialized: true,
      error: 'ミッションデータの保存先(Turso)が未初期化です。移行ワークフローを実行してください'
    };
  }

  // 初回実行(キーがまだ無い)
  if (stateResult.state === 'empty') {
    return { success: true, data: [] };
  }

  try {
    const jsonData = JSON.parse(stateResult.value);

    const version = jsonData.version || '1.0';
    let users = jsonData.users || [];

    if (version === '1.0') {
      // v1.0 → v2.0 自動マイグレーション
      users = migrateDataV1toV2(users);
    } else if (version !== '2.0') {
      return {
        success: false,
        error: `未知のデータバージョン: ${version}`
      };
    }

    return { success: true, data: users };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { success: false, error: `JSONパースエラー: ${error.message}` };
    }
    return { success: false, error: `データ読み込みエラー: ${error.message}` };
  }
}
```

`saveData` を置き換える。

```js
async function saveData(data) {
  if (!Array.isArray(data)) {
    return {
      success: false,
      error: '不正なデータ形式: 配列である必要があります'
    };
  }

  const saveObject = {
    version: '2.0',
    timestamp: new Date().toISOString(),
    users: data
  };

  // DBに入れるためインデントは付けない(監査テーブルの行サイズも小さくなる)
  const writeResult = await writeState(STATE_KEY, JSON.stringify(saveObject));

  if (!writeResult.success) {
    return { success: false, error: `データ保存エラー: ${writeResult.error}` };
  }

  return { success: true };
}
```

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/data.test.js`
Expected: 新しい describe は PASS。**旧テストのうち実ファイルを読み書きしていたものは FAIL する**

- [ ] **Step 6: 旧テストのファイル I/O 依存を削除する**

Step 2 で追加した describe が同じ振る舞いをすべてカバーしているため、ファイル I/O 前提の旧テストは**書き換えずに削除して一本化する**。削除対象は次のとおり。

`describe('loadPreviousData() - 前回データ取得')` ブロックを丸ごと削除する。含まれるテスト:

- 「正常系: 有効なJSONファイルからデータを読み込める」→ 新「v2.0のJSONを読み出してusersを返す」でカバー
- 「正常系: ファイルが存在しない場合、空配列を返す」→ 新「state=empty なら空配列を返す(初回実行)」でカバー
- 「正常系: 空のusers配列の場合、空配列を返す」→ 新「v2.0のJSONを読み出してusersを返す」の派生。念のため新 describe に1件追加する（下記）
- 「異常系: 不正なJSON形式の場合、エラーを返す」→ 新「壊れたJSONはパースエラーとして返す」でカバー
- 「異常系: ファイル読み込みエラー時、エラーを返す」→ 新「読み出しの失敗はそのままエラーとして返す」でカバー

`describe('saveData() - 新データ保存')` ブロックを丸ごと削除する。含まれるテスト:

- 「正常系: 不正なデータ形式の場合、エラーを返す」→ 新「saveDataは配列以外を拒否する」でカバー
- 「正常系: データをJSON形式でファイルに保存できる」→ 新「saveDataはmission_dataキーに整形なしJSONを書く」でカバー
- 「正常系: 空配列も保存できる」→ 新 describe に1件追加する（下記）
- 「正常系: タイムスタンプがISO 8601形式であること」→ 新「saveDataはmission_dataキーに整形なしJSONを書く」でカバー
- 「異常系: ファイル書き込みエラー時、エラーを返す」→ 新「書き込みの失敗はエラーとして返す」でカバー

ファイル冒頭の `const fs = require('fs').promises;` と `const path = require('path');`、`testDataDir` / `testDataFile` の定義、および外側 describe 直下の `beforeEach` / `afterEach`（`fs.mkdir` / `fs.unlink` を行っているもの）を削除する。

カバーが薄くなる2件を新 describe に足す。

```js
  it('users が空配列のJSONも空配列として読み出す', async () => {
    const stored = JSON.stringify({ version: '2.0', timestamp: '2026-08-27T00:00:00.000Z', users: [] });
    const { dataModule } = loadDataWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await dataModule.loadPreviousData();

    assert.deepStrictEqual(result, { success: true, data: [] });
  });

  it('空配列も保存できる', async () => {
    const { dataModule, writes } = loadDataWithStore();

    const result = await dataModule.saveData([]);

    assert.deepStrictEqual(result, { success: true });
    assert.deepStrictEqual(JSON.parse(writes[0].value).users, []);
  });
```

`compareData` / `compareMissionDetails` のテストは純粋関数なので変更しない。`mock` を import しているが使わなくなる場合は import からも外す（`oxlint` が未使用変数を警告する）。

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/data.test.js`
Expected: PASS（全件）

- [ ] **Step 7: 全テストと lint を実行する**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run lint`
Expected: fail 0。`tests/index.test.js` は `../src/data` 自体を require.cache でモックしているため `src/data.js` がロードされず、`store` の差し替えは影響しない。もし落ちる場合は Task 4 Step 1 の `MODULE_PATHS` への `../src/store` 追加を先に行う

- [ ] **Step 8: コミット**

```bash
git add src/data.js tests/data.test.js
git commit -m "feat: ミッションデータの永続化をTursoに移す"
```

---

### Task 3: `src/streak.js` をファイルから Turso に差し替える

**Files:**
- Modify: `src/streak.js`（先頭の `fs` / `path` / `DATA_DIR` / `STREAK_FILE`、`loadStreakData`、`saveStreakData`）
- Modify: `tests/streak.test.js`（実ファイル I/O 前提の箇所）

**Interfaces:**
- Consumes: `readState` / `writeState`（Task 1）
- Produces:
  - `loadStreakData() => Promise<{success: true, data: object} | {success: false, uninitialized?: true, error: string}>`
  - `saveStreakData(streakUsers: object) => Promise<{success: true} | {success: false, error: string}>`
  - 純粋関数（`confirmDay` / `replayStreak` / `updateStreaksByCourse` など）は変更なし

- [ ] **Step 1: 失敗するテストを書く**

`tests/streak.test.js` に、Task 2 と同じ方式の store モックヘルパーと describe を追加する。

```js
function resolveStreakModule(p) {
  return require.resolve(p);
}

const STREAK_MODULE_PATHS = ['../src/streak', '../src/store'];

function clearStreakModuleCache() {
  for (const p of STREAK_MODULE_PATHS) {
    try { delete require.cache[resolveStreakModule(p)]; } catch {}
  }
}

/**
 * storeをモックしてsrc/streak.jsをロードする
 *
 * @param {object} overrides - readState / writeState の差し替え
 * @returns {{streakModule: object, writes: Array<{key: string, value: string}>}}
 */
function loadStreakWithStore(overrides = {}) {
  clearStreakModuleCache();
  const writes = [];

  require.cache[resolveStreakModule('../src/store')] = {
    id: resolveStreakModule('../src/store'),
    filename: resolveStreakModule('../src/store'),
    loaded: true,
    exports: {
      readState: overrides.readState || (async () => ({ success: true, state: 'empty', value: null })),
      writeState: overrides.writeState || (async (key, value) => {
        writes.push({ key, value });
        return { success: true };
      }),
      resolveEndpoint: () => 'https://test-db.turso.io/v2/pipeline',
      createSchema: async () => ({ success: true })
    }
  };

  return { streakModule: require('../src/streak'), writes };
}

describe('ストリークモジュール - Turso永続化', () => {
  afterEach(() => {
    clearStreakModuleCache();
  });

  it('state=empty なら空マップを返す(初回実行)', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'empty', value: null })
    });

    const result = await streakModule.loadStreakData();

    assert.deepStrictEqual(result, { success: true, data: {} });
  });

  it('state=uninitialized なら uninitialized フラグ付きで失敗を返す(移行前)', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'uninitialized', value: null })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.uninitialized, true);
    assert.match(result.error, /未初期化/);
  });

  it('streak_data キーで読み出す', async () => {
    const readKeys = [];
    const { streakModule } = loadStreakWithStore({
      readState: async (key) => {
        readKeys.push(key);
        return { success: true, state: 'empty', value: null };
      }
    });

    await streakModule.loadStreakData();

    assert.deepStrictEqual(readKeys, ['streak_data']);
  });

  it('v1.4のデータをそのまま読み出す', async () => {
    const stored = JSON.stringify({
      version: '1.4',
      timestamp: '2026-08-27T00:00:00.000Z',
      users: {
        'たろう': {
          streak: 5, grace: 2, bonus: 1, course: 'elementary',
          lastConfirmedDate: '2026-08-26', exemptDates: [], history: { '2026-08-26': true },
          replayBase: { streak: 0, grace: 1, date: null }
        }
      }
    });
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['たろう'].streak, 5);
    assert.strictEqual(result.data['たろう'].bonus, 1);
  });

  it('v1.2以前のデータはおたすけ満タンと免除日フィールドを補って読み出す', async () => {
    const stored = JSON.stringify({
      version: '1.2',
      users: { 'はなこ': { streak: 3, grace: 0, bonus: 0, lastConfirmedDate: '2026-08-20' } }
    });
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['はなこ'].grace, 3, '1.3移行でおたすけが満タンになること');
    assert.deepStrictEqual(result.data['はなこ'].exemptDates, [], '1.4移行でexemptDatesが補われること');
    assert.deepStrictEqual(result.data['はなこ'].history, {});
  });

  it('未知のバージョンは失敗として返す', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: JSON.stringify({ version: '9.9', users: {} }) })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /未知のストリークデータバージョン/);
  });

  it('壊れたJSONはパースエラーとして返す', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: 'not json' })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /JSONパースエラー/);
  });

  it('saveStreakDataはstreak_dataキーに整形なしJSONを書く', async () => {
    const { streakModule, writes } = loadStreakWithStore();

    const result = await streakModule.saveStreakData({ 'じろう': { streak: 1, grace: 1, bonus: 0 } });

    assert.deepStrictEqual(result, { success: true });
    assert.strictEqual(writes[0].key, 'streak_data');
    assert.ok(!writes[0].value.includes('\n'), '整形せず1行で保存すること');

    const saved = JSON.parse(writes[0].value);
    assert.strictEqual(saved.version, '1.4');
    assert.strictEqual(saved.users['じろう'].streak, 1);
  });

  it('saveStreakDataはオブジェクト以外を拒否する', async () => {
    const { streakModule, writes } = loadStreakWithStore();

    const result = await streakModule.saveStreakData([]);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /オブジェクト/);
    assert.strictEqual(writes.length, 0, '検証に失敗したら書き込まないこと');
  });

  it('書き込みの失敗はエラーとして返す', async () => {
    const { streakModule } = loadStreakWithStore({
      writeState: async () => ({ success: false, error: 'SQL エラー: no such table: app_state' })
    });

    const result = await streakModule.saveStreakData({});

    assert.strictEqual(result.success, false);
    assert.match(result.error, /no such table/);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: FAIL

- [ ] **Step 3: `src/streak.js` を差し替える**

先頭の import と定数を置き換える（`const fs = require('fs').promises;` / `const path = require('path');` / `DATA_DIR` / `STREAK_FILE` の4行を削除）。

```js
const { readState, writeState } = require('./store');

// Turso上のキー。1キー = 1JSONドキュメント
const STATE_KEY = 'streak_data';
```

`loadStreakData` を置き換える。バージョン移行のロジック（1.3 のおたすけチャージ、1.4 の免除日フィールド補完）は**一字も変えない**。

```js
async function loadStreakData() {
  const stateResult = await readState(STATE_KEY);

  if (!stateResult.success) {
    return { success: false, error: `ストリークデータ読み込みエラー: ${stateResult.error}` };
  }

  // 移行前(app_stateテーブルなし)。空マップと区別しないと、確定処理が
  // 全ユーザーを新規扱いして連続日数を0にリセットしてしまう
  if (stateResult.state === 'uninitialized') {
    return {
      success: false,
      uninitialized: true,
      error: 'ストリークデータの保存先(Turso)が未初期化です。移行ワークフローを実行してください'
    };
  }

  // 初回実行(キーがまだ無い)
  if (stateResult.state === 'empty') {
    return { success: true, data: {} };
  }

  try {
    const jsonData = JSON.parse(stateResult.value);

    const version = jsonData.version || '1.0';
    if (!['1.0', '1.1', '1.2', '1.3', '1.4'].includes(version)) {
      return {
        success: false,
        error: `未知のストリークデータバージョン: ${version}`
      };
    }

    const users = jsonData.users || {};

    // 〜1.2 → 1.3 移行: 全ユーザーのおたすけを満タン(3)にする一度きりのチャージ。
    // (v1.2の初回チャージは小学生ユーザーがファイル未登録の時点で発火したため再適用。
    //  旧1.0→1.1移行もこの移行に包含される)
    // 1.3以降のデータには適用しない(再チャージしてしまうため)
    if (!['1.3', '1.4'].includes(version)) {
      Object.values(users).forEach(state => {
        state.grace = GRACE_MAX;
      });
    }

    // 〜1.3 → 1.4 移行: 免除日機能のフィールドを補う。
    // history は空から始まるため、移行より前の日は遡及免除できない(設計どおりの割り切り)
    if (version !== '1.4') {
      Object.values(users).forEach(state => {
        state.exemptDates = state.exemptDates || [];
        state.history = state.history || {};
        state.replayBase = state.replayBase || {
          streak: state.streak ?? 0,
          grace: state.grace ?? GRACE_INITIAL,
          date: state.lastConfirmedDate ?? null
        };
      });
    }

    return { success: true, data: users };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { success: false, error: `JSONパースエラー: ${error.message}` };
    }
    return { success: false, error: `ストリークデータ読み込みエラー: ${error.message}` };
  }
}
```

`saveStreakData` を置き換える。

```js
async function saveStreakData(streakUsers) {
  if (typeof streakUsers !== 'object' || streakUsers === null || Array.isArray(streakUsers)) {
    return {
      success: false,
      error: '不正なデータ形式: オブジェクトである必要があります'
    };
  }

  const saveObject = {
    version: '1.4',
    timestamp: new Date().toISOString(),
    users: streakUsers
  };

  // DBに入れるためインデントは付けない
  const writeResult = await writeState(STATE_KEY, JSON.stringify(saveObject));

  if (!writeResult.success) {
    return { success: false, error: `ストリークデータ保存エラー: ${writeResult.error}` };
  }

  return { success: true };
}
```

- [ ] **Step 4: テストを実行する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: 新しい describe は PASS。旧テストのうち実ファイルを使っていたものは FAIL

- [ ] **Step 5: 旧テストのファイル I/O 依存を削除する**

`describe('loadStreakData / saveStreakData')` ブロック（`tests/streak.test.js` の 320行目付近から始まる）を**丸ごと削除して、Step 1 で追加した describe に一本化する**。旧ブロックの各テストは新 describe が同等以上にカバーしている。

- 「ファイルがない場合は空マップ」→ 新「state=empty なら空マップを返す(初回実行)」
- 「保存して読み戻せる」→ 新「saveStreakDataはstreak_dataキーに整形なしJSONを書く」＋「v1.4のデータをそのまま読み出す」
- 「バージョン移行（1.0 / 1.1 / 1.2 / 1.3）」→ 新「v1.2以前のデータはおたすけ満タンと免除日フィールドを補って読み出す」
- 「壊れたJSON」→ 新「壊れたJSONはパースエラーとして返す」
- 「未知のバージョン」→ 新「未知のバージョンは失敗として返す」

旧ブロックにあってカバーが薄くなるバージョンがあれば、新 describe に `readState` が返す JSON の `version` を変えたテストを追加する（`'1.0'` / `'1.1'` / `'1.3'` について、`grace` と `exemptDates` / `history` / `replayBase` の補完結果を確認する）。

あわせてファイル冒頭の `fs` / `path` の import と `DATA_DIR` / `STREAK_FILE` の定義を削除する。

純粋関数（`confirmDay` / `confirmDayWithHistory` / `replayStreak` / `pruneHistory` / `collapseHistory` / `updateStreaks` / `updateStreaksByCourse` / `formatStreakInfo` / `settleBonuses` / `isStudied` / `countStudyItems`）のテストは変更しない。

Run: `grep -n "fs\.\|DATA_DIR\|STREAK_FILE" tests/streak.test.js`
Expected: 出力なし

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: PASS（全件）

- [ ] **Step 6: 運用スクリプトがそのまま動くことを確認する**

`scripts/show-streak-data.js` / `scripts/set-streak-field.js` / `scripts/set-exempt-dates.js` は `src/streak.js` の `loadStreakData` / `saveStreakData` 経由なので、コード変更は不要。`.env` の Turso 設定を読み込んでローカルから実データを表示できることを確認する。

Run: `node -r dotenv/config scripts/show-streak-data.js`
Expected: この時点では Turso が未初期化なので `読み込みエラー: ... 未初期化です。移行ワークフローを実行してください` と表示され、終了コード1になる。**これが期待どおりの挙動**（移行前だと分かる）

- [ ] **Step 7: lint を実行してコミット**

Run: `npm run lint`

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: ストリークデータの永続化をTursoに移す"
```

---

### Task 4: 夜通知の未初期化分岐

**Files:**
- Modify: `src/index.js`（ストリークデータ読み込みの直後）
- Modify: `tests/index.test.js`（`MODULE_PATHS` と store モックの追加、未初期化のテスト）

**Interfaces:**
- Consumes: `loadStreakData` の `uninitialized` フラグ（Task 3）
- Produces: なし（エントリポイント）

- [ ] **Step 1: `tests/index.test.js` の `MODULE_PATHS` に store を追加する**

CLAUDE.md の Testing Patterns にあるとおり、`src/index.js` の依存に新しいモジュールが増えたら `MODULE_PATHS` への追加が必須。`src/index.js` は `store` を直接 require しないが、`../src/data` と `../src/streak` が require するため、キャッシュのクリア対象に含める。

```js
const MODULE_PATHS = [
  '../src/index', '../src/config', '../src/auth',
  '../src/crawler', '../src/data', '../src/notifier', '../src/broadcast', '../src/streak', '../src/store', 'playwright'
];
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/index.test.js` の「ストリーク統合」describe の中に追加する。

```js
    it('Turso未初期化のときは通知を出しつつ終了コード1にする', async () => {
      setupMocks({
        loadStreakData: async () => {
          callLog.push({ type: 'loadStreakData' });
          return {
            success: false,
            uninitialized: true,
            error: 'ストリークデータの保存先(Turso)が未初期化です。移行ワークフローを実行してください'
          };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 1,
        '未初期化でも通知は送ること'
      );
      assert.strictEqual(result.exitCode, 1, '移行前だと気づけるよう赤くすること');
      assert.ok(
        result.errors.some(error => /未初期化/.test(error)),
        'errorsに未初期化の理由を積むこと'
      );
    });

    it('通常の読み取り失敗は従来どおり警告のみで正常終了する', async () => {
      setupMocks({
        loadStreakData: async () => {
          callLog.push({ type: 'loadStreakData' });
          return { success: false, error: 'タイムアウト: Turso が10000ms以内に応答しませんでした' };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 1,
        '通知は送ること'
      );
      assert.strictEqual(result.exitCode, 0, '一時的な障害でワークフローを赤くしないこと');
    });
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`
Expected: 1件目が FAIL（`exitCode` が 0 のまま）

- [ ] **Step 4: `src/index.js` に分岐を足す**

現在のコード:

```js
    const streakLoadResult = await loadStreakData();
    if (!streakLoadResult.success) {
      // 免除日が分からなくても通知は続ける(免除なし扱い)。子供に見える情報を止めないため
      console.warn('⚠️ ストリークデータを読めなかったため免除日なしとして続行します:', streakLoadResult.error);
    }
```

置き換え後:

```js
    const streakLoadResult = await loadStreakData();
    if (!streakLoadResult.success) {
      // 免除日が分からなくても通知は続ける(免除なし扱い)。子供に見える情報を止めないため
      console.warn('⚠️ ストリークデータを読めなかったため免除日なしとして続行します:', streakLoadResult.error);

      // 未初期化(Tursoへの移行が未完了)は一時的な障害ではなく設定漏れなので、
      // 気づけるように赤くする。通常の読み取り失敗は従来どおり警告だけで流す
      if (streakLoadResult.uninitialized) {
        errors.push(streakLoadResult.error);
      }
    }
```

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`
Expected: PASS（全件）

- [ ] **Step 6: lint を実行してコミット**

Run: `npm run lint`

```bash
git add src/index.js tests/index.test.js
git commit -m "feat: 夜通知でTurso未初期化を検知して赤くする"
```

---

### Task 5: 朝通知の未初期化スキップと `morning-index.test.js` の本格化

**Files:**
- Modify: `src/morning-index.js`（ストリーク確定ブロック）
- Modify: `tests/morning-index.test.js`（13行 → `require.cache` 注入方式に書き換え）

**Interfaces:**
- Consumes: `loadStreakData` の `uninitialized` フラグ（Task 3）
- Produces: なし（エントリポイント）

`tests/morning-index.test.js` は現在 `main` のエクスポート確認のみで、確定処理のテストがない。今回変更するのがその永続化経路そのものなので、このタスクでテストを立てる。

- [ ] **Step 1: `tests/morning-index.test.js` を書き換えて失敗するテストを作る**

ファイル全体を置き換える。

```js
/**
 * 朝通知エントリポイントのテスト
 *
 * src/morning-index.js はトップレベルで依存モジュールを require しているため、
 * require.cache にモックを注入してからモジュールをロードする方式でテストする。
 * (tests/index.test.js と同じ方式)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

function resolveModule(p) {
  return require.resolve(p);
}

const MODULE_PATHS = [
  '../src/morning-index', '../src/config', '../src/auth', '../src/crawler',
  '../src/notifier', '../src/broadcast', '../src/streak', '../src/store', 'playwright'
];

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    try { delete require.cache[resolveModule(p)]; } catch {}
  }
}

const { getDiscordFailure: realGetDiscordFailure } = require('../src/broadcast');
const { truncateToLimit: realTruncateToLimit } = require('../src/notifier');

describe('朝通知エントリポイント (src/morning-index.js)', () => {
  let morningModule;
  let callLog;

  function setupMocks(overrides = {}) {
    callLog = [];
    clearModuleCache();

    const mockPage = { screenshot: async () => {}, goto: async () => {} };
    const mockContext = { close: async () => {} };
    const mockBrowser = { close: async () => {} };

    const crawlResult = overrides.crawlResult || {
      success: true,
      partialFailure: false,
      data: [
        { userName: 'たろう', course: 'elementary', studyItemCount: 4, missionCount: 4, date: '2026-08-26', studyTime: { hours: 0, minutes: 30 }, totalScore: 300, missions: [] }
      ]
    };

    require.cache[resolveModule('playwright')] = {
      id: resolveModule('playwright'), filename: resolveModule('playwright'), loaded: true,
      exports: { chromium: { launch: async () => mockBrowser } }
    };

    require.cache[resolveModule('../src/config')] = {
      id: resolveModule('../src/config'), filename: resolveModule('../src/config'), loaded: true,
      exports: {
        loadConfig: overrides.loadConfig || (() => ({
          SMILEZEMI_USERNAME: 'u', SMILEZEMI_PASSWORD: 'p',
          LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_USER_ID: 'g'
        })),
        maskSensitiveData: (value) => value
      }
    };

    require.cache[resolveModule('../src/auth')] = {
      id: resolveModule('../src/auth'), filename: resolveModule('../src/auth'), loaded: true,
      exports: { login: async () => ({ success: true, page: mockPage, context: mockContext }) }
    };

    require.cache[resolveModule('../src/crawler')] = {
      id: resolveModule('../src/crawler'), filename: resolveModule('../src/crawler'), loaded: true,
      exports: {
        getAllUsersDetailedData: overrides.getAllUsersDetailedData || (async () => crawlResult),
        getUserList: async () => ({ success: true, users: [{ name: 'たろう', index: 0 }] }),
        getTargetDates: () => ({ dateString: '2026-08-26', withPadding: '08/26' })
      }
    };

    require.cache[resolveModule('../src/notifier')] = {
      id: resolveModule('../src/notifier'), filename: resolveModule('../src/notifier'), loaded: true,
      exports: {
        formatDetailedMessage: overrides.formatDetailedMessage || ((userData, changes, options) => {
          callLog.push({ type: 'formatDetailedMessage', options });
          return 'テスト朝メッセージ';
        }),
        truncateToLimit: realTruncateToLimit
      }
    };

    require.cache[resolveModule('../src/broadcast')] = {
      id: resolveModule('../src/broadcast'), filename: resolveModule('../src/broadcast'), loaded: true,
      exports: {
        broadcastToAll: overrides.broadcastToAll || (async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        }),
        getDiscordFailure: realGetDiscordFailure,
        LINE_MAX_MESSAGE_LENGTH: 5000,
        DISCORD_MAX_MESSAGE_LENGTH: 2000
      }
    };

    require.cache[resolveModule('../src/streak')] = {
      id: resolveModule('../src/streak'), filename: resolveModule('../src/streak'), loaded: true,
      exports: {
        loadStreakData: overrides.loadStreakData || (async () => {
          callLog.push({ type: 'loadStreakData' });
          return { success: true, data: {} };
        }),
        saveStreakData: overrides.saveStreakData || (async () => {
          callLog.push({ type: 'saveStreakData' });
          return { success: true };
        }),
        updateStreaksByCourse: overrides.updateStreaksByCourse || (() => {
          callLog.push({ type: 'updateStreaksByCourse' });
          return {
            streakUsers: { 'たろう': { streak: 1, grace: 1, bonus: 0 } },
            results: [{ userName: 'たろう', state: { streak: 1, grace: 1, bonus: 0 }, event: 'none' }]
          };
        }),
        formatStreakInfo: () => 'テストストリーク情報',
        STREAK_REQUIREMENTS: { elementaryMissions: 4, juniorHighCourses: 3 },
        getJuniorHighRequirement: () => 3
      }
    };

    morningModule = require('../src/morning-index');
  }

  beforeEach(() => {
    setupMocks();
  });

  afterEach(() => {
    clearModuleCache();
  });

  it('main 関数をエクスポートしている', () => {
    assert.strictEqual(typeof morningModule.main, 'function');
  });

  it('正常系: ストリークを確定して保存し、通知を送る', async () => {
    const result = await morningModule.main();

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(callLog.filter(c => c.type === 'updateStreaksByCourse').length, 1, '確定処理を行うこと');
    assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 1, '保存すること');
    assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 1, '通知を送ること');
  });

  it('Turso未初期化のときは確定処理をスキップして通知だけ出す', async () => {
    setupMocks({
      loadStreakData: async () => {
        callLog.push({ type: 'loadStreakData' });
        return {
          success: false,
          uninitialized: true,
          error: 'ストリークデータの保存先(Turso)が未初期化です。移行ワークフローを実行してください'
        };
      }
    });

    const result = await morningModule.main();

    assert.strictEqual(
      callLog.filter(c => c.type === 'updateStreaksByCourse').length, 0,
      '空データで確定すると連続日数が0にリセットされるためスキップすること'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'saveStreakData').length, 0,
      '未初期化のまま保存しないこと'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'broadcastToAll').length, 1,
      '通知は送ること'
    );
    assert.strictEqual(result.exitCode, 1, '移行前だと気づけるよう赤くすること');
  });

  it('Turso未初期化のときはストリーク行を出さない', async () => {
    setupMocks({
      loadStreakData: async () => ({ success: false, uninitialized: true, error: '未初期化です' })
    });

    await morningModule.main();

    const formatCall = callLog.find(c => c.type === 'formatDetailedMessage');
    assert.ok(formatCall, 'formatDetailedMessageが呼ばれること');
    assert.strictEqual(formatCall.options.streaks, null, 'ストリーク行を出さないこと');
    assert.deepStrictEqual(formatCall.options.exemptUserNames, [], '免除日も空にすること');
  });

  it('通常の読み取り失敗でも確定処理をスキップする(空状態での上書きを防ぐ)', async () => {
    setupMocks({
      loadStreakData: async () => {
        callLog.push({ type: 'loadStreakData' });
        return { success: false, error: 'タイムアウト: Turso が10000ms以内に応答しませんでした' };
      }
    });

    const result = await morningModule.main();

    assert.strictEqual(
      callLog.filter(c => c.type === 'updateStreaksByCourse').length, 0,
      '一時的な障害でも空データで確定してはならない(streak/grace/bonusを上書きしてしまう)'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'saveStreakData').length, 0,
      '読めなかったデータを上書き保存しないこと'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'broadcastToAll').length, 1,
      '通知は送ること'
    );
    assert.strictEqual(result.exitCode, 1, '読み取り失敗はerrorsに積まれるため赤くなること');
  });

  it('保存失敗は通知を出したうえで終了コード1にする', async () => {
    setupMocks({
      saveStreakData: async () => {
        callLog.push({ type: 'saveStreakData' });
        return { success: false, error: 'ストリークデータ保存エラー: SQL エラー' };
      }
    });

    const result = await morningModule.main();

    assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 1, '通知は送ること');
    assert.strictEqual(result.exitCode, 1);
  });

  it('ドライランでは保存も送信もしない', async () => {
    const original = process.env.DRY_RUN;
    process.env.DRY_RUN = 'true';
    setupMocks();

    try {
      const result = await morningModule.main();

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 0);
    } finally {
      if (original === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = original;
    }
  });

  it('免除日のユーザーはexemptUserNamesとして渡る', async () => {
    setupMocks({
      updateStreaksByCourse: () => ({
        streakUsers: { 'はなこ': { streak: 5, grace: 3, bonus: 0 } },
        results: [{ userName: 'はなこ', state: { streak: 5, grace: 3, bonus: 0 }, event: 'exempt' }]
      })
    });

    await morningModule.main();

    const formatCall = callLog.find(c => c.type === 'formatDetailedMessage');
    assert.deepStrictEqual(formatCall.options.exemptUserNames, ['はなこ']);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/morning-index.test.js`
Expected: FAIL。未初期化のテストで `updateStreaksByCourse` が呼ばれてしまう

- [ ] **Step 3: `src/morning-index.js` に分岐を足す**

現在のコード（`// 4.5 ストリーク(連続学習日数)の確定判定` から `const exemptUserNames = ...` の終わりまで）を置き換える。

```js
    // 4.5 ストリーク(連続学習日数)の確定判定
    // 前日分は確定データのため、そのままストリークを確定する
    let streaks = null;
    let exemptUserNames = [];
    console.log('🔥 ストリークを更新しています...');
    const streakLoadResult = await loadStreakData();

    if (!streakLoadResult.success) {
      // 読み込めなかったときは理由を問わず確定処理そのものを行わない。
      // 空データで確定すると全ユーザーが新規扱いになり、streak / grace / bonus を
      // 上書き保存して恒久的に失う(bonus は実際に支給するお小遣いで復元手段がない)。
      // 未判定の日は中立扱い(ペナルティなし)なので、スキップしても子供は損をしない。
      // 通知はストリーク行なしで出し、終了コード1で気づけるようにする。
      // 移行前(uninitialized)も一過性のネットワーク障害もこの経路に入る
      console.error('❌ ストリークデータを読み込めなかったため、確定処理をスキップします:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
    } else {
      const previousStreakUsers = streakLoadResult.data;

      // 前日は確定データ。コース別しきい値で確定する(小学生4 / 中学生3)
      const { streakUsers, results } = updateStreaksByCourse(
        previousStreakUsers,
        crawlResult.data,
        targetDates.dateString
      );

      streaks = {};
      results.forEach(result => {
        streaks[result.userName] = formatStreakInfo(result);
      });

      // 免除日のユーザーには未達警告を出さない(ストリーク行が「記録はそのまま」と伝える)
      exemptUserNames = results
        .filter(result => result.event === 'exempt')
        .map(result => result.userName);

      // ドライラン時は状態を書き換えない(再実行で二重判定になるのを防ぐ)
      if (process.env.DRY_RUN === 'true') {
        console.log('ℹ️ ドライランモード: ストリークデータの保存はスキップしました');
      } else {
        const streakSaveResult = await saveStreakData(streakUsers);
        if (streakSaveResult.success) {
          console.log('✅ ストリークデータの保存が完了しました');
        } else {
          console.error('❌ ストリークデータの保存に失敗しました:', streakSaveResult.error);
          errors.push(streakSaveResult.error);
        }
      }
    }
```

`formatDetailedMessage` の呼び出しはそのままで良い（`streaks` が `null`、`exemptUserNames` が `[]` のとき、`notifier.js` は既にストリーク行と免除行を出さない）。

- [ ] **Step 4: ドライランの戻り値を確認する**

現在の朝通知はドライランで `return { success: true, exitCode: 0 }` を固定で返している。未初期化のときは `errors` に積んでも赤くならないが、ドライランは手動確認用なのでこのままにする。テストの「ドライランでは保存も送信もしない」は `exitCode: 0` を期待しているため整合している。

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/morning-index.test.js`
Expected: PASS（8件）

- [ ] **Step 6: 月次清算が未初期化で清算しないことをテストで固定する**

仕様では月次清算は変更不要（`loadStreakData` が `!success` を返せば既にエラー通知して異常終了する）だが、未初期化でその経路を通ることをテストで固定しておく。`tests/monthly-bonus-index.test.js` の既存のモック方式に合わせて1件追加する。

まず既存の「読み込み失敗」テストの書き方を確認する。

Run: `grep -n "loadStreakData" tests/monthly-bonus-index.test.js | head`

同じ形で追加する。

```js
    it('Turso未初期化のときは清算せずエラー通知を送って異常終了する', async () => {
      setupMocks({
        loadStreakData: async () => {
          callLog.push({ type: 'loadStreakData' });
          return {
            success: false,
            uninitialized: true,
            error: 'ストリークデータの保存先(Turso)が未初期化です。移行ワークフローを実行してください'
          };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(
        callLog.filter(c => c.type === 'saveStreakData').length, 0,
        'ボーナスをリセットしないこと(お金を配る処理なので中断する)'
      );
    });
```

`setupMocks` / `callLog` / `mainModule` の名前は既存ファイルの実装に合わせる。実装変更は不要なので、このテストは追加した時点で通る（既存の `!success` 分岐に乗るため）。**通ることを確認したうえで、その分岐が消えたら落ちることを一度手で確かめる**: `src/monthly-bonus-index.js` の `if (!streakLoadResult.success) {` を一時的に `if (false) {` に変えてテストが落ちるのを見て、元に戻す。

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: PASS

- [ ] **Step 7: 全テストと lint を実行する**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run lint`
Expected: fail 0、lint エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/morning-index.js tests/morning-index.test.js tests/monthly-bonus-index.test.js
git commit -m "feat: 朝通知でTurso未初期化なら確定処理をスキップする

移行前に空データで確定すると全ユーザーが新規扱いになり連続日数が0に
リセットされるため、確定そのものを行わずストリーク行なしで通知だけ出す。

あわせてtests/morning-index.test.jsをrequire.cache注入方式に書き換え、
確定・免除日・未初期化スキップ・保存失敗・ドライランをカバーする
(従来はmainのエクスポート確認のみだった)。"
```

---

### Task 6: 設定の配線

**Files:**
- Modify: `src/config.js`（`REQUIRED_SECRETS`、`loadConfig` のデバッグ出力と戻り値）
- Modify: `scripts/validate-env.js`（`REQUIRED_ENV_VARS`）
- Modify: `docker-compose.yml`（`environment`、`volumes`）
- Modify: `Dockerfile`（`mkdir`）
- Modify: `tests/config.test.js`

**Interfaces:**
- Consumes: なし
- Produces: `loadConfig()` の戻り値に `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` が加わる

- [ ] **Step 1: 失敗するテストを書く**

`tests/config.test.js` は外側の `describe('環境変数管理')` で `beforeEach` に `originalEnv = { ...process.env }`、`afterEach` に `process.env = originalEnv` を持ち、各テストが必要な変数を個別にセットする方式になっている。この方式に合わせ、新しいテストは自分で必要な環境変数を全部セットする。

**先に既存テストを直す。** `REQUIRED_SECRETS` に2つ足すと、必須変数を4つだけセットしている既存の成功テストが例外を投げて落ちる。次のテストに2行を追加する。

- `describe('loadConfig')` の「全ての必須環境変数が存在する場合、設定オブジェクトを返す」
- 同 describe 内で `loadConfig()` が成功することを前提にしている他のテスト（`grep -n "loadConfig()" tests/config.test.js` で洗い出す）

```js
      process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
      process.env.TURSO_AUTH_TOKEN = 'test-auth-token';
```

そのうえで新しい describe を追加する。

```js
  describe('Turso設定', () => {
    /** 必須環境変数をすべてセットする(このファイルの他テストと同じ方式) */
    function setAllRequired() {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
      process.env.TURSO_AUTH_TOKEN = 'test-auth-token';
    }

    it('TURSO_DATABASE_URL が未設定なら loadConfig が例外を投げる', () => {
      setAllRequired();
      delete process.env.TURSO_DATABASE_URL;

      assert.throws(() => loadConfig(), /TURSO_DATABASE_URL/);
    });

    it('TURSO_AUTH_TOKEN が未設定なら loadConfig が例外を投げる', () => {
      setAllRequired();
      delete process.env.TURSO_AUTH_TOKEN;

      assert.throws(() => loadConfig(), /TURSO_AUTH_TOKEN/);
    });

    it('loadConfig の戻り値に Turso の設定が含まれる', () => {
      setAllRequired();

      const result = loadConfig();

      assert.strictEqual(result.TURSO_DATABASE_URL, 'libsql://test-db.turso.io');
      assert.strictEqual(result.TURSO_AUTH_TOKEN, 'test-auth-token');
    });

    it('validateSecrets が Turso の2つを必須として扱う', () => {
      const result = validateSecrets({
        SMILEZEMI_USERNAME: 'u',
        SMILEZEMI_PASSWORD: 'p',
        LINE_CHANNEL_ACCESS_TOKEN: 't',
        LINE_USER_ID: 'g'
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.missing.includes('TURSO_DATABASE_URL'));
      assert.ok(result.missing.includes('TURSO_AUTH_TOKEN'));
    });

    it('maskSensitiveData が TURSO_AUTH_TOKEN の値を伏せる', () => {
      const masked = maskSensitiveData({
        TURSO_AUTH_TOKEN: 'eyJhbGciOi',
        TURSO_DATABASE_URL: 'libsql://x.turso.io'
      });

      assert.strictEqual(masked.TURSO_AUTH_TOKEN, '***');
      assert.strictEqual(masked.TURSO_DATABASE_URL, 'libsql://x.turso.io', 'URLは秘密ではないので伏せない');
    });
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/config.test.js`
Expected: FAIL

- [ ] **Step 3: `src/config.js` を変更する**

`REQUIRED_SECRETS` に2つ追加する。

```js
const REQUIRED_SECRETS = [
  'SMILEZEMI_USERNAME',
  'SMILEZEMI_PASSWORD',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_USER_ID',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN'
];
```

`loadConfig` のデバッグ出力に2行追加する（`DISCORD_WEBHOOK_URL` の行の直前）。

```js
    console.log(`  TURSO_DATABASE_URL: ${process.env.TURSO_DATABASE_URL ? '存在' : '未設定'}`);
    console.log(`  TURSO_AUTH_TOKEN: ${process.env.TURSO_AUTH_TOKEN ? `存在 (長さ: ${process.env.TURSO_AUTH_TOKEN.length})` : '未設定'}`);
```

`secrets` オブジェクトに2つ追加する。

```js
  const secrets = {
    SMILEZEMI_USERNAME: process.env.SMILEZEMI_USERNAME?.trim(),
    SMILEZEMI_PASSWORD: process.env.SMILEZEMI_PASSWORD?.trim(),
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim(),
    LINE_USER_ID: process.env.LINE_USER_ID?.trim(),
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL?.trim(),
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN?.trim()
  };
```

戻り値に2つ追加する。

```js
  return {
    SMILEZEMI_USERNAME: secrets.SMILEZEMI_USERNAME,
    SMILEZEMI_PASSWORD: secrets.SMILEZEMI_PASSWORD,
    LINE_CHANNEL_ACCESS_TOKEN: secrets.LINE_CHANNEL_ACCESS_TOKEN,
    LINE_USER_ID: secrets.LINE_USER_ID,
    TURSO_DATABASE_URL: secrets.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: secrets.TURSO_AUTH_TOKEN,
    DISCORD_WEBHOOK_URL: discordWebhookUrl || undefined
  };
```

`SENSITIVE_FIELDS` は既に `'token'` を含むため、`TURSO_AUTH_TOKEN`（小文字化して `turso_auth_token`）は `includes('token')` で一致する。`TURSO_DATABASE_URL` はどの語にも一致しないので伏せられない。**変更不要**。

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/config.test.js`
Expected: PASS

- [ ] **Step 5: `scripts/validate-env.js` を変更する**

```js
const REQUIRED_ENV_VARS = [
  'SMILEZEMI_USERNAME',
  'SMILEZEMI_PASSWORD',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_USER_ID',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN'
];
```

Run: `npm run validate:env`
Expected: 「すべての環境変数が正しく設定されています」（`.env` に Turso の2つが既に入っている）

- [ ] **Step 6: `docker-compose.yml` を変更する**

`volumes` から `./data:/app/data` の2行（コメント含む）を削除する。

```yaml
    volumes:
      # スクリーンショット保存
      - ./screenshots:/app/screenshots
      # ログ保存（オプション）
      - ./logs:/app/logs
      # デバッグ用: ソースコードとスクリプト
      - ./src:/app/src
      - ./scripts:/app/scripts
```

`environment` に2つ追加する。

```yaml
    environment:
      # .envから自動読み込み
      - SMILEZEMI_USERNAME
      - SMILEZEMI_PASSWORD
      - LINE_CHANNEL_ACCESS_TOKEN
      - LINE_USER_ID
      - DISCORD_WEBHOOK_URL
      - TURSO_DATABASE_URL
      - TURSO_AUTH_TOKEN
      - NODE_ENV=${NODE_ENV:-development}
```

- [ ] **Step 7: `Dockerfile` を変更する**

```dockerfile
RUN mkdir -p screenshots logs
```

- [ ] **Step 8: Docker ビルドが通ることを確認する**

Run: `npm run docker:build`
Expected: ビルド成功

- [ ] **Step 9: 全テストと lint を実行してコミット**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run lint && npm run validate:all`

```bash
git add src/config.js scripts/validate-env.js docker-compose.yml Dockerfile tests/config.test.js
git commit -m "feat: Tursoの接続情報を必須環境変数に加えdata/ボリュームを外す"
```

---

### Task 7: 移行スクリプトとワークフロー

**Files:**
- Create: `scripts/migrate-to-turso.js`
- Create: `.github/workflows/migrate-to-turso.yml`
- Create: `tests/migrate-to-turso.test.js`

**Interfaces:**
- Consumes: `createSchema` / `readState` / `writeState`（Task 1）
- Produces:
  - `parseArgs(argv: string[]) => Record<string, string|boolean>`
  - `maskUserName(name: string) => string`
  - `migrate(options: {force: boolean}) => Promise<{success: boolean, migrated: string[], skipped: string[], error?: string}>`

このスクリプトは使い捨てで、移行完了後（実施順の手順6）に削除する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/migrate-to-turso.test.js` を新規作成する。`scripts/set-exempt-dates.js` のテスト（`tests/set-exempt-dates.test.js`）と同じ方式に合わせる。

```js
/**
 * Turso移行スクリプトのテスト
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseArgs, maskUserName } = require('../scripts/migrate-to-turso');

describe('Turso移行スクリプト (scripts/migrate-to-turso.js)', () => {
  describe('parseArgs()', () => {
    it('--force をフラグとして解釈する', () => {
      assert.deepStrictEqual(parseArgs(['--force']), { force: true });
    });

    it('引数なしなら空オブジェクトを返す', () => {
      assert.deepStrictEqual(parseArgs([]), {});
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
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/migrate-to-turso.test.js`
Expected: FAIL（`Cannot find module '../scripts/migrate-to-turso'`）

- [ ] **Step 3: `scripts/migrate-to-turso.js` を実装する**

```js
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
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/migrate-to-turso.test.js`
Expected: PASS（5件）

- [ ] **Step 5: 移行ワークフローを作成する**

`.github/workflows/migrate-to-turso.yml` を新規作成する。既存の `show-streak-data.yml` の構成に合わせる。

```yaml
name: Turso移行 (使い捨て)

# actions/cache に残っている data/*.json を Turso に投入する一度きりのワークフロー。
# 移行が完了し、夜通知と朝通知が Turso から正しく読み書きできることを確認したら、
# このワークフローと scripts/migrate-to-turso.js を削除する。

on:
  workflow_dispatch:
    inputs:
      force:
        description: '既にTursoに値がある場合も上書きする'
        type: boolean
        default: false

jobs:
  migrate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read

    steps:
      - name: リポジトリをチェックアウト
        uses: actions/checkout@v7

      # 移行元。キャッシュにしか存在しないデータを読むためここだけは restore を使う
      - name: 前回データを復元
        id: cache-restore
        uses: actions/cache/restore@v6
        with:
          path: data
          key: smilezemi-data-never-matches
          restore-keys: |
            smilezemi-data-
          fail-on-cache-miss: false

      - name: キャッシュが復元できたかを確認
        run: |
          if [ ! -f data/streak_data.json ]; then
            echo "❌ data/streak_data.json が見つかりません。キャッシュが復元できていないため中止します"
            exit 1
          fi
          echo "✅ キャッシュを復元しました"
          ls -l data/

      - name: Node.jsをセットアップ
        uses: actions/setup-node@v7
        with:
          node-version: '24'

      - name: 移行を実行
        env:
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
          FORCE: ${{ inputs.force }}
        run: |
          if [ "$FORCE" = "true" ]; then
            node scripts/migrate-to-turso.js --force
          else
            node scripts/migrate-to-turso.js
          fi
```

`key: smilezemi-data-never-matches` は既存の定期ワークフローと同じ手口で、完全一致させず `restore-keys` の前方一致で最新のキャッシュを拾うための指定。

- [ ] **Step 6: ワークフローの YAML 構文を確認する**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/migrate-to-turso.yml','utf-8');if(!/^name:/m.test(s))throw new Error('nameがない');console.log('OK: 行数='+s.split('\n').length)"`

より確実な確認は Task 10 の PR 作成後、GitHub 上でワークフローが認識されるかを見る。

- [ ] **Step 7: 全テストと lint を実行してコミット**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run lint`

```bash
git add scripts/migrate-to-turso.js tests/migrate-to-turso.test.js .github/workflows/migrate-to-turso.yml
git commit -m "feat: actions/cacheからTursoへの移行スクリプトとワークフローを追加する"
```

---

### Task 8: 定期ワークフロー3本からキャッシュを外す

**Files:**
- Modify: `.github/workflows/crawler.yml`
- Modify: `.github/workflows/morning-crawler.yml`
- Modify: `.github/workflows/monthly-bonus.yml`

**Interfaces:**
- Consumes: `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`（Secrets、登録済み）
- Produces: なし

- [ ] **Step 1: 現状のキャッシュ関連ステップを一覧する**

Run: `grep -n "actions/cache\|actions/upload-artifact\|retention-days\|actions: read\|整合性" .github/workflows/crawler.yml .github/workflows/morning-crawler.yml .github/workflows/monthly-bonus.yml`

出力を見て、次の Step で削除する行を特定する。

- [ ] **Step 2: `crawler.yml` を変更する**

1. `permissions` から `actions: read` の行とそのコメントを削除する（`contents: read` は残す）
2. 「前回データを復元」ステップ（`actions/cache/restore@v6`）とその後の「キャッシュ復元の整合性を検証」ステップをまとめて削除する
3. 「データをキャッシュに保存」ステップ（`actions/cache/save@v6`）を削除する
4. 「ミッションデータを保存」ステップ（`actions/upload-artifact@v4` で `data/mission_data.json` を上げているもの）を削除する
5. 「スクリーンショットを保存」ステップの `retention-days: 90` を `retention-days: 3` に変更する
6. 「.envファイルを作成」ステップに2行追加する

```yaml
          echo "TURSO_DATABASE_URL=${{ secrets.TURSO_DATABASE_URL }}" >> .env
          echo "TURSO_AUTH_TOKEN=${{ secrets.TURSO_AUTH_TOKEN }}" >> .env
```

- [ ] **Step 3: `morning-crawler.yml` を同様に変更する**

`crawler.yml` と同じ1〜3、5、6を適用する（`morning-crawler.yml` には `mission-data` のアップロードはない）。スクリーンショットのステップ名は `morning-screenshots-${{ github.run_number }}`。

- [ ] **Step 4: `monthly-bonus.yml` を同様に変更する**

`crawler.yml` と同じ1〜3、6を適用する（`monthly-bonus.yml` にはアーティファクトのアップロードがない）。

- [ ] **Step 5: キャッシュとアーティファクトの参照が残っていないことを確認する**

Run: `grep -n "actions/cache\|mission_data.json\|actions: read" .github/workflows/crawler.yml .github/workflows/morning-crawler.yml .github/workflows/monthly-bonus.yml`
Expected: 出力なし

Run: `grep -n "TURSO" .github/workflows/*.yml`
Expected: crawler / morning-crawler / monthly-bonus / migrate-to-turso の4ファイルに出ること

Run: `grep -n "retention-days" .github/workflows/*.yml`
Expected: `retention-days: 3` のみ（90 が残っていないこと）

- [ ] **Step 6: コミット**

```bash
git add .github/workflows/crawler.yml .github/workflows/morning-crawler.yml .github/workflows/monthly-bonus.yml
git commit -m "feat: 定期ワークフローからactions/cacheを外してTursoに繋ぐ

- cache/restore と cache/save、整合性検証ステップを削除
- 不要になった permissions の actions: read を削除
- .env に TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を追加
- mission-data アーティファクトの出力を廃止(実名露出源かつDBと重複)
- screenshots の retention-days を 90 から 3 に短縮"
```

---

### Task 9: 手動ワークフローの削除と運用スキルの書き換え

**Files:**
- Delete: `.github/workflows/show-streak-data.yml`
- Delete: `.github/workflows/adjust-streak-field.yml`
- Delete: `.github/workflows/exempt-days.yml`
- Modify: `.claude/skills/smilezemi-set-grace/SKILL.md`
- Modify: `.claude/skills/smilezemi-set-streak/SKILL.md`
- Modify: `.claude/skills/smilezemi-set-bonus/SKILL.md`
- Modify: `.claude/skills/smilezemi-exempt-day/SKILL.md`

**Interfaces:**
- Consumes: `scripts/show-streak-data.js` / `scripts/set-streak-field.js` / `scripts/set-exempt-dates.js`（既存、コード変更不要）
- Produces: なし

スクリプト本体は `src/streak.js` の `loadStreakData` / `saveStreakData` 経由なので、Task 3 の差し替えでそのままローカルから Turso を読み書きする。**スクリプトのコード変更は不要**。

- [ ] **Step 1: ワークフロー3本を削除する**

```bash
git rm .github/workflows/show-streak-data.yml .github/workflows/adjust-streak-field.yml .github/workflows/exempt-days.yml
```

- [ ] **Step 2: ワークフローが4本になったことを確認する**

Run: `ls .github/workflows/`
Expected: `ci.yml` / `crawler.yml` / `migrate-to-turso.yml` / `monthly-bonus.yml` / `morning-crawler.yml` の5本（移行完了後に `migrate-to-turso.yml` を削除して4本になる）

- [ ] **Step 3: `smilezemi-set-grace/SKILL.md` を書き換える**

frontmatter の `description` 末尾を変更する。

- 変更前: `変更は本番(GitHub Actions キャッシュ)に反映される。`
- 変更後: `変更は本番(Turso)に即座に反映される。`

「## 前提」の節を置き換える。

```markdown
## 前提

- 実データは Turso（libSQL）にあり、ローカルから直接読み書きする。
  `.env` に `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` が設定されていること。
- 変更は保存した時点で本番に反映される。次回のスケジュール通知（夜 20:00 / 朝 7:00）から
  新しい値が使われる。
- 通知ワークフローが動いている時間帯（JST 20:00 前後 / 7:00 前後）に実行すると、
  ワークフロー側の保存と後勝ちで競合しうる。時間帯をずらして実行すること。
- スクリプトは `.env` を自動で読まないため、必ず `-r dotenv/config` を付けて実行する。
```

「### 2. 現在値と正確なユーザーキーを確認する」の `gh workflow run` のコードブロックを置き換える。

```bash
node -r dotenv/config scripts/show-streak-data.js
```

「### 3. まず dry-run で変更内容を確認する（事故防止）」の `gh workflow run` のコードブロックを置き換える。

```bash
node -r dotenv/config scripts/set-streak-field.js \
  --user "<手順2で確認した正確なキー>" \
  --field grace \
  --value <目標値> \
  --dry-run
```

保存する手順のコードブロックを置き換える（`--dry-run` を外すだけ）。

```bash
node -r dotenv/config scripts/set-streak-field.js \
  --user "<手順2で確認した正確なキー>" \
  --field grace \
  --value <目標値>
```

`gh run watch` / `gh run view --log` でログを取得している手順は、ローカル実行では標準出力に直接出るため削除する。「キャッシュ」「run_id」「ブランチ」に言及している記述も削除する。

- [ ] **Step 4: `smilezemi-set-streak/SKILL.md` を同様に書き換える**

Step 3 と同じ置換を、`--field streak` として適用する。

- [ ] **Step 5: `smilezemi-set-bonus/SKILL.md` を同様に書き換える**

Step 3 と同じ置換を、`--field bonus` として適用する。

- [ ] **Step 6: `smilezemi-exempt-day/SKILL.md` を書き換える**

「## 前提」の節を Step 3 と同じ内容に置き換える。`gh workflow run exempt-days.yml` を使っている箇所を、`scripts/set-exempt-dates.js` のローカル実行に置き換える。引数は次のとおり（`--user` と `--all` はどちらか一方が必須、`--to` を省略すると `--from` と同じ日、範囲は最大31日）。

1人に登録する場合:

```bash
node -r dotenv/config scripts/set-exempt-dates.js \
  --user "<手順で確認した正確なキー>" \
  --from 2026-08-20 \
  --to 2026-08-22 \
  --action add \
  --dry-run
```

全員に登録する場合:

```bash
node -r dotenv/config scripts/set-exempt-dates.js --all --from 2026-08-20 --action add --dry-run
```

取り消す場合は `--action remove` にする。合意が取れたら `--dry-run` を外して実行する。

現在値とユーザーキーの確認は Step 3 と同じ:

```bash
node -r dotenv/config scripts/show-streak-data.js
```

- [ ] **Step 7: スキルに古い記述が残っていないことを確認する**

Run: `grep -rn "gh workflow run\|actions/cache\|キャッシュ\|run_id\|GitHub Actions キャッシュ" .claude/skills/`
Expected: 出力なし

- [ ] **Step 8: コミット**

```bash
git add .claude/skills .github/workflows
git commit -m "feat: 手動運用をワークフローからローカル実行に移す

データがTursoに移りローカルから直接読み書きできるようになったため、
show-streak-data / adjust-streak-field / exempt-days の3ワークフローを削除する。

- show-streak-data が出力する実名が公開リポジトリのログに残らなくなる
- main以外のブランチから実行すると変更が黙って無効になる罠が構造的に消える
- 運用スキル4つの手順をローカルスクリプト実行に書き換え

スクリプト本体は src/streak.js 経由なのでコード変更は不要。"
```

---

### Task 10: CLAUDE.md の更新と Pull Request の作成

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: なし
- Produces: なし

- [ ] **Step 1: `CLAUDE.md` の該当箇所を特定する**

Run: `grep -n "actions/cache\|データ永続化\|Tech Stack\|show-streak-data\|adjust-streak-field\|exempt-days\|ストリーク値の手動変更\|mission_data.json\|streak_data.json" CLAUDE.md`

- [ ] **Step 2: 「データ永続化 (actions/cache)」の節を書き換える**

節の見出しと本文を次に置き換える。

```markdown
### データ永続化 (Turso)

`mission_data.json` と `streak_data.json` の内容は Turso（libSQL）の `app_state` テーブルに1キー1JSONドキュメントで保存する。`data/` ディレクトリは使わない。

- アクセス層は `src/store.js`。Turso の HTTP API（`/v2/pipeline`）を `fetch` で直接叩き、`@libsql/client` は入れない（本番依存を playwright のみに保つため）
- キーは `mission_data` と `streak_data` の2つ。JSON の構造とバージョン管理（`streak_data` は v1.4）は従来のファイル形式のまま
- 書き込みは `app_state` の upsert 1文だけを送り、`state_audit` への履歴追記はトリガーが行う。Turso の pipeline は文がエラーでも HTTP 200 を返し文ごとに独立して実行されるため、2文に分けると片方だけ成立しうる。トリガーは同じ暗黙のトランザクションで動くので現在値と履歴が必ず揃う
- `state_audit` は追記専用の履歴。`bonus` は実際に支給するお小遣いなので、誤って壊したときに復元できる状態を保つために置いている
- **`readState` は3状態を返す**: `'ok'`（行がある）/ `'empty'`（テーブルはあるが行がない = 初回実行）/ `'uninitialized'`（テーブルがない = 移行前）。`'uninitialized'` を `'empty'` と同一視すると、確定処理が全ユーザーを新規扱いして連続日数を 0 にリセットするため、必ず区別する
- **`writeState` はテーブルを作成しない**。スキーマ作成は移行スクリプトだけの責務。ランタイムが自動作成すると未移行を検知できなくなる
- 障害時は通知を優先し記録を諦める。読めなければストリークなしで通知し、書けなければその日の確定をあきらめて終了コード1にする。書き込みだけは1秒後に1度リトライする
- 詳細: `docs/superpowers/specs/2026-08-27-turso-migration-design.md`
```

- [ ] **Step 3: Tech Stack の節に Turso を追記する**

```markdown
- **Data Store**: Turso (libSQL) — HTTP API を fetch で直叩き（SDK なし）
```

`**Dependencies**: playwright (prod), dotenv (dev)` の行は変更しない（依存は増えていない）。

- [ ] **Step 4: 「ストリーク値の手動変更 (運用スキル)」の節を書き換える**

```markdown
### ストリーク値の手動変更 (運用スキル)

grace(おたすけ)・streak(連続日数)・bonus・免除日は Turso にあり、**ローカルから直接読み書きする**。`.env` に `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` が必要。スクリプトは `.env` を自動で読まないため `-r dotenv/config` を付けて実行する。

- 現在値の確認（読み取り専用）: `node -r dotenv/config scripts/show-streak-data.js`
- 1ユーザーの1フィールドを絶対値で設定: `node -r dotenv/config scripts/set-streak-field.js --user "名前" --field grace --value 3 [--dry-run]`
- 免除日の登録・取り消し: `node -r dotenv/config scripts/set-exempt-dates.js ...`

検証（フィールド種別・範囲・既存ユーザーのみ）はスクリプトに集約されている。フィールドごとに `.claude/skills/smilezemi-set-{grace,streak,bonus}` の3スキルへ分離し、各スキルは自分の field のみ渡して誤操作を防ぐ。免除日は `.claude/skills/smilezemi-exempt-day`。

以前は actions/cache にしかデータがなかったため workflow_dispatch 経由で操作していたが、Turso 移行で不要になった。これにより公開リポジトリのログに実名が残らなくなり、main 以外のブランチから実行すると変更が黙って無効になる罠も消えた。
```

- [ ] **Step 5: System Flow の図を更新する**

```text
GitHub Actions (cron) → Docker → Playwright (headless Chromium)
  → みまもるネット ログイン → データクローリング → 差分比較・ストリーク更新 → LINE / Discord 通知
  → 状態を Turso に保存
```

- [ ] **Step 6: Project Structure のワークフロー一覧を更新する**

```text
.github/workflows/
├── crawler.yml               # 日次クローリング・両コース (UTC 06:17起動→JST 20:00まで待機)
├── morning-crawler.yml       # 朝通知・両コース (UTC 17:47起動→JST 7:00まで待機)
├── monthly-bonus.yml         # 月次ボーナス清算 (月末候補日起動 + JST1日ガード → JST 8:00)
├── migrate-to-turso.yml      # 使い捨て: actions/cacheからTursoへの移行 (移行完了後に削除する)
└── ci.yml                    # テストとlint、Dockerビルド
```

`src/` の一覧に `store.js` を追記する。

```text
├── store.js                  # Turso(libSQL)の状態ストア (readState/writeState/createSchema)
```

- [ ] **Step 7: Environment Variables の節に Turso を追記する**

```markdown
`SMILEZEMI_USERNAME`, `SMILEZEMI_PASSWORD`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
(GitHub Secretsまたは`.env`ファイルで管理。本番はdocker composeのenv_file経由)
```

- [ ] **Step 8: Testing Patterns の節を更新する**

```markdown
- `tests/index.test.js` / `tests/morning-index.test.js` は require.cache 直接注入でモジュール依存をモックする。`src/index.js` や `src/morning-index.js` に新しい require を追加したら `MODULE_PATHS` とモック登録の追加が必須
- `tests/data.test.js` / `teststs/streak.test.js` は `../src/store` を require.cache に注入してモックする。実ファイル I/O は使わない
```

（`tests ts/streak.test.js` のようなタイプミスをしないよう、書いたあとに `grep -n "tests/streak.test.js" CLAUDE.md` で確認する）

- [ ] **Step 9: `data/` への言及が残っていないことを確認する**

Run: `grep -n "actions/cache\|smilezemi-data-\|data/mission_data.json\|data/streak_data.json\|show-streak-data.yml\|adjust-streak-field.yml\|exempt-days.yml" CLAUDE.md`
Expected: 出力なし（あれば書き換え漏れ）

- [ ] **Step 10: 全テスト・lint・検証を実行する**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run lint && npm run validate:all`
Expected: fail 0、lint エラーなし、検証すべて成功

- [ ] **Step 11: ドライランで読み取り経路を確認する**

Run: `DRY_RUN=true node -r dotenv/config src/morning-index.js 2>&1 | tail -20`

Expected: Turso が未初期化なので「❌ ストリークデータの保存先が未初期化のため、確定処理をスキップします」と出て、ストリーク行なしの通知プレビューが表示される。**これが移行前の期待どおりの挙動**。クロール自体は実行されるため数分かかる。

- [ ] **Step 12: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: データ永続化のTurso移行をCLAUDE.mdに反映する"
```

- [ ] **Step 13: Pull Request を作成する**

```bash
git push -u origin feature/turso-migration
```

```bash
gh pr create --title "feat: データ永続化をactions/cacheからTursoに移す" --body "$(cat <<'PRBODY'
## 目的

公開リポジトリから子どもの実名を含むデータが読み取れる状態を解消する。あわせてキャッシュ依存の耐久性と運用の問題を取り除く。

設計: `docs/superpowers/specs/2026-08-27-turso-migration-design.md`
計画: `docs/superpowers/plans/2026-08-27-turso-migration.md`

## 解決する問題

| 問題 | 内容 |
|---|---|
| 実名の露出 | `mission-data` アーティファクト239件（保持90日）に実名と学習記録が平文で入っていた。手動ワークフローのログにも実名が出ていた |
| 耐久性 | キャッシュが失われると `streak` / `grace` / `bonus` が失われる。`bonus` は実際に支給するお小遣いで復元手段がない |
| 読み取り経路 | fork PR に `actions/cache/restore` を仕込むとキャッシュ内容を読み出せる可能性があった |
| 運用の罠 | 手動ワークフローを main 以外のブランチから実行すると、変更が黙って無効になっていた |

## 主な変更

- `src/store.js` を新設。Turso の HTTP API（`/v2/pipeline`）を `fetch` で直叩きする。**本番依存パッケージは増やしていない**（`@libsql/client` は入れない）
- `data.js` / `streak.js` の4関数の中身だけを差し替え。戻り値の形は変えないため、エントリポイントと運用スクリプトは原則そのまま動く
- 監査テーブル `state_audit` をトリガーで積む。キャッシュが偶然の backup として機能していた性質を引き継ぐため
- 定期ワークフロー3本からキャッシュを外し、`mission-data` アーティファクトを廃止、`screenshots` の保持を90日から3日に短縮
- 手動ワークフロー3本を削除し、ローカルスクリプト実行に移行（運用スキル4つも書き換え）
- `tests/morning-index.test.js` を13行から本格化。確定処理のテストがなかった

## 未初期化の扱い（重要）

`readState` は `'ok'` / `'empty'`（初回実行）/ `'uninitialized'`（移行前）の3状態を区別する。マージ後に移行ワークフローを実行するまでの間に定期実行が走っても、**確定処理をスキップして通知だけ出す**ため、連続日数が 0 にリセットされることはない。終了コード1で移行漏れに気づけるようにしている。

## マージ後の手順

1. `migrate-to-turso.yml`（workflow_dispatch）を実行し、出力の `streak` / `grace` / `bonus` を照合する
2. その日の夜通知と翌朝の朝通知で読み書きが成立したことを確認する
3. キャッシュ15件（`smilezemi-data-*`）とアーティファクト454件を削除する
4. `migrate-to-turso.yml` と `scripts/migrate-to-turso.js` を削除する

既存キャッシュの削除を手順3まで遅らせるのは、移行が失敗したまま消すと復元手段がなくなるためです。

## 本PRで解決しないこと

- GitHub Actions の分数（プライベート化の障壁）。原因は `crawler.yml` / `morning-crawler.yml` の sleep が1回あたり約231分であることで、データの置き場とは無関係
- LINE の月間送信数。8月の実測で月換算約228カウントとなり上限200を超える見込み

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY
)"
```

- [ ] **Step 14: CI が通ることを確認する**

```bash
RUN=$(gh run list --workflow=CI --branch feature/turso-migration --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" --exit-status
gh run view "$RUN" --json status,conclusion -q '"\(.status) / \(.conclusion)"'
```

Expected: `completed / success`

CI は `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を環境に持たないが、テストはすべて `fetch` と store をモックしているため実接続は発生しない。もし `config.test.js` が環境変数を要求して落ちる場合は、テスト内で `process.env` を設定する形に直す（Task 6 Step 1 の注記を参照）。

- [ ] **Step 15: 不要になった `TURSO_API_TOKEN` を削除する**

これは PR の差分ではなく Secrets とローカル `.env` の操作。仕様書の「設定の配線」に含まれる項目。

`TURSO_API_TOKEN` は org 全体（DB の作成・削除を含む）を操作できる Platform API トークンで、アプリは使わない。毎日走るワークフローの Secrets に置いておく理由がないため削除する。アプリが使うのは DB 限定の `TURSO_AUTH_TOKEN` だけ。

**削除の前にユーザーへ確認を取る。** 承認が得られたら実行する。

```bash
gh secret delete TURSO_API_TOKEN
gh secret list | grep TURSO
```

ローカルの `.env` からも該当行を削除する。

```bash
grep -n "TURSO_API_TOKEN" .env
```

該当行を削除したあと、必須環境変数の検証が通ることを確認する。

Run: `npm run validate:env`
Expected: 「すべての環境変数が正しく設定されています」

- [ ] **Step 16: PR の URL を報告してマージはしない**

Run: `gh pr view --json url -q .url`

**マージは行わない。** 作業範囲は PR の作成まで。マージ後の手順（移行ワークフローの実行、キャッシュとアーティファクトの削除、移行スクリプトの削除）は PR 本文に記載済み。
