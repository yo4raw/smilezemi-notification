# smilezemi-notification

スマイルゼミ「みまもるネット」の自動クローリング & LINE通知システム。
GitHub Actionsで定期実行し、子供の学習状況をLINEに自動通知する。

## Architecture Overview

### System Flow

```text
GitHub Actions (cron) → Docker → chromedp (headless Chromium)
  → みまもるネット ログイン → データクローリング → 前回差分比較 → LINE Push通知
```

### Two Entry Points

1. **日次通知** (`cmd/crawler/main.go`): 毎日 JST 20:00 に実行。勉強時間・ミッション詳細・点数を取得しLINE通知
2. **週間レポート** (`cmd/weekly/main.go`): 毎週月曜 JST 17:00 に実行。週間学習ガイダンスレポートを取得しLINE通知

### Workflows

- `.github/workflows/crawler.yml` → `docker compose up` → `/app/crawler`
- `.github/workflows/weekly-report.yml` → `docker compose run --rm crawler /app/weekly`

## Project Structure

```text
cmd/
├── crawler/main.go            # メインエントリ（日次通知）
└── weekly/main.go             # 週間レポートエントリ

internal/
├── auth/auth.go               # 認証モジュール (Login, attemptLogin)
├── browser/browser.go         # chromedpブラウザ初期化 (NewContext)
├── config/
│   ├── config.go              # 環境変数管理 (LoadConfig, ValidateSecrets, MaskSensitiveString)
│   └── config_test.go
├── crawler/
│   ├── crawler.go             # クローリング (GetUserList, GetAllUsersDetailedData, GetMissionDetails等)
│   ├── weekly.go              # 週間レポートクローリング (GetAllUsersWeeklyReport, GetGuidanceReport)
│   └── selectors.go           # DOMセレクタ・定数定義
├── data/
│   ├── data.go                # データ永続化 (LoadPreviousData, CompareData, SaveData)
│   └── data_test.go
└── notifier/
    ├── notifier.go            # LINE通知 (LineClient.Send, FormatDetailedMessage, TruncateToLimit)
    ├── notifier_test.go
    ├── weekly.go              # 週間レポート通知フォーマット (FormatWeeklyReport)
    └── weekly_test.go

.github/workflows/
├── ci.yml                     # CI: テスト・ビルド
├── crawler.yml                # 日次クローリングワークフロー (cron: 毎日 UTC 11:00)
└── weekly-report.yml          # 週間レポートワークフロー (cron: 毎週月曜 UTC 08:00)
```

## Tech Stack

- **Language**: Go 1.25
- **Browser Automation**: chromedp (headless Chromium)
- **Notification**: LINE Messaging API (Push Message, REST直接呼出)
- **CI/CD**: GitHub Actions + Docker (multi-stage build)
- **Test**: Go標準テスト (`go test ./...`)
- **Dependencies**: chromedp (prod)

## Common Commands

```bash
go test ./...                 # テスト実行
go build ./cmd/crawler        # 日次通知バイナリビルド
go build ./cmd/weekly         # 週間レポートバイナリビルド
docker compose build          # Dockerイメージビルド
docker compose up             # Docker実行（日次通知）
docker compose run --rm crawler /app/weekly  # Docker実行（週間レポート）
```

## Environment Variables

`SMILEZEMI_USERNAME`, `SMILEZEMI_PASSWORD`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`
(GitHub Secretsまたは`.env`ファイルで管理)

## Key Design Decisions

- **chromedp over Playwright**: GoネイティブのChrome DevTools Protocol実装、外部バイナリ不要
- **LINE Messaging API**: LINE Notify API終了(2025/3/31)に伴う移行先。Push Message API使用
- **GitHub Actions + Docker**: インフラ管理不要、Secrets統合、無料枠で十分
- **毎回ログイン**: セッション永続化なし、ワークフロー終了時にクリーンアップ
- **グレースフルデグラデーション**: 詳細取得失敗時は基本モードにフォールバック
- **cmd/ パターン**: 複数エントリポイントを標準的なGoプロジェクト構造で管理
- **internal/browser**: chromedp初期化コードを共通化し、エントリポイント間の重複を排除

## DOM操作パターン

- DOMセレクタは `internal/crawler/selectors.go` に集約管理
- 日付フォーマット: MM/DD形式、ゼロパディング必須
- 座標ベースフィルタリング: X座標 < 250 で左側UI要素識別
- 位置ベース範囲計算: boundingBox()でY座標範囲を計算しセクション分離
- セレクタ変更時は実サイトで確認後に更新すること

## Development Rules

- Follow the user's instructions precisely, and within that scope act autonomously
- Think in English, generate responses in Japanese
- All Markdown content written to project files MUST be written in Japanese
