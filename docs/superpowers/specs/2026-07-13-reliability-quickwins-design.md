# 信頼性クイックウィン + バグ修正 設計書

作成日: 2026-07-13
ステータス: 承認済みスコープ(改善調査で「B: 信頼性クイックウィン + A: バグ修正」を選択)

## 背景と目的

コード構造・信頼性・運用の3観点で実施した改善調査により、機能仕様(通知内容・通知タイミング)を変えずに修正できる以下の問題が確認された。

1. 通知経路にリトライが効いておらず、一時的な通信障害1回でその日の通知が欠落する
2. 障害発生時の通知が「変更なし」に偽装される、または無音になり、通知機能の死活に気づけない
3. actions/cache のrestore失敗と無条件saveの組み合わせで、ストリークデータが全消失しうる
4. ワークフロー自体の失敗を検知する仕組みがなく、publicリポジトリの60日無効化で通知がサイレント停止するリスクがある
5. 実装意図と乖離したバグが2件ある(メッセージ切り詰め、フォールバック時のUTC日付)

本設計はこれらを最小の変更で解消する。**外形的な機能仕様(成功時の通知内容・実行タイミング)は変更しない。** 障害時の挙動のみ「無音/偽装」から「明示」に変える。

## スコープ

| ID | 内容 | 変更対象 |
|----|------|----------|
| A1 | formatMessage の切り詰めロジック修正 | src/notifier.js |
| A2 | フォールバックモードの日付をJSTに統一 | src/crawler.js |
| B1 | LINE送信の共通化(リトライ・タイムアウト付き) | src/notifier.js + 3エントリポイント |
| B3 | 障害時エラー通知(夜の偽装解消・朝の無音解消) | src/index.js, src/morning-index.js |
| DEV | 夜通知への DRY_RUN ガード追加 | src/index.js |
| B2 | cache save の条件化 + exit code 伝搬修正 | .github/workflows/crawler.yml, morning-crawler.yml |
| B4 | ワークフロー失敗時LINE通知 + keepalive | .github/workflows/*.yml |

### 非スコープ

- コード構造リファクタリング(crawler.js分割、エントリポイント共通化)— 別パッケージとして扱う
- セレクタ破損のサニティチェック — 工数中のため別途
- sleep待機方式の変更 — publicリポジトリの間は現状維持と判断済み

## 各項目の設計

### A1: formatMessage の切り詰めロジック修正

**現状の問題** (`src/notifier.js:199-232`): `changes.forEach` のコールバック内で `return message` しているが、これはコールバックを抜けるだけでループは止まらない。5000字接近時に「... 他N件の変更があります」を付けて打ち切る意図のコードが、実際には打ち切らず、閾値を超えるたびに省略行を重複追記する。

**設計**: `forEach` を `for...of`(インデックス付きは `entries()`)に書き換え、閾値到達時に省略行を1回だけ追記して `break` する。意図された仕様(「他N件」表示で打ち切り)に合わせる。最終防衛の substring 切り詰め(235-237行)は保険としてそのまま残す。

**テスト**: 多数の変更(メッセージが5000字近くになる件数)を渡した場合に (a) 5000字以内であること、(b) 「他N件の変更があります」が**ちょうど1回**含まれること、(c) 通常件数では省略行が付かないこと。

### A2: フォールバックモードの日付をJSTに統一

**現状の問題** (`src/crawler.js:1566-1568`): `getAllUsersMissionCounts` のみ `new Date().toISOString().split('T')[0]`(UTC基準)で日付を記録している。他は全て `getTargetDates()`(JST明示補正)を使用。JST 0:00〜8:59 の実行では前日日付になり、保存データの日付キーが不整合になる。

**設計**: `getTargetDates(0).dateString` に置換(同一ファイル内の関数のため import 追加は不要)。

**テスト**: `getAllUsersMissionCounts` の返す `date` が `getTargetDates(0).dateString` と一致すること(既存のモック方式に合わせる)。

### B1: LINE送信の共通化

**現状の問題**: 3エントリポイント(`index.js:308-328`, `morning-index.js:173-193`, `weekly-report-index.js:118-138`)がLINE Push APIを素の `fetch` で直書きしており、`notifier.js` の `sendNotification` が持つ指数バックオフ・401非リトライ・トークンマスキングが主要経路で一切使われていない。fetch にタイムアウトもない。

**設計**: `notifier.js` に新関数を追加する。

```
sendPushMessage(message, accessToken, userId, options?)
  → Promise<{success: boolean, error?: string}>
```

- 整形済みメッセージ文字列を受け取り、既存 `sendNotification` と同じリトライポリシー(maxRetries=3、指数バックオフ、401は即中断)で送信する
- `AbortController` による HTTP タイムアウト(デフォルト 10秒/試行)を追加
- エラーメッセージは既存の `maskTokenInError` でマスキング
- 実装は既存 `sendNotification` のリトライループを流用する形で内部を共通化する(`sendNotification` は `formatMessage(changes)` で整形して `sendPushMessage` を呼ぶ構造に変更。公開APIと出力は不変)

3エントリポイントの inline fetch を `sendPushMessage(message, config.LINE_CHANNEL_ACCESS_TOKEN, config.LINE_USER_ID)` 呼び出しに置換する。成功/失敗時の console 出力と errors 配列への積み方は各エントリポイントの現状に合わせて維持する。

**テスト**:
- `sendPushMessage` 単体: 成功・401非リトライ・5xxリトライ後成功・全滅・タイムアウトの各ケース(fetch をモック)
- `tests/index.test.js`: notifier モックに `sendPushMessage` を追加し、詳細モードで呼ばれることを検証(グローバル fetch モックの削除に伴う調整)
- 既存 `sendNotification` のテストがグリーンのままであること(後方互換の確認)

### B3: 障害時エラー通知

**現状の問題**:
- 夜通知: 詳細・基本の両クロールが失敗すると `sendNotification([], ...)` が呼ばれ、「📊 スマイルゼミ ミッション数 / 本日は変更ありませんでした。」という**正常を装ったメッセージ**が送信される(`index.js:141-150` + `notifier.js:188-189`)
- 朝通知: クロール失敗時は exit 1 のみで LINE には何も届かない(`morning-index.js:83-87`)。「0件でも必ず通知」の仕様が障害時に静かに破られる

**設計**: 両エントリポイントの失敗パスで、障害専用メッセージを `sendPushMessage` で送信する。

```
⚠️ スマイルゼミ通知でエラーが発生しました

{夜通知|朝通知}のデータ取得に失敗したため、本日の通知をお届けできません。
GitHub Actions のログを確認してください。
```

- 夜通知: `sendNotification([])` の呼び出しを上記メッセージの `sendPushMessage` に置換。exit 1 は現状通り
- 朝通知: `return { success: false, exitCode: 1, ... }` の前に上記メッセージを送信(送信失敗しても exit 1 は変えない)
- エラー通知自体の失敗は console.error のみ(現状の夜通知と同じ方針)。トークン失効など通知手段自体が死んでいるケースは B4 のワークフロー通知でカバーする

**テスト**: 夜: 両クロール失敗時に `sendPushMessage` がエラーメッセージで呼ばれ、`sendNotification` が呼ばれないこと。朝: クロール失敗時にエラーメッセージ送信+exitCode 1 になること(morning-index はテスト基盤が薄いため、少なくとも夜通知側は tests/index.test.js の既存モック方式で検証する)。

### DEV: 夜通知への DRY_RUN ガード追加

**目的**: ローカルでの挙動検証(本設計の検証を含む)のため。現状、夜通知には DRY_RUN ガードがなく、ローカル実行すると実際に LINE 送信・データ保存される。

**設計**: `morning-index.js` と同じパターンで `process.env.DRY_RUN === 'true'` の場合に (a) ストリークデータを保存しない、(b) メッセージをコンソールにプレビュー表示して LINE 送信しない、(c) `saveData` を実行しない。本番ワークフローでは DRY_RUN 未設定のため挙動は不変。CLAUDE.md の「夜通知は DRY_RUN ガードなし」の記述も更新する。

### B2: cache save の条件化 + exit code 伝搬修正

**現状の問題1**: restore(`actions/cache/restore@v4`)はキャッシュサービス障害時もジョブを止めず続行する。その後 `if: always()` の save が新キー(`smilezemi-data-${run_id}`)で保存するため、復元失敗した回の**空 or リセット済みデータが「最新キャッシュ」になり**、以降 restore-keys のプレフィックス一致は常にそれを選ぶ。ストリーク履歴が実質全消失する。

**設計1**: `crawler.yml` / `morning-crawler.yml` に整合性チェックステップを追加する。

1. restore ステップに `id: restore-data` を付与
2. 直後に整合性チェック: `steps.restore-data.outputs.cache-matched-key` が空(何も復元できなかった)場合、`gh cache list --key smilezemi-data-` で既存エントリ数を確認する
   - エントリが存在する → 「キャッシュはあるのに復元に失敗」= サービス異常。**ジョブを即失敗させる**(save も実行されず、既存キャッシュが保護される。B4 の失敗通知でユーザーが気づき、workflow_dispatch で再実行できる)
   - エントリが存在しない → 正規の初回実行 or 7日エビクション。そのまま続行(ストリーク0から再開は既存の許容済みトレードオフ)
3. ジョブに `permissions: actions: write` を明示(gh cache list に actions:read が必要。B4 の keepalive とも共用)

`if: always()` の save は維持する(通知失敗時も確定済みストリークを保持する既存意図の通り)。整合性チェックが fail した場合は後続ステップ自体が走らないため save は発生しない。

**現状の問題2**: `crawler.yml:85` の `docker compose up --abort-on-container-exit` は `--exit-code-from` がないため、コンテナの exit code がジョブに伝搬しない(ローカル実験で確認予定)。伝搬しない場合、クローラーが exit 1 してもジョブは緑になり、B4 の失敗通知が夜通知で機能しない。

**設計2**: `docker compose up --exit-code-from crawler` に変更(`--exit-code-from` は `--abort-on-container-exit` を含意)。朝・週間は `docker compose run` のため伝搬済みで変更不要。

### B4: ワークフロー失敗時LINE通知 + keepalive

**現状の問題**: アプリ内のエラー通知(B3)より前段の失敗(checkout・cache復元・Dockerビルド失敗・タイムアウト・トークン失効)は GitHub のメール通知頼み。さらに public リポジトリは**60日間コミット等の活動がないと scheduled workflow が自動無効化**され、通知がサイレント停止する(連鎖して7日でキャッシュも消える)。

**設計1(失敗通知)**: 3ワークフローの末尾(.env削除の後)に `if: failure()` のステップを追加し、curl で LINE Push を直接叩く。

```
⚠️ GitHub Actions ワークフローが失敗しました

ワークフロー: {workflow名}
実行ログ: {run URL}
```

- secrets はワークフローから直接参照(`.env` 削除後でも動作)
- curl 失敗時はステップを fail させず警告のみ(`|| echo`)。最後の砦であり、これ自体の失敗はもう打つ手がないため

**設計2(keepalive)**: `weekly-report.yml`(毎週実行)に、3つの scheduled workflow を workflow enable API(`gh api PUT /repos/{repo}/actions/workflows/{file}/enable`)で叩くステップを追加する。enable API の呼び出しは60日無効化タイマーをリセットする(keepalive-workflow プロジェクトで実証済みの手法)。ジョブに `permissions: actions: write` が必要。失敗しても週間レポート本体には影響させない(`continue-on-error` 相当の扱い)。

## テスト戦略

- 単体テスト: A1/A2/B1/B3 は node --test の既存パターンに追加(TDD: 先に失敗するテストを書く)
- ローカル検証: `.env` を使い `DRY_RUN=true` で朝通知・夜通知(DEVガード追加後)を実行し、実クロール〜メッセージ生成までの経路を確認
- 実送信検証: `sendPushMessage` の実動作を、テストと明記したメッセージで1回だけ実送信して確認
- ワークフロー: 構文は actionlint(なければ careful review)。cache 整合性チェック・失敗通知は本番の次回実行で観測(直接テスト不能なため、ロジックを最小・自明に保つ)

## 受け入れ基準

1. `npm test` が全件グリーン
2. `DRY_RUN=true` の夜・朝通知ローカル実行で、実クロール後に正しいプレビューが出て、`data/` のファイルが変更されない
3. 3エントリポイントに素の fetch 直書きが残っていない(`grep 'api.line.me' src/` が notifier.js とワークフローのみ)
4. 夜通知の両クロール失敗パスで「変更なし」メッセージが送られない(テストで検証)
5. 成功時の通知メッセージ内容が変更前と同一(既存テストの期待値が無変更で通ることで担保)
