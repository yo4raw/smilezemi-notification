# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# smilezemi-notification

スマイルゼミ「みまもるネット」の自動クローリング & LINE通知システム。
GitHub Actionsで定期実行し、子供の学習状況をLINEに自動通知する。

## Architecture Overview

### System Flow

```text
GitHub Actions (cron) → Docker → Playwright (headless Chromium)
  → みまもるネット ログイン → データクローリング → ストリーク更新 → LINE / Discord 通知
  → 状態を Turso に保存
```

### Three Entry Points

1. **日次通知** (`src/index.js`): 毎日 JST 20:00 に実行。両コース(小学生・中学生)の当日分を速報通知。ストリーク・おたすけ・ボーナス・勉強時間は表示せず(翌朝の確定通知がカバーする)、`streak_data` は免除日の判定にだけ読む。**LINE送信数節約のため、当日のストリーク要件未達のユーザーが1人でもいる日だけLINEに送信**（全員達成日はLINEに送らず、断り行を付けてDiscordのみに記録する）
2. **朝通知** (`src/morning-index.js`): 毎日 JST 7:00 に実行。両コース(小学生・中学生)の前日確定分を通知。前日は確定データのためストリークを確定する(唯一の確定点)
3. **月次ボーナス清算** (`src/monthly-bonus-index.js`): 毎月1日 JST 8:00 に実行。前月分のボーナスポイントを子供ごとに通知して0にリセット。クロール不要のためブラウザを起動しない

※ 週間レポート通知は LINE 送信数削減のため 2026-07 に廃止（コードごと削除。必要なら git 履歴から復元）

### Workflows

3本とも `.github/workflows/run-in-docker.yml`（`workflow_call` の再利用ワークフロー）を `secrets: inherit` で呼ぶ。`.env` 作成と必須シークレットの検証、Docker ビルド、目標時刻(JST)までの待機、実行、`.env` 削除、失敗通知(LINE→失敗時のみDiscord)はすべてそこに1回だけ書いてある。呼び出し側は cron・コマンド・目標時刻・タイムアウトだけを持つ。

- `.github/workflows/crawler.yml` → `docker compose up --exit-code-from crawler`（`node src/index.js`）
- `.github/workflows/morning-crawler.yml` → `docker compose run --rm crawler node src/morning-index.js`
- `.github/workflows/monthly-bonus.yml` → `docker compose run --rm crawler node src/monthly-bonus-index.js`（月末候補日28-31のUTC 22:47起動 + `date-guard` ジョブのJST日付ガードで「1日」のみ実行）

### データ永続化 (Turso)

ストリークデータは Turso（libSQL）の `app_state` テーブルに1キー1JSONドキュメントで保存する。`data/` ディレクトリは使わない。

- アクセス層は `src/store.js`。Turso の HTTP API（`/v2/pipeline`）を `fetch` で直接叩き、`@libsql/client` は入れない（本番依存を playwright のみに保つため）
- キーは `streak_data` の1つ（バージョンは v1.4 固定。〜1.3 の移行コードは Turso 移行時に全データが 1.4 になったため削除済みで、1.4 以外は読み込みエラーにする）。かつて夜通知が差分比較に使っていた `mission_data` キーは 2026-09 に廃止した（夜通知は1日1回なので「前回」は前日分になり、講座がほぼ全件 NEW 扱いになるだけだった）。Turso 上の行は残っているが誰も読まない
- 書き込みは `app_state` の upsert 1文だけを送り、`state_audit` への履歴追記はトリガーが行う。Turso の pipeline は文がエラーでも HTTP 200 を返し文ごとに独立して実行されるため、2文に分けると片方だけ成立しうる。トリガーは同じ暗黙のトランザクションで動くので現在値と履歴が必ず揃う
- `state_audit` は追記専用の履歴。`bonus` は実際に支給するお小遣いなので、誤って壊したときに復元できる状態を保つために置いている
- **`readState` は3状態を返す**: `'ok'`（行がある）/ `'empty'`（テーブルはあるが行がない = 初回実行）/ `'uninitialized'`（テーブルがない = 移行前）。`'uninitialized'` を `'empty'` と同一視すると、確定処理が全ユーザーを新規扱いして連続日数を 0 にリセットするため、必ず区別する
- **`writeState` はテーブルを作成しない**。スキーマ（`app_state` / `state_audit` / トリガー）は 2026-08-27 の移行時に作成済みで、移行スクリプトとワークフローは削除した。ランタイムが自動作成すると未移行を検知できなくなる
- 障害時は通知を優先し記録を諦める。読めなければストリークなしで通知し、書けなければその日の確定をあきらめて終了コード1にする。書き込みだけは1秒後に1度リトライする
- 詳細: `docs/superpowers/specs/2026-08-27-turso-migration-design.md`

### ストリーク（連続学習日数）機能

`src/streak.js`（Turso の `streak_data` キー）。仕様詳細は `docs/superpowers/specs/2026-07-13-streak-notification-design.md`。**ストリーク確定は朝通知が両コースまとめて前日分で行う(唯一の確定点)。夜通知は速報で、ストリーク値を一切表示しない(当日の要件達成判定だけをLINE送信可否に使う)。夜通知も `streak_data` は読むが、免除日(`exemptDates`)を見るためだけで、確定も表示もしない。**

- 学習判定は完了数のみで行う（勉強時間は見ない）: **小学生コースは学習4件以上、中学生コースは3件以上の完了講座**が必須。小学生コースの「学習件数」にはミッションとして配信された講座に加え、**子どもが自主的に取り組んだ講座（ミッションバッジのない行）も含む**。スターアプリはゲーム性が強いため学習に含めない。閾値は `STREAK_REQUIREMENTS`（`src/streak.js`）に集約されており、変更時はここだけ書き換える。学習した日は `streak += 1`、連続10日ごとに「おたすけ」+1（上限3）。**おたすけ満タン(3)中は学習した日ごとに毎日「ボーナスポイント」+1**（満タン中はマイルストーン判定なし。`bonus`フィールド。リセットでも消えず、毎月1日の月次清算通知で0にリセットしてお小遣いとして支給）。月次清算通知ではコース別単価（小学生コース 1P=¥30 / 中学生コース 1P=¥50）で金額に換算し、各ユーザーの金額と全員分の合計を表示する。単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN` に集約されており、変更時はここだけ書き換える。コースの判定は `streak_data` の `course` フィールド（朝通知の確定処理が保存する）で行い、未設定・未知の値は小学生コース扱いにする。詳細: `docs/superpowers/specs/2026-08-03-monthly-bonus-course-rate-design.md`。**初期おたすけは1**（初回特典。`streak_data` v1.0→v1.1移行で既存ユーザーも最低1に引き上げ）。streak 0 のときは消費せず、リセット後は0から再スタート
- 夜・朝通知とも完了数未達のユーザーに警告行を表示する。しきい値は `missionWarningThresholds`、文言は `missionWarningStyle`（夜=`today`「🚨🚨 あと◯件! がんばろう! 🚨🚨」/ 朝=`past`「😢😢 あと◯件たりなかった… 😢😢」）で切り替える。残り件数だけを出すためコース別の表記差はない。`dataReliable: false` のユーザーと、朝通知で完全未学習（「昨日は学習していません」表示）の日には出さない。`dataReliable: false` のユーザーには代わりに `⚠️ データを取得できませんでした` の1行を出す（学習件数0件との区別がつかなくなるのを防ぐため）
- 未学習日はおたすけを自動消費してストリーク維持（+1しない）。尽きたらストリーク・おたすけとも0にリセット
- **免除日（おやすみ）**: `exemptDates` に登録した日は未学習でもストリークをリセットせず、おたすけも消費しない（イベント `exempt`）。免除日に学習していれば通常どおり加算される。`streak`・`grace` は各ユーザーの学習履歴（`history`: 判定対象日→学習が成立したか、最新の判定日から90日より前は畳み込む）を `replayStreak()` でリプレイして導出するため、**過去日付を後から免除に指定すると確定済みの判定が巻き戻って修復される**。`bonus` はリプレイ対象外（支給済みの現金のため）。履歴より古い日（90日超・機能導入前）は修復できず、その場合は streak/grace の手動変更スキルを使う。詳細: `docs/superpowers/specs/2026-08-17-study-exemption-design.md`
- **前日分を翌日に確定判定**（20時以降の学習も翌日に正しく反映）
- 学習履歴に同じ日のキーがあれば再確定しないため同日再実行は冪等。未判定の空白日は中立扱い（ペナルティなし）
- クローラーの詳細取得が失敗したユーザーは `dataReliable: false` が付き、未学習に見えても確定判定をスキップ（誤リセット防止）
- **朝通知の `loadStreakData()` 失敗時は理由を問わず確定処理と保存を丸ごとスキップする**（未初期化・一過性のネットワーク障害いずれも同じ扱い）。空状態で確定して書き戻すと全ユーザーの `streak`/`grace`/`bonus`（現金で支給するお小遣い）を恒久的に失うため、あえて自己修復しない。確定はhistoryベース(`confirmDayWithHistory`/`replayStreak`)なので連続記録自体は壊れないが、スキップした日の `streak +1`（おたすけ満タン中は `bonus +1` も）は加算されず失われる。必要なら `scripts/set-streak-field.js` で手動補修する

## Project Structure

```text
src/
├── index.js                  # メインエントリ（日次通知・両コース・当日速報）
├── morning-index.js          # 朝通知エントリ（両コース・前日確定）
├── monthly-bonus-index.js    # 月次ボーナス清算エントリ（ブラウザ非依存）
├── config.js                 # 環境変数管理・マスキング (loadConfig, validateSecrets, maskSensitiveData, maskLiterals)
├── config/
│   └── selectors.js          # DOMセレクタ定義（login, sidebar, courseSelection, elementaryTimeline, juniorHighTimeline）
├── auth.js                   # 認証モジュール (login)
├── crawler.js                # クローリング (getUserList, getAllUsersDetailedData, getCourseData, getTargetDates, saveErrorScreenshot)
├── streak.js                 # ストリーク管理 (confirmDay, confirmDayWithHistory, replayStreak, collapseHistory, updateStreaks, formatStreakInfo, load/saveStreakData)
├── notifier.js               # LINE通知 (sendPushMessage, formatDetailedMessage, truncateToLimit)
├── discord.js                # Discord Webhook通知 (sendDiscordMessage, splitIntoChunks, maskWebhookUrl)
├── line-quota.js             # LINE送信枠 (fetchQuotaStatus: 残数取得 / formatQuotaLine: 残数行の整形)
├── broadcast.js              # 送信層 (broadcastToAll: 常に両方 / broadcastToDiscordOnly: Discordのみ / getDiscordFailure: Discord失敗の抽出)
├── retry.js                  # 指数バックオフ付きリトライ (auth / notifier / discord が共用)
└── store.js                  # Turso(libSQL)の状態ストア (readState/writeState)

tests/                        # Node.js built-in test runner (node --test)
scripts/                      # show-streak-data.js, set-streak-field.js, set-exempt-dates.js (運用スクリプト)

.github/workflows/
├── run-in-docker.yml         # 共通手順 (workflow_call): .env作成・検証 → build → JST待機 → 実行 → 失敗通知
├── crawler.yml               # 日次クローリング・両コース (UTC 06:17起動→JST 20:00まで待機)
├── morning-crawler.yml       # 朝通知・両コース (UTC 17:47起動→JST 7:00まで待機)
├── monthly-bonus.yml         # 月次ボーナス清算 (月末候補日起動 + JST1日ガード → JST 8:00)
└── ci.yml                    # テストとlint、Dockerビルド
```

### ストリーク値の手動変更 (運用スキル)

grace(おたすけ)・streak(連続日数)・bonus・免除日は Turso にあり、**ローカルから直接読み書きする**。`.env` に `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` が必要。スクリプトは `.env` を自動で読まないため `--env-file=.env` を付けて実行する（Node 20.6+ 標準機能。dotenv は使わない）。

- 現在値の確認（読み取り専用）: `node --env-file=.env scripts/show-streak-data.js`
- 1ユーザーの1フィールドを絶対値で設定: `node --env-file=.env scripts/set-streak-field.js --user "名前" --field grace --value 3 [--dry-run]`
- 免除日の登録・取り消し: `node --env-file=.env scripts/set-exempt-dates.js ...`

検証（フィールド種別・範囲・既存ユーザーのみ）はスクリプトに集約されている。フィールドごとに `.claude/skills/smilezemi-set-{grace,streak,bonus}` の3スキルへ分離し、各スキルは自分の field のみ渡して誤操作を防ぐ。免除日は `.claude/skills/smilezemi-exempt-day`。

以前は actions/cache にしかデータがなかったため workflow_dispatch 経由で操作していたが、Turso 移行で不要になった。これにより公開リポジトリのログに実名が残らなくなり、main 以外のブランチから実行すると変更が黙って無効になる罠も消えた。

## Tech Stack

- **Runtime**: Node.js >= 20.6.0（`--env-file` / `AbortSignal.timeout` / `String.prototype.isWellFormed` / `util.parseArgs` を使う。CI は 24）
- **Browser Automation**: Playwright (Chromium headless)
- **Notification**: LINE Messaging API (Push Message, REST直接呼出)
- **CI/CD**: GitHub Actions + Docker (mcr.microsoft.com/playwright)
- **Data Store**: Turso (libSQL) — HTTP API を fetch で直叩き（SDK なし）
- **Module System**: CommonJS (`require`/`module.exports`)
- **Test**: Node.js built-in test runner (`node --test`)
- **Dependencies**: playwright (prod), oxlint (dev)。dotenv は使わず `node --env-file=.env` で読む

## Common Commands

```bash
npm test                  # 全テスト実行
node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js
                          # 単一テストファイル実行（オプション2つは必須）
npm run lint              # oxlintでsrc/をlint（--deny-warningsで警告もエラー扱い）
npm run lint:fix          # oxlintで自動修正
npm run docker:build      # Dockerイメージビルド

# ローカル実行（.envは自動読込されないため --env-file=.env が必須）
DRY_RUN=true node --env-file=.env src/morning-index.js   # 朝通知ドライラン（LINE送信・streak保存なし）
DRY_RUN=true node --env-file=.env src/index.js           # 夜通知ドライラン（LINE送信なし）
DRY_RUN=true node --env-file=.env src/monthly-bonus-index.js  # 月次清算ドライラン（送信・リセットなし）
```

## Environment Variables

`SMILEZEMI_USERNAME`, `SMILEZEMI_PASSWORD`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
(GitHub Secretsまたは`.env`ファイルで管理。本番はdocker composeのenv_file経由)

任意: `DISCORD_WEBHOOK_URL`（全通知の送信先。LINEの成否にかかわらず常にDiscordへも送る。未設定ならDiscordへ送らず従来どおりLINEのみ）

### LINE送信数の制約（重要）

送信先はLINEグループで、グループへのpushは**メッセージ数×グループ人数**でカウントされる（4人グループ=1通知4カウント）。無料プランの月間上限は200カウントで、朝夜とも毎日送ると構造的に超過する。対策として**夜通知は「当日のストリーク要件未達のユーザーが1人でもいる日」だけLINEに送信**し（全員達成の日はLINEに送らず、断り行付きでDiscordのみに記録。朝・月次は無条件送信）、週間レポート通知は廃止した。詳細: `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md` と `docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md`

- 通知を増やす変更をする際は必ず月間カウントを見積もること（固定分≈128=朝124+月次4、夜通知の残枠≈72=月18日分）
- 1つのLINEグループに公式アカウント(bot)は1つしか入れないため、チャンネル追加で枠を増やす手は使えない
- 上限超過時はLINE APIが429を返す。notifier.jsは429を非リトライで即失敗させ、レスポンスボディの理由をログに残す
- **全通知をLINEとDiscordの両方へ送る**（`src/broadcast.js` の `broadcastToAll`）。LINEの成否にかかわらずDiscordへも送るため、Discordが常時の記録先になる。唯一の例外は夜通知の全員達成日で、この日はLINEを使わずDiscordのみに記録する（`broadcastToDiscordOnly`）。Discordには月間送信数の上限がない。詳細: `docs/superpowers/specs/2026-08-03-always-dual-notification-design.md`
- LINE送信が失敗した場合（429の枠切れ・401・ネットワーク障害すべて）、Discordへ送る本文の先頭に失敗理由の行が付く。LINEが成功した回は本文だけを送る
- **LINEを使う通知の末尾には残り送信可能数の行を付ける**（`📮 LINE残り: 139/200（あと34回）`）。`src/line-quota.js` が LINE API の `/message/quota`・`/message/quota/consumption`・`/{group|room}/{id}/members/count` を叩き、`broadcastToAll` が送信直前に本文の末尾へ足す。カウントは `メッセージ数×人数` なので「あと◯回」は `floor(残カウント / 人数)`。`LINE_USER_ID` の先頭文字で宛先種別を判定する（`C`=グループ / `R`=ルーム / それ以外=個人扱いで1人・APIを叩かない）。数値は**送信前**の値。末尾に置いた行が5000文字の切り詰めで落ちないよう、LINEへは本文を「5000−残数行」で先に縮めてから足す。取得に失敗しても行を落として通知は必ず送る（リトライなし・タイムアウト5秒）。`broadcastToDiscordOnly`（夜の全員達成日）はLINEを消費しないため付けずAPIも叩かない。DRY_RUNプレビューは `broadcastToAll` を通らないためこの行が出ない
- **Discordは2000文字を超える本文を分割して複数通で送る**（`src/discord.js` の `splitIntoChunks`）。行の境界で詰め、2通以上になる場合は各通の先頭に `(1/3)` を付ける。途中の通が失敗しても残りは送り、1つでも失敗すればDiscord送信全体を失敗として扱う。LINEは分割せず5000文字で切り詰める（分割するとメッセージ数×人数で枠を圧迫するため）。詳細: `docs/superpowers/specs/2026-08-03-discord-message-split-design.md`
- 通知の成否は「1つ以上の宛先に届いたか」で判定する。LINEだけ失敗してもワークフローは赤くしない。一方**Discordだけの失敗は全エントリポイントで終了コード1にする**（Webhook失効を翌日に検知するため）。判定は `getDiscordFailure()` に集約されており、`DISCORD_WEBHOOK_URL` 未設定の環境は「宛先がない」だけなので赤くしない

## Key Design Decisions

- **Playwright over Puppeteer**: GitHub Actions環境との互換性、安定したセレクタAPI
- **LINE Messaging API**: LINE Notify API終了(2025/3/31)に伴う移行先。Push Message API使用
- **GitHub Actions + Docker**: インフラ管理不要、Secrets統合、無料枠で十分
- **毎回ログイン**: セッション永続化なし、ワークフロー終了時にクリーンアップ
- **グレースフルデグラデーション**: ユーザー単位の取得失敗は `dataReliable: false` を付けて通知に「⚠️ データを取得できませんでした」を出し、ストリーク確定をスキップする。クロール全体の失敗はエラー通知を送って終了コード1。ストリーク処理の失敗は errors に積みつつ通知自体は継続。かつての「基本モード（ミッション数のみ）フォールバック」は同じ `getUserList/switchToUser` を使い直すだけで詳細取得が全滅した状況では成功しえなかったため 2026-09 に削除した
- **関数の戻り値パターン**: I/O関数は `{success: boolean, data?/error?}` を返す。純粋関数（streak.jsの判定ロジック等）は値を直接返す
- **cron前倒し起動**: GitHub Actionsのscheduleは数時間遅延するため、前倒しcron + ワークフロー内sleepで目標時刻(JST)に実行する方式

## Testing Patterns

- `tests/index.test.js` / `tests/morning-index.test.js` は require.cache 直接注入でモジュール依存をモックする。`src/index.js` や `src/morning-index.js` に新しい require を追加したら `MODULE_PATHS` とモック登録の追加が必須
- `tests/streak.test.js` は `../src/store` を require.cache に注入してモックする。実ファイル I/O は使わない
- `streak_data` のユーザーキーは**本番では素の名前**（コース選択画面を経由しないユーザーには表示名にコース名が付かない）。テストfixtureで `"名前 (コース名)"` 形式を前提にすると本番と乖離する。コース依存の判定は必ず `course` フィールドで書く

## DOM操作パターン

- DOMセレクタは `src/config/selectors.js` に集約管理
- 日付は JST 基準の `getTargetDates(dateOffset)` を使う（GitHub ActionsはUTCのため明示補正済み）。MM/DD形式はゼロパディング必須、`dateString`(YYYY-MM-DD)がストリーク等のキー
- 座標ベースフィルタリング: `getCurrentUserName`/`switchToUser`/`returnToCourseSelection` は右上のユーザー名エリアを `boundingBox()` の位置（画面右半分かつ上部20%）で識別し、`checkCourseSelection` はコース選択ボタンの中心座標がviewport内に収まっているかで実体表示を判定する。タイムラインの日付検索には使わない（次項の日ブロック単位での構造分離を使う）
- 小学生コースのタイムラインは `[class*="dailyTimeline__"]` の日ブロック単位で構造分離されているため、日付の切り分けに座標計算は不要（中学生コースは `dailyRoot__`）。DOM構造の詳細は `docs/DOM_STRUCTURE.md` を参照する
- タイムラインに掲載されているミッション = 実施済み(完了)。NEWラベルは未読バッジであり完了/未完了とは無関係
- 位置ベース範囲計算: boundingBox()でY座標範囲を計算しセクション分離
- `getCourseData` は対象日の日ブロックを1回だけ抽出し（小学生=`extractElementaryDay` の1回の `page.evaluate`、中学生=`extractJuniorHighDay`）、勉強時間・学習件数・講座詳細をまとめて組み立てる。日ブロックが1件も無い（未描画/セレクタ破損）か抽出が例外なら `dataReliable: false` を付け、対象日が見つからないだけなら正当な0件として `dataReliable: true`
- セレクタ変更時は実サイトで確認後に更新すること

## Development Rules

- Follow the user's instructions precisely, and within that scope act autonomously
- Think in English, generate responses in Japanese
- All Markdown content written to project files MUST be written in Japanese
