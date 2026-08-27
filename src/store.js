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

// notifier.jsのLINE送信と同じ既定値に揃える
const REQUEST_TIMEOUT_MS = 10000;

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

// 書き込みの再試行間隔。bonusは実際のお小遣いなので、一瞬のネットワーク断で
// 1日分を取りこぼさないよう1度だけ待って再送する
const WRITE_RETRY_DELAY_MS = 1000;

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
