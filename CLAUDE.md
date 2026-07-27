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

1. **日次通知** (`src/index.js`): 毎日 JST 20:00 に実行。両コース(小学生・中学生)の当日分を速報通知。ストリークは確定値＋当日暫定+1を表示するのみで確定・保存しない。**送信数節約のため、当日のストリーク要件未達のユーザーが1人でもいる日だけ送信**（全員達成日はデータ保存のみ）
2. **朝通知** (`src/morning-index.js`): 毎日 JST 7:00 に実行。両コース(小学生・中学生)の前日確定分を通知。前日は確定データのためストリークを確定する(唯一の確定点)
3. **月次ボーナス清算** (`src/monthly-bonus-index.js`): 毎月1日 JST 8:00 に実行。前月分のボーナスポイントを子供ごとに通知して0にリセット。クロール不要のためブラウザを起動しない。LINEの成否にかかわらずDiscordにも送り、Webhook失効の定期検知を兼ねる

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

`src/streak.js` + `data/streak_data.json`。仕様詳細は `docs/superpowers/specs/2026-07-13-streak-notification-design.md`。**ストリーク確定は朝通知が両コースまとめて前日分で行う(唯一の確定点)。夜通知は速報で、確定値＋当日暫定+1を表示するのみ。**

- 学習判定は完了数のみで行う（勉強時間は見ない）: **小学生コースは完了ミッション4個以上、中学生コースは平日3個・土日5個以上の完了講座**が必須（判定対象日の曜日で決まる。祝日は曜日のみで判定）。閾値は `STREAK_REQUIREMENTS`（`src/streak.js`）に集約されており、変更時はここだけ書き換える。中学生の曜日別しきい値は `getJuniorHighRequirement(dateString)` で取得する。学習した日は `streak += 1`、連続10日ごとに「おたすけ」+1（上限3）。**おたすけ満タン(3)中は学習した日ごとに毎日「ボーナスポイント」+1**（満タン中はマイルストーン判定なし。`bonus`フィールド。リセットでも消えず、毎月1日の月次清算通知で0にリセットしてお小遣いとして支給）。月次清算通知ではコース別単価（小学生コース 1P=¥30 / 中学生コース 1P=¥50）で金額に換算し、各ユーザーの金額と全員分の合計を表示する。単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN` に集約されており、変更時はここだけ書き換える。**初期おたすけは1**（初回特典。`streak_data.json` v1.0→v1.1移行で既存ユーザーも最低1に引き上げ）。streak 0 のときは消費せず、リセット後は0から再スタート
- 夜・朝通知とも完了数未達のユーザーに警告行（`missionWarningThresholds`、コース別に小学生=ミッション表記/中学生=講座表記）を表示する。`dataReliable: false` のユーザーと、朝通知で完全未学習（「昨日は学習していません」表示）の日には出さない
- 未学習日はおたすけを自動消費してストリーク維持（+1しない）。尽きたらストリーク・おたすけとも0にリセット
- **前日分を翌日に確定判定**（20時以降の学習も翌日に正しく反映）。夜通知は「確定+当日学習済なら暫定+1」を表示
- `lastConfirmedDate` で同日再実行は冪等。未判定の空白日は中立扱い（ペナルティなし）
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
├── streak.js                 # ストリーク管理 (confirmDay, updateStreaks, formatStreakInfo, load/saveStreakData)
├── notifier.js               # LINE通知 (sendNotification, formatDetailedMessage, truncateToLimit)
├── discord.js                # Discord Webhook通知 (sendDiscordMessage, maskWebhookUrl)
└── broadcast.js              # 送信層 (broadcastMessage: LINE→失敗時のみDiscord / broadcastToAll: 常に両方)

tests/                        # Node.js built-in test runner (node --test)
scripts/                      # validate-env.js, validate-security.sh, test-docker.sh 等

.github/workflows/
├── crawler.yml               # 日次クローリング・両コース (UTC 06:17起動→JST 20:00まで待機) + data/キャッシュ
├── morning-crawler.yml       # 朝通知・両コース (UTC 17:47起動→JST 7:00まで待機) + data/キャッシュ
├── monthly-bonus.yml         # 月次ボーナス清算 (月末候補日起動 + JST1日ガード → JST 8:00)
├── show-streak-data.yml      # 手動: ストリークデータ現在値の表示 (読み取り専用, workflow_dispatch)
└── adjust-streak-field.yml   # 手動: grace/streak/bonusを絶対値で変更しキャッシュ保存 (workflow_dispatch)
```

### ストリーク値の手動変更 (運用スキル)

grace(おたすけ)・streak(連続日数)・bonus は本番では actions/cache 内にのみ存在するため、手動変更は `adjust-streak-field.yml` (workflow_dispatch) で行う: キャッシュ復元 → `scripts/set-streak-field.js` で1ユーザーの1フィールドを絶対値設定 → 新run_idキーで保存 → 次回スケジュール実行で反映。検証(フィールド種別・範囲・既存ユーザーのみ)はスクリプトに集約。現在値確認は読み取り専用の `show-streak-data.yml` / `scripts/show-streak-data.js`。フィールドごとに `.claude/skills/smilezemi-set-{grace,streak,bonus}` の3スキルへ分離し、各スキルは自分のfieldのみ渡して誤操作を防ぐ。

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

任意: `DISCORD_WEBHOOK_URL`（夜通知・朝通知ではLINE送信失敗時のフォールバック先。月次ボーナス清算だけはLINEの成否にかかわらず常に送りWebhook失効の疎通確認を兼ねる。未設定ならいずれもDiscordへ送らず従来どおりLINEのみ）

### LINE送信数の制約（重要）

送信先はLINEグループで、グループへのpushは**メッセージ数×グループ人数**でカウントされる（4人グループ=1通知4カウント）。無料プランの月間上限は200カウントで、朝夜とも毎日送ると構造的に超過する。対策として**夜通知は「当日のストリーク要件未達のユーザーが1人でもいる日」だけ送信**し（全員達成の日はスキップ。朝・月次は無条件送信）、週間レポート通知は廃止した。詳細: `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md`

- 通知を増やす変更をする際は必ず月間カウントを見積もること（固定分≈128=朝124+月次4、夜通知の残枠≈72=月18日分）
- 1つのLINEグループに公式アカウント(bot)は1つしか入れないため、チャンネル追加で枠を増やす手は使えない
- 上限超過時はLINE APIが429を返す。notifier.jsは429を非リトライで即失敗させ、レスポンスボディの理由をログに残す
- LINE送信が失敗した場合（429の枠切れ・401・ネットワーク障害すべて）は `src/broadcast.js` が Discord Webhook へ転送する。転送メッセージには失敗理由の行が付く。Discordには月間送信数の上限がない
- Discordは日次通知ではフォールバック専用で、LINEが成功している限り呼ばれない。Webhookの失効を検知するため、**月次ボーナス清算だけはLINEの成否にかかわらずDiscordにも送る**（`src/broadcast.js` の `broadcastToAll`）。年12回の疎通確認になり、Discord送信が失敗した月は終了コード1でワークフローが赤くなる。詳細: `docs/superpowers/specs/2026-07-27-monthly-discord-healthcheck-design.md`
- 通知の成否は「1つ以上の宛先に届いたか」で判定する。LINEだけ失敗してもワークフローは赤くしない

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

## DOM操作パターン

- DOMセレクタは `src/config/selectors.js` に集約管理
- 日付は JST 基準の `getTargetDates(dateOffset)` を使う（GitHub ActionsはUTCのため明示補正済み）。MM/DD形式はゼロパディング必須、`dateString`(YYYY-MM-DD)がストリーク等のキー
- 座標ベースフィルタリング: X座標 < 250 で左側UI要素識別。タイムラインの日付見出しは左側(x≈171)、スコア表示(「4/5」等)は右側(x≈1015)にあり、日付検索は必ずこのフィルタを通すこと
- タイムラインに掲載されているミッション = 実施済み(完了)。NEWラベルは未読バッジであり完了/未完了とは無関係
- 位置ベース範囲計算: boundingBox()でY座標範囲を計算しセクション分離
- クローラーのサブ取得は「データなし」を success:true + ゼロ値で返し、例外時のみ success:false。`getCourseData` は後者を `dataReliable: false` としてユーザーデータに伝搬する
- セレクタ変更時は実サイトで確認後に更新すること

## Development Rules

- Follow the user's instructions precisely, and within that scope act autonomously
- Think in English, generate responses in Japanese
- All Markdown content written to project files MUST be written in Japanese
