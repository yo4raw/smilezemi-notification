# oxlint 導入 設計

## 背景と目的

本プロジェクトには現在 linter が導入されていない（ESLint / Prettier / Biome いずれも未使用）。
[oxlint](https://oxc.rs/)（Rust製の高速 JavaScript linter）を導入し、次を実現する。

- **バグ検出**: 未使用変数・未定義参照・await 漏れなど、実バグにつながる問題の早期検出
- **コード品質**: 一貫性・可読性・パフォーマンス面の改善

導入先は **pre-commit フック** と **GitHub Actions CI** の両方とし、品質ゲートとして機能させる。

## 決定事項

| 項目 | 決定 |
|------|------|
| 狙い | バグ検出＋コード品質 |
| CI | PR をブロックする品質ゲート |
| lint 対象 | `src/` のみ |
| pre-commit 実装 | ネイティブ git フック（フック管理ツール依存なし） |
| 組み込み先 | pre-commit と GitHub Actions CI の両方 |

## アーキテクチャ / 導入物

| 項目 | 内容 |
|------|------|
| oxlint 本体 | `oxlint` を **devDependency にピン留め**。`npm ci` で再現し、CI と手元でバージョンを一致させる |
| 設定ファイル | ルート直下 `.oxlintrc.json`（`$schema` を node_modules 内スキーマに向ける） |
| npm スクリプト | `lint`（チェック）、`lint:fix`（自動修正） |
| pre-commit フック | `.githooks/pre-commit`（shell スクリプト）+ `core.hooksPath` で有効化 |
| CI | `.github/workflows/ci.yml` に lint ステップを追加（`npm test` と並ぶ品質ゲート） |

補足: pre-commit はネイティブ git フックを採用する。「依存なし」はフック管理ツール（husky 等）を入れないという意味であり、oxlint 自体は devDependency として追加する。

## ルールセット（`.oxlintrc.json`）

「バグ検出＋コード品質」かつ「PR ブロック」の方針に合わせ、カテゴリを次のように設定する。

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": {
    "correctness": "error",
    "suspicious": "warn",
    "perf": "warn"
  },
  "ignorePatterns": ["node_modules", "vendor", "data", "logs", "screenshots"]
}
```

- `correctness`（実バグ）= error、`suspicious` / `perf`（品質）= warn
- CI・pre-commit とも **`--deny-warnings`** を付けて実行し、warn も含め全て非ゼロ終了でブロックする
- `style` / `pedantic` は初期はオフ。好み依存で誤検知が多いため、必要に応じて後から追加する

## pre-commit フック

`.githooks/pre-commit`:

```sh
#!/bin/sh
npx oxlint --deny-warnings src || {
  echo "oxlint で問題が見つかりました。修正するか 'npm run lint:fix' を実行してください。" >&2
  exit 1
}
```

- 有効化は `package.json` の `prepare` スクリプトで自動化する: `git config core.hooksPath .githooks`
  - `npm install` / `npm ci` 実行時に自動設定され、追加依存は不要
- oxlint は高速なため、`src/` 全体を毎回チェックしても体感はほぼ即時

## CI 統合（`ci.yml`）

`npm ci` の後、テストと並ぶステップとして lint を追加する。

```yaml
      - name: Lintを実行
        run: npm run lint

      - name: テストを実行
        run: npm test
```

- `npm run lint` = `oxlint --deny-warnings src`
- lint エラーで CI 失敗 → main へのマージをブロック

## 既存コードの扱い

導入時に `src/` へ oxlint を実行し、**検出された既存違反を全て修正してからマージ**する（クリーンなベースラインで開始）。
修正量が多い、または意図的なコードがある場合はその時点で相談する。

## テスト / 検証

- `npm run lint` がローカルで pass すること
- pre-commit フックが違反コミットを実際にブロックすること（意図的な違反で確認）
- CI が PR で lint を実行し、違反時に失敗すること

## スコープ外（YAGNI）

- `tests/` / `scripts/` / `cmd/` の lint（将来必要になれば対象拡大）
- フォーマッタ（Prettier / oxlint format）の導入
- `style` / `pedantic` カテゴリの有効化
- husky / lint-staged 等のフック管理ツール
