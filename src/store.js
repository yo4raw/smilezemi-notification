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

module.exports = {
  resolveEndpoint
};
