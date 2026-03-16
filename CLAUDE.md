# smilezemi-notification

スマイルゼミ「みまもるネット」の自動クローリング & LINE通知システム。
GitHub Actionsで定期実行し、子供の学習状況をLINEに自動通知する。

## Architecture Overview

### System Flow

```text
GitHub Actions (cron) → Docker → Playwright (headless Chromium)
  → みまもるネット ログイン → データクローリング → 前回差分比較 → LINE Push通知
```

### Two Entry Points

1. **日次通知** (`src/index.js`): 毎日 JST 20:00 に実行。勉強時間・ミッション詳細・点数を取得しLINE通知
2. **週間レポート** (`src/weekly-report-index.js`): 毎週月曜 JST 17:00 に実行。週間学習ガイダンスレポートを取得しLINE通知

### Workflows

- `.github/workflows/crawler.yml` → `docker compose up` → `node src/index.js`
- `.github/workflows/weekly-report.yml` → `docker compose run --rm crawler node src/weekly-report-index.js`

## Project Structure

```text
src/
├── index.js                  # メインエントリ（日次通知）
├── weekly-report-index.js    # 週間レポートエントリ
├── config.js                 # 環境変数管理 (loadConfig, maskSensitiveData, validateSecrets)
├── config/
│   └── selectors.js          # DOMセレクタ定義（login, dashboard, missionDetails, weeklyReport等）
├── auth.js                   # 認証モジュール (login, attemptLogin)
├── crawler.js                # クローリング (getUserList, getAllUsersDetailedData, getMissionDetails, getStudyTime等)
├── data.js                   # データ永続化 (loadPreviousData, compareData, saveData, migrateDataV1toV2)
├── notifier.js               # LINE通知 (sendNotification, formatDetailedMessage, truncateToLimit)
├── weekly-report-crawler.js  # 週間レポートクローリング (getAllUsersWeeklyReport, getGuidanceReport)
└── weekly-report-notifier.js # 週間レポート通知フォーマット (formatWeeklyReport)

tests/                        # Node.js built-in test runner (node --test)
├── config.test.js
├── auth.test.js
├── crawler.test.js
├── data.test.js
├── notifier.test.js
└── index.test.js

scripts/                      # ユーティリティスクリプト
├── validate-env.js           # 環境変数検証 (npm run validate:env)
├── validate-security.sh      # セキュリティ検証 (npm run validate:security)
└── test-docker.sh            # Docker環境テスト (npm run test:docker)

.github/workflows/
├── crawler.yml               # 日次クローリングワークフロー (cron: 毎日 UTC 11:00)
└── weekly-report.yml         # 週間レポートワークフロー (cron: 毎週月曜 UTC 08:00)
```

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
npm test                  # テスト実行
npm start                 # 日次通知実行 (node src/index.js)
npm run validate:env      # 環境変数検証
npm run validate:all      # 全検証（env + security）
npm run docker:build      # Dockerイメージビルド
npm run docker:run        # Docker実行
npm run test:docker       # Docker環境テスト
```

## Environment Variables

`SMILEZEMI_USERNAME`, `SMILEZEMI_PASSWORD`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`
(GitHub Secretsまたは`.env`ファイルで管理)

## Key Design Decisions

- **Playwright over Puppeteer**: GitHub Actions環境との互換性、安定したセレクタAPI
- **LINE Messaging API**: LINE Notify API終了(2025/3/31)に伴う移行先。Push Message API使用
- **GitHub Actions + Docker**: インフラ管理不要、Secrets統合、無料枠で十分
- **毎回ログイン**: セッション永続化なし、ワークフロー終了時にクリーンアップ
- **グレースフルデグラデーション**: 詳細取得失敗時は基本モードにフォールバック

## DOM操作パターン

- DOMセレクタは `src/config/selectors.js` に集約管理
- 日付フォーマット: MM/DD形式、ゼロパディング必須
- 座標ベースフィルタリング: X座標 < 250 で左側UI要素識別
- 位置ベース範囲計算: boundingBox()でY座標範囲を計算しセクション分離
- セレクタ変更時は実サイトで確認後に更新すること

## Development Rules

- Follow the user's instructions precisely, and within that scope act autonomously
- Think in English, generate responses in Japanese
- All Markdown content written to project files MUST be written in Japanese
