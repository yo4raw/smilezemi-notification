# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# smilezemi-notification

スマイルゼミ「みまもるネット」の自動クローリング & LINE通知システム。
GitHub Actionsで定期実行し、子供の学習状況をLINEに自動通知する。

## Architecture Overview

### System Flow

```text
GitHub Actions (cron) → actions/cacheでdata/復元 → Docker → Playwright (headless Chromium)
  → みまもるネット ログイン → データクローリング → 差分比較・ストリーク更新 → LINE Push通知
  → data/をactions/cacheに保存(次回実行に引き継ぎ)
```

### Three Entry Points

1. **日次通知** (`src/index.js`): 毎日 JST 20:00 に実行。両コース(小学生・中学生)の当日分を速報通知。**本文は当日のストリーク要件の達成状況ごとにユーザー名を並べるだけにする**（`formatUnqualifiedMessage`。学習件数・ミッション詳細・勉強時間・ストリーク・おたすけ・ボーナスはいずれも出さず、翌朝の確定通知がカバーする）。`streak_data.json` は免除日の判定にだけ読む。**LINE送信数節約のため、未達のユーザーが1人でもいる日だけLINEに送信**（全員達成日はLINEに送らず、断り行を付けてDiscordのみに記録する）
2. **朝通知** (`src/morning-index.js`): 毎日 JST 7:00 に実行。両コース(小学生・中学生)の前日確定分を通知。前日は確定データのためストリークを確定する(唯一の確定点)
3. **月次ボーナス清算** (`src/monthly-bonus-index.js`): 毎月1日 JST 8:00 に実行。前月分のボーナスポイントを子供ごとに通知して0にリセット。クロール不要のためブラウザを起動しない

※ 週間レポート通知は LINE 送信数削減のため 2026-07 に廃止（コードごと削除。必要なら git 履歴から復元）

### Workflows

- `.github/workflows/crawler.yml` → `docker compose up` → `node src/index.js`
- `.github/workflows/morning-crawler.yml` → `docker compose run --rm crawler node src/morning-index.js`
- `.github/workflows/monthly-bonus.yml` → `docker compose run --rm crawler node src/monthly-bonus-index.js`（月末候補日28-31のUTC 22:47起動 + JST日付ガードで「1日」のみ実行）

### データ永続化 (actions/cache)

GitHub Actions はクリーンな checkout から始まるため、`data/` ディレクトリ（`mission_data.json` + `streak_data.json`）を actions/cache で実行間引き継ぎする:

- restore: key prefix `smilezemi-data-` の restore-keys 一致で最新キャッシュを復元
- save: `smilezemi-data-${{ github.run_id }}` で毎回新規エントリを保存（`if: always()` — 通知失敗でも確定済みデータを保持）
- 夜(20:00)→翌朝(7:00)→翌夜と、両ワークフローが同一キャッシュ系列を交互に更新する
- キャッシュ消失時はストリーク0から再開（許容済みトレードオフ）

### ストリーク（連続学習日数）機能

`src/streak.js` + `data/streak_data.json`。仕様詳細は `docs/superpowers/specs/2026-07-13-streak-notification-design.md`。**ストリーク確定は朝通知が両コースまとめて前日分で行う(唯一の確定点)。夜通知は速報で、ストリーク値を一切表示しない(当日の要件達成判定を未達ユーザー名の抽出とLINE送信可否に使う)。夜通知も `streak_data.json` は読むが、免除日(`exemptDates`)を見るためだけで、確定も表示もしない。**

- 学習判定は完了数のみで行う（勉強時間は見ない）: **小学生コースは学習4件以上、中学生コースは3件以上の完了講座**が必須。小学生コースの「学習件数」にはミッションとして配信された講座に加え、**子どもが自主的に取り組んだ講座（ミッションバッジのない行）も含む**。スターアプリはゲーム性が強いため学習に含めない。閾値は `STREAK_REQUIREMENTS`（`src/streak.js`）に集約されており、変更時はここだけ書き換える。学習した日は `streak += 1`、連続10日ごとに「おたすけ」+1（上限3）。**おたすけ満タン(3)中は学習した日ごとに毎日「ボーナスポイント」+1**（満タン中はマイルストーン判定なし。`bonus`フィールド。リセットでも消えず、毎月1日の月次清算通知で0にリセットしてお小遣いとして支給）。月次清算通知ではコース別単価（小学生コース 1P=¥30 / 中学生コース 1P=¥50）で金額に換算し、各ユーザーの金額と全員分の合計を表示する。単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN` に集約されており、変更時はここだけ書き換える。コースの判定は `streak_data.json` の `course` フィールド（朝通知の確定処理が保存する）で行い、未設定・未知の値は小学生コース扱いにする。詳細: `docs/superpowers/specs/2026-08-03-monthly-bonus-course-rate-design.md`。**初期おたすけは1**（初回特典。`streak_data.json` v1.0→v1.1移行で既存ユーザーも最低1に引き上げ）。streak 0 のときは消費せず、リセット後は0から再スタート
- 夜通知はユーザー名だけを見出しごとに並べる: 未達は `🚨 まだ今日のノルマが終わっていません`、達成は `✅ 今日のノルマが終わりました`、免除日は `🏝️ 今日はおやすみ（免除日）`（免除日は未達にも達成にも数えない）。未達も取得失敗もいない日の達成の見出しは `✅ 全員が本日のノルマを達成しました`（免除日のユーザーがいる日は `✅ おやすみの人以外は本日のノルマを達成しました`）に変わる。該当者がいない見出しは出さない
- 朝通知は完了数未達のユーザーに警告行「😢😢 あと◯件たりなかった… 😢😢」を表示する。しきい値は `missionWarningThresholds` で渡す。残り件数だけを出すためコース別の表記差はない。`exemptUserNames`（免除日）と `dataReliable: false` のユーザー、完全未学習（「昨日は学習していません」表示）の日には出さない
- `dataReliable: false`（データ取得失敗）のユーザーは未達と断定できないため別扱いにする。夜通知は `⚠️ データを取得できませんでした` の見出しの下に名前を並べ、この日はLINEにも送る（見逃し防止）。朝通知は未達警告の代わりに `⚠️ データを取得できませんでした` の1行を出す（学習件数0件との区別がつかなくなるのを防ぐため）
- 未学習日はおたすけを自動消費してストリーク維持（+1しない）。尽きたらストリーク・おたすけとも0にリセット
- **免除日（おやすみ）**: `exemptDates` に登録した日は未学習でもストリークをリセットせず、おたすけも消費しない（イベント `exempt`）。免除日に学習していれば通常どおり加算される。`streak`・`grace` は各ユーザーの学習履歴（`history`: 判定対象日→学習が成立したか、最新の判定日から90日より前は畳み込む）を `replayStreak()` でリプレイして導出するため、**過去日付を後から免除に指定すると確定済みの判定が巻き戻って修復される**。`bonus` はリプレイ対象外（支給済みの現金のため）。履歴より古い日（90日超・機能導入前）は修復できず、その場合は streak/grace の手動変更スキルを使う。詳細: `docs/superpowers/specs/2026-08-17-study-exemption-design.md`
- **前日分を翌日に確定判定**（20時以降の学習も翌日に正しく反映）
- 学習履歴に同じ日のキーがあれば再確定しないため同日再実行は冪等。未判定の空白日は中立扱い（ペナルティなし）
- クローラーの詳細取得が失敗したユーザーは `dataReliable: false` が付き、未学習に見えても確定判定をスキップ（誤リセット防止）
- `streak_data.json` 破損時はエラーを記録しつつ空状態で続行し、次回保存で自己修復する

## Project Structure

```text
src/
├── index.js                  # メインエントリ（日次通知・両コース・当日速報）
├── morning-index.js          # 朝通知エントリ（両コース・前日確定）
├── monthly-bonus-index.js    # 月次ボーナス清算エントリ（ブラウザ非依存）
├── config.js                 # 環境変数管理 (loadConfig, maskSensitiveData, validateSecrets)
├── config/
│   └── selectors.js          # DOMセレクタ定義（login, dashboard, missionDetails等）
├── auth.js                   # 認証モジュール (login, attemptLogin)
├── crawler.js                # クローリング (getUserList, getAllUsersDetailedData, getTargetDates等)
├── data.js                   # ミッションデータ永続化 (loadPreviousData, compareData, saveData)
├── streak.js                 # ストリーク管理 (confirmDay, confirmDayWithHistory, replayStreak, collapseHistory, updateStreaks, formatStreakInfo, load/saveStreakData)
├── notifier.js               # LINE通知 (sendNotification, formatDetailedMessage, truncateToLimit)
├── discord.js                # Discord Webhook通知 (sendDiscordMessage, splitIntoChunks, maskWebhookUrl)
└── broadcast.js              # 送信層 (broadcastToAll: 常に両方 / broadcastToDiscordOnly: Discordのみ / getDiscordFailure: Discord失敗の抽出)

tests/                        # Node.js built-in test runner (node --test)
scripts/                      # validate-env.js, validate-security.sh, test-docker.sh, set-exempt-dates.js 等

.github/workflows/
├── crawler.yml               # 日次クローリング・両コース (UTC 06:17起動→JST 20:00まで待機) + data/キャッシュ
├── morning-crawler.yml       # 朝通知・両コース (UTC 17:47起動→JST 7:00まで待機) + data/キャッシュ
├── monthly-bonus.yml         # 月次ボーナス清算 (月末候補日起動 + JST1日ガード → JST 8:00)
├── show-streak-data.yml      # 手動: ストリークデータ現在値の表示 (読み取り専用, workflow_dispatch)
├── adjust-streak-field.yml   # 手動: grace/streak/bonusを絶対値で変更しキャッシュ保存 (workflow_dispatch)
└── exempt-days.yml           # 手動: 免除日(おやすみ)の登録・取り消し (workflow_dispatch)
```

### ストリーク値の手動変更 (運用スキル)

grace(おたすけ)・streak(連続日数)・bonus は本番では actions/cache 内にのみ存在するため、手動変更は `adjust-streak-field.yml` (workflow_dispatch) で行う: キャッシュ復元 → `scripts/set-streak-field.js` で1ユーザーの1フィールドを絶対値設定 → 新run_idキーで保存 → 次回スケジュール実行で反映。検証(フィールド種別・範囲・既存ユーザーのみ)はスクリプトに集約。現在値確認は読み取り専用の `show-streak-data.yml` / `scripts/show-streak-data.js`。フィールドごとに `.claude/skills/smilezemi-set-{grace,streak,bonus}` の3スキルへ分離し、各スキルは自分のfieldのみ渡して誤操作を防ぐ。免除日（おやすみ）の登録・取り消しは別系統で、`exempt-days.yml` (workflow_dispatch) → `scripts/set-exempt-dates.js` → `.claude/skills/smilezemi-exempt-day` が担当する。対象(1人/`__all__`)と期間(最大31日)を指定し、過去日付はリプレイで修復される。`streak`・`grace` は学習履歴からの導出値のため、手動変更時は `collapseHistory()` で現在値をチェックポイントに畳み込む（その時点より前の遡及免除はできなくなる）。

## Tech Stack

- **Runtime**: Node.js >= 24.0.0
- **Browser Automation**: Playwright (Chromium headless)
- **Notification**: LINE Messaging API (Push Message, REST直接呼出)
- **CI/CD**: GitHub Actions + Docker (mcr.microsoft.com/playwright)
- **Module System**: CommonJS (`require`/`module.exports`)
- **Test**: Node.js built-in test runner (`node --test`)
- **Dependencies**: playwright (prod), dotenv (dev)

## Common Commands

```bash
npm test                  # 全テスト実行
node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js
                          # 単一テストファイル実行（オプション2つは必須）
npm run validate:all      # 全検証（env + security）
npm run lint              # oxlintでsrc/をlint（--deny-warningsで警告もエラー扱い）
npm run lint:fix          # oxlintで自動修正
npm run docker:build      # Dockerイメージビルド
npm run test:docker       # Docker環境テスト

# ローカル実行（.envは自動読込されないため -r dotenv/config が必須）
DRY_RUN=true node -r dotenv/config src/morning-index.js   # 朝通知ドライラン（LINE送信・streak保存なし）
DRY_RUN=true node -r dotenv/config src/index.js           # 夜通知ドライラン（LINE送信・データ/streak保存なし）
DRY_RUN=true node -r dotenv/config src/monthly-bonus-index.js  # 月次清算ドライラン（送信・リセットなし）
```

## Environment Variables

`SMILEZEMI_USERNAME`, `SMILEZEMI_PASSWORD`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`
(GitHub Secretsまたは`.env`ファイルで管理。本番はdocker composeのenv_file経由)

任意: `DISCORD_WEBHOOK_URL`（全通知の送信先。LINEの成否にかかわらず常にDiscordへも送る。未設定ならDiscordへ送らず従来どおりLINEのみ）

### LINE送信数の制約（重要）

送信先はLINEグループで、グループへのpushは**メッセージ数×グループ人数**でカウントされる（4人グループ=1通知4カウント）。無料プランの月間上限は200カウントで、朝夜とも毎日送ると構造的に超過する。対策として**夜通知は「当日のストリーク要件未達、またはデータ取得失敗のユーザーが1人でもいる日」だけLINEに送信**し（全員達成の日はLINEに送らず、断り行付きでDiscordのみに記録。朝・月次は無条件送信）、週間レポート通知は廃止した。詳細: `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md` と `docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md`

- 通知を増やす変更をする際は必ず月間カウントを見積もること（固定分≈128=朝124+月次4、夜通知の残枠≈72=月18日分）
- 1つのLINEグループに公式アカウント(bot)は1つしか入れないため、チャンネル追加で枠を増やす手は使えない
- 上限超過時はLINE APIが429を返す。notifier.jsは429を非リトライで即失敗させ、レスポンスボディの理由をログに残す
- **全通知をLINEとDiscordの両方へ送る**（`src/broadcast.js` の `broadcastToAll`）。LINEの成否にかかわらずDiscordへも送るため、Discordが常時の記録先になる。唯一の例外は夜通知の全員達成日で、この日はLINEを使わずDiscordのみに記録する（`broadcastToDiscordOnly`）。Discordには月間送信数の上限がない。詳細: `docs/superpowers/specs/2026-08-03-always-dual-notification-design.md`
- LINE送信が失敗した場合（429の枠切れ・401・ネットワーク障害すべて）、Discordへ送る本文の先頭に失敗理由の行が付く。LINEが成功した回は本文だけを送る
- **Discordは2000文字を超える本文を分割して複数通で送る**（`src/discord.js` の `splitIntoChunks`）。行の境界で詰め、2通以上になる場合は各通の先頭に `(1/3)` を付ける。途中の通が失敗しても残りは送り、1つでも失敗すればDiscord送信全体を失敗として扱う。LINEは分割せず5000文字で切り詰める（分割するとメッセージ数×人数で枠を圧迫するため）。詳細: `docs/superpowers/specs/2026-08-03-discord-message-split-design.md`
- 通知の成否は「1つ以上の宛先に届いたか」で判定する。LINEだけ失敗してもワークフローは赤くしない。一方**Discordだけの失敗は全エントリポイントで終了コード1にする**（Webhook失効を翌日に検知するため）。判定は `getDiscordFailure()` に集約されており、`DISCORD_WEBHOOK_URL` 未設定の環境は「宛先がない」だけなので赤くしない

## Key Design Decisions

- **Playwright over Puppeteer**: GitHub Actions環境との互換性、安定したセレクタAPI
- **LINE Messaging API**: LINE Notify API終了(2025/3/31)に伴う移行先。Push Message API使用
- **GitHub Actions + Docker**: インフラ管理不要、Secrets統合、無料枠で十分
- **毎回ログイン**: セッション永続化なし、ワークフロー終了時にクリーンアップ
- **グレースフルデグラデーション**: 詳細取得失敗時は基本モード（ミッション数のみ）にフォールバック。ストリーク処理の失敗は errors に積みつつ通知自体は継続
- **関数の戻り値パターン**: I/O関数は `{success: boolean, data?/error?}` を返す。純粋関数（streak.jsの判定ロジック等）は値を直接返す
- **cron前倒し起動**: GitHub Actionsのscheduleは数時間遅延するため、前倒しcron + ワークフロー内sleepで目標時刻(JST)に実行する方式

## Testing Patterns

- `tests/index.test.js` は require.cache 直接注入でモジュール依存(config/auth/crawler/data/notifier/streak/playwright)をモックする。`src/index.js` に新しい require を追加したら `MODULE_PATHS` とモック登録の追加が必須
- `tests/data.test.js` / `tests/streak.test.js` のI/Oテストは実ファイル(`data/*.json`)を使い beforeEach/afterEach で掃除する
- `tests/morning-index.test.js` はエクスポート確認のみの軽量パターン
- `streak_data.json` のユーザーキーは**本番では素の名前**（コース選択画面を経由しないユーザーには表示名にコース名が付かない）。テストfixtureで `"名前 (コース名)"` 形式を前提にすると本番と乖離する。コース依存の判定は必ず `course` フィールドで書く

## DOM操作パターン

- DOMセレクタは `src/config/selectors.js` に集約管理
- 日付は JST 基準の `getTargetDates(dateOffset)` を使う（GitHub ActionsはUTCのため明示補正済み）。MM/DD形式はゼロパディング必須、`dateString`(YYYY-MM-DD)がストリーク等のキー
- 座標ベースフィルタリング: `getCurrentUserName`/`switchToUser`/`returnToCourseSelection` は右上のユーザー名エリアを `boundingBox()` の位置（画面右半分かつ上部20%）で識別し、`checkCourseSelection` はコース選択ボタンの中心座標がviewport内に収まっているかで実体表示を判定する。タイムラインの日付検索には使わない（次項の日ブロック単位での構造分離を使う）
- 小学生コースのタイムラインは `[class*="dailyTimeline__"]` の日ブロック単位で構造分離されているため、日付の切り分けに座標計算は不要（中学生コースは `dailyRoot__`）。DOM構造の詳細は `docs/DOM_STRUCTURE.md` を参照する
- タイムラインに掲載されているミッション = 実施済み(完了)。NEWラベルは未読バッジであり完了/未完了とは無関係
- 位置ベース範囲計算: boundingBox()でY座標範囲を計算しセクション分離
- クローラーのサブ取得は「データなし」を success:true + ゼロ値で返し、例外時のみ success:false。`getCourseData` は後者を `dataReliable: false` としてユーザーデータに伝搬する
- セレクタ変更時は実サイトで確認後に更新すること

## Development Rules

- Follow the user's instructions precisely, and within that scope act autonomously
- Think in English, generate responses in Japanese
- All Markdown content written to project files MUST be written in Japanese
