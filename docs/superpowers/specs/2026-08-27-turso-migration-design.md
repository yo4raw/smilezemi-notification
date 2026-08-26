# データ永続化の Turso 移行 設計

日付: 2026-08-27
ステータス: 承認済み

## 目的

`data/mission_data.json` と `data/streak_data.json` の置き場を GitHub Actions キャッシュから Turso（libSQL）へ移し、子どもの実名を含むデータが公開リポジトリから読み取れる状態を解消する。あわせて、キャッシュ依存に起因する耐久性と運用の問題を取り除く。

## 背景

このリポジトリは公開設定であり、実名を含むデータが3つの経路で外部から到達可能な状態にある。

| 経路 | 実態 |
|---|---|
| `mission-data` アーティファクト | 239件、保持90日。`"userName": "（実名）"` と学習件数・点数・勉強時間を平文で含む |
| `screenshots` / `morning-screenshots` アーティファクト | 215件、保持90日。みまもるネットのフルページ画面（実名・成績が写る） |
| `show-streak-data` などの手動ワークフローのログ | 実名が平文で出力される。公開リポジトリの run ページは未認証で到達できる |

`crawler.js` のログは `maskSensitiveData` によって `*****ん` に伏せられており、設計意図としては実名を出さない方針が既にある。上記3経路はその方針から漏れている。

さらにキャッシュ依存そのものが3つの問題を抱えている。

- **耐久性**: キャッシュが失われると `streak` / `grace` / `bonus` が失われる。CLAUDE.md はこれを「許容済みトレードオフ」と明記しているが、`bonus` は実際に支給するお小遣いであり、失うと復元手段がない
- **読み取り経路**: fork からの Pull Request では PR 側のワークフローファイルが実行されるため、`actions/cache/restore` を仕込んだ PR によってキャッシュ内容を読み出せる可能性がある（未検証）
- **運用の罠**: `adjust-streak-field.yml` / `exempt-days.yml` を main 以外のブランチから実行すると、保存されるキャッシュがそのブランチにスコープされ main から読めない。手動変更が黙って無効になる

## 要件

- `mission_data` と `streak_data` の両方を Turso に置き、`data/` ディレクトリを廃止する
- 既存の公開インターフェース（`loadPreviousData` / `saveData` / `loadStreakData` / `saveStreakData`）は変えない。エントリポイントと運用スクリプトの呼び出し側は変更しない
- Turso に到達できないとき、**通知を優先し記録を諦める**。読めなければストリークなしで通知し、書けなければその日の確定をあきらめる。いずれも終了コード1で気づけるようにする
- 移行は一度で切り替える。キャッシュへの保存は即座に停止する
- 本番依存パッケージを増やさない
- 実名がワークフローのログとアーティファクトに残らない状態にする
- 今回の作業範囲は **Pull Request の作成まで**。マージは行わない

## 用語

- **未初期化**: Turso に `app_state` テーブルが存在しない状態。移行前を意味する
- **初回実行**: `app_state` テーブルはあるが該当キーの行がない状態。データがまだ1度も保存されていないことを意味する

## データモデル

```sql
create table if not exists app_state (
  key        text primary key,  -- 'mission_data' | 'streak_data'
  value      text not null,     -- 既存の JSON 文字列をそのまま格納
  updated_at text not null      -- ISO 8601
);

create table if not exists state_audit (
  id         integer primary key autoincrement,
  key        text not null,
  value      text not null,
  written_at text not null      -- ISO 8601
);
```

JSON の構造は一切変更しない。`streak_data` の v1.4 バージョン管理と移行ロジック、`replayStreak()` はそのまま機能する。正規化しないのは、このアプリが状態を丸ごと読んで丸ごと書くだけで SQL のクエリを必要としないためである。正規化すると `streak.js` の内部構造と `streak.test.js`（1250行）の大規模な書き換えが発生し、得られるものが要件に見合わない。

`state_audit` は追記専用の履歴である。キャッシュを廃止すると、これまで偶然の backup として機能していた過去15世代（`smilezemi-data-*`）が失われ、現在値1行しか存在しなくなる。`bonus` を誤って壊したときに復元できる状態を保つために置く。書き込みは1回あたり2行増えるが、月あたり約620行で、無料枠の月1,000万行に対して無視できる。

保存する JSON は整形しない（`JSON.stringify(obj)`）。DB なのでインデントは不要で、監査テーブルの行サイズも小さくなる。

## アーキテクチャ

### 新モジュール `src/store.js`

Turso の HTTP API（`/v2/pipeline`）を `fetch` で直接叩く。`@libsql/client` は導入しない。本番依存を `playwright` のみに保ち、Docker イメージを重くしないためである。用途は「1行読んで1行書く」だけなので SDK の機能は不要。HTTP API での疎通は検証済み。

```js
resolveEndpoint(databaseUrl)  // libsql://host → https://host
readState(key)                // → {success, state, value}
writeState(key, value)        // → {success, error?}
```

`readState` の戻り値は3状態を区別する。

| `state` | 条件 | `value` |
|---|---|---|
| `'uninitialized'` | `app_state` テーブルが存在しない（`no such table`） | `null` |
| `'empty'` | テーブルはあるが該当キーの行がない | `null` |
| `'ok'` | 行がある | JSON 文字列 |

この区別が本設計の要点である。未初期化を「空」と同一視すると、移行前に定期実行が走った際にストリークが 0 にリセットされる。

- 認証: `Authorization: Bearer ${TURSO_AUTH_TOKEN}`、接続先は `TURSO_DATABASE_URL` から導出
- タイムアウト: `AbortController` で10秒（`notifier.js` の既定値に揃える）
- 書き込みは `app_state` の upsert と `state_audit` の insert を**同一 pipeline リクエスト**で送り、片方だけ残る状態を避ける
- 書き込み失敗時は1秒後に1度だけリトライする。`bonus` は実際のお小遣いであり、一瞬のネットワーク断で1日分を取りこぼすのは実損になる。それでも失敗したら諦める（方針どおり）
- `store.js` は `DRY_RUN` を参照しない。ドライランでの保存スキップは各エントリポイントが既に判定している
- **`writeState` はテーブルを作成してはならない。** スキーマ作成は移行スクリプトだけが行う。`writeState` に `create table if not exists` を持たせると、未移行の状態で夜通知の `saveData` がテーブルを作ってしまい、翌朝の `readState` が `'uninitialized'` ではなく `'empty'` を返す。その結果ストリークが初回実行として 0 にリセットされる。テーブルがない状態での書き込みは失敗させ、終了コード1で気づかせる

### 既存モジュールの差し替え

`src/data.js`

| 関数 | 変更 |
|---|---|
| `loadPreviousData()` | `fs.readFile` → `readState('mission_data')`。`'empty'` なら `{success: true, data: []}`。`'uninitialized'` なら `{success: false, error: '未初期化'}` を返す。v1.0 → v2.0 の自動移行はそのまま |
| `saveData(users)` | `fs.writeFile` → `writeState('mission_data', ...)`。配列チェックと `{version, timestamp, users}` の組み立ては変更なし |

`src/streak.js`

| 関数 | 変更 |
|---|---|
| `loadStreakData()` | `readState('streak_data')`。`'uninitialized'` は `{success: false, uninitialized: true, error}` を返す。JSON パース失敗時は現状どおり「エラーを記録しつつ空状態で続行、次回保存で自己修復」 |
| `saveStreakData()` | `writeState('streak_data', ...)` |

`DATA_DIR` / `STREAK_FILE` / `DATA_FILE` の定数と `fs.mkdir` は削除する。

### 未初期化時の挙動

読み取りが `'uninitialized'` を返したとき、ストリークの確定処理を行ってはならない。各エントリポイントの扱いは次のとおり。

| エントリ | 未初期化時 | 既存コードからの変更 |
|---|---|---|
| 夜通知 | 免除日なしとして通知は出す。確定処理は元々行わないため影響なし。`errors` に積んで終了コード1 | **要変更**。現状は読み取り失敗を `console.warn` だけで流しており `errors` に積んでいない。未初期化は移行前という異常状態なので気づける必要がある |
| 朝通知 | **確定処理をスキップ**し、ストリーク行なしで通知を出す。`errors` に積んで終了コード1 | **要変更**。現状は読み取り失敗時に空状態で確定処理を続行するため、未初期化では 0 リセットが起きる。`uninitialized` を判別してスキップする分岐を足す |
| 月次清算 | 現状どおりエラー通知を送って異常終了する。清算は行わない | 変更不要 |

未初期化と通常の読み取り失敗は区別する。通常の失敗（ネットワーク断など）は下表のとおり既存挙動を維持し、未初期化のみ上表の扱いにする。

朝通知の確定スキップが、マージと移行の順番の縛りを取り除く。マージ後にいつ定期実行が走っても、テーブルがない間はストリークを壊さず通知だけ出し、移行ワークフローを実行した時点から正常運転に入る。

### 障害時の挙動（既存のまま）

読み取り・書き込みが失敗した場合の呼び出し側の挙動は、すでに要件と一致しているため変更しない。

| エントリ | 読み取り失敗 | 書き込み失敗 |
|---|---|---|
| 夜通知 | 警告のみで続行（免除日なし扱い） | `errors` に積んで終了コード1 |
| 朝通知 | `errors` に積み、空状態で続行して通知は出す | `errors` に積んで終了コード1 |
| 月次清算 | エラー通知を送って異常終了、清算はしない | `errors` に積んで終了コード1 |

月次だけ「通知を止める」側に倒れているが、金額を配る処理であるため現状の判断を維持する。

## 設定の配線

- `src/config.js`: `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を必須環境変数に追加。`TURSO_AUTH_TOKEN` は `maskSensitiveData` の対象にする
- `scripts/validate-env.js`: 必須リストに2つを追加
- `docker-compose.yml`: `environment` に2つを追加し、`./data:/app/data` のボリュームを削除
- `Dockerfile`: `mkdir -p screenshots data logs` から `data` を外す
- GitHub Actions Secrets: `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` は登録済み。`TURSO_API_TOKEN`（org 全体を操作できる Platform API トークン）はアプリが使わないため削除する

## ワークフローの変更

### 定期実行の3本

`crawler.yml` / `morning-crawler.yml` / `monthly-bonus.yml`

- `actions/cache/restore` と `actions/cache/save`、キャッシュ整合性検証ステップを削除
- `permissions: actions: read`（`gh api` でキャッシュを数えるため）を削除
- `.env` の生成に `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を追加
- `mission-data` アーティファクトの出力を廃止（実名露出源であり、DB に入るため重複）
- `screenshots` の `retention-days` を 90 → **3** に短縮

スクリーンショットは障害調査に実用的な価値があるため出力自体は残す。ただし中身はみまもるネットの画面そのもの（実名・成績）であり、90日公開し続ける理由はない。3日は、夜の失敗を翌朝の実行で気づいてから確認する余裕を見た値である。

### 手動運用の3本は削除しローカル実行に移す

`show-streak-data.yml` / `adjust-streak-field.yml` / `exempt-days.yml` を削除する。これらが GitHub Actions になっているのは、データが actions/cache の中にしか存在しないためであり、Turso に移せばローカルから直接読み書きできる。

得られるもの:

- `show-streak-data` が出力する実名が公開リポジトリのログに残らなくなる
- main 以外のブランチから実行すると変更が黙って無効になる罠が構造的に消える（キャッシュを使わないため ref に依存しない）
- ワークフローが7本 → 4本に減る

`.claude/skills/` の4スキル（`smilezemi-set-grace` / `smilezemi-set-streak` / `smilezemi-set-bonus` / `smilezemi-exempt-day`）を、ワークフロー起動からローカルスクリプト実行に書き換える。

トレードオフとして、外出先からスマホの GitHub UI で操作する使い方はできなくなる。

## 移行手順

本番の `streak_data.json` は actions/cache 内にのみ存在し、キャッシュには公開ダウンロード API がない（アーティファクトに含まれるのは `mission_data.json` だけで、`history` を持つ streak データは入っていない）。そのため使い捨ての移行ワークフローを1本作る。

### `migrate-to-turso.yml`（`workflow_dispatch`）

1. checkout → `actions/cache/restore@v6` で `smilezemi-data-` を復元
2. `scripts/migrate-to-turso.js` を実行
   - `create table if not exists` でスキーマを作成
   - `data/streak_data.json` と `data/mission_data.json` を `app_state` に upsert し、`state_audit` にも記録
   - 既に `app_state` に該当キーの行があれば上書きしない。上書きは `--force` を明示したときだけ（二重実行の事故防止）
3. 書いた内容を読み戻し、ユーザー数と `streak` / `grace` / `bonus` を表示して照合する。実名はマスクして出力する

### 実施順

1. **Pull Request を作成する（今回の作業範囲はここまで）**
2. ユーザーがマージする
3. マージ後に `migrate-to-turso.yml` を実行し、照合する。この間に定期実行が走っても確定をスキップするだけで無害
4. 夜通知と翌朝の朝通知で読み書きが成立したことを確認する
5. キャッシュ15件とアーティファクト454件（`mission-data` 239 / `screenshots` 200 / `morning-screenshots` 15）を削除する
6. `migrate-to-turso.yml` と `scripts/migrate-to-turso.js` を削除する

既存キャッシュの削除を手順5まで遅らせるのは、移行が失敗したまま消すと `streak` 42日・`bonus` 25P を復元する手段がなくなるためである。キャッシュへの保存停止は手順2の時点で即座に効くため、「一度で切り替える」方針は保たれる。

## テスト

- `tests/store.test.js`（新規）: `resolveEndpoint` の URL 変換、`fetch` をモックした pipeline リクエストの内容、`no such table` を `'uninitialized'` に分類する分岐、行なしを `'empty'` に分類する分岐、タイムアウト、書き込みの1回リトライ
- `tests/data.test.js` / `tests/streak.test.js`: 実ファイル I/O を前提した箇所を store のモックに差し替える。`beforeEach` / `afterEach` のファイル掃除は不要になる
- `tests/index.test.js`: `MODULE_PATHS` に `../src/store` を追加する（追加漏れるとモック注入が効かず落ちる）
- `tests/morning-index.test.js`: 現状13行で `main` のエクスポート確認のみであり、確定処理のテストがない。今回変更するのがその永続化経路そのものであるため、`index.test.js` と同じ `require.cache` 注入パターンで、確定・免除日・未初期化時のスキップ・保存失敗時の挙動を追加する
- ローカル検証: `DRY_RUN=true node -r dotenv/config src/morning-index.js` で読み取り経路を確認する。書き込みはドライランでスキップされるため、書き込みの実地検証は移行スクリプトの実行が担う

## ドキュメント

- CLAUDE.md: 「データ永続化 (actions/cache)」の節を Turso に全面的に書き換える。Tech Stack に Turso を追記する。「ストリーク値の手動変更 (運用スキル)」の節をローカル実行に更新する。Project Structure のワークフロー一覧を4本に更新する
- 環境変数の節に `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を追記する

## 本設計で解決しないこと

- **GitHub Actions の分数**: プライベート化の障壁は `crawler.yml` / `morning-crawler.yml` の sleep が1回あたり約231分であることに起因する（実作業は約2.3分）。データの置き場とは無関係で、現状の設計のままプライベート化すると月約14,600分となり、無料枠の月2,000分を大きく超える
- **LINE の月間送信数**: 8月の実測で、夜通知は25日のうち20日で LINE 送信。月換算で約228カウントとなり上限200を超える見込み。本設計とは独立した課題
- **`scripts/validate-security.sh` の空振り**: macOS の BSD grep で正規表現が解釈されず、機密情報のハードコード検出が機能していないまま成功と報告される。独立した課題
