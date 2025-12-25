# Technology Stack

## Architecture

GitHub Actions ワークフローベースの自動化システム。ブラウザ自動化とAPI統合を組み合わせたクローラー構成。

## Core Technologies

- **Runtime**: Node.js (GitHub Actionsランナー環境)
- **Automation**: GitHub Actions (cron + workflow_dispatch)
- **Browser**: Playwright (ブラウザ自動化、スクリーンショット)
- **Language**: JavaScript/TypeScript（実装時に決定）
- **Platform**: Ubuntu latest (GitHub-hosted runner)

## Key Libraries

- **Playwright**: ブラウザ自動操作、DOM操作、セッション管理
- **LINE Messaging API**: Push Message APIで通知送信（専用ライブラリ不要、HTTP REST API）
- **GitHub Actions API**: Secrets取得、アーティファクト保存

## Development Standards

### Security
- GitHub Secretsで認証情報を管理（コードに埋め込まない）
- ログ出力時に認証情報を自動マスキング
- HTTPS通信のみを使用
- 依存パッケージの脆弱性スキャン

### Error Handling
- リトライ機能（最大3回）
- タイムアウト処理
- エラー発生時のスクリーンショット保存
- LINE通知によるエラー報告

### Code Quality
- 構造化されたエラーメッセージ（種類、タイムスタンプ、スタックトレース）
- ワークフロー実行時間制限（30分以内）
- データ検証とセレクタエラーハンドリング

## Development Environment

### Required Secrets (GitHub Secrets)
```
SMILEZEMI_USERNAME - みまもるネットのユーザー名
SMILEZEMI_PASSWORD - みまもるネットのパスワード
LINE_CHANNEL_ACCESS_TOKEN - LINE Messaging API Channel Access Token
LINE_USER_ID - LINE通知先ユーザーID（またはグループID）
```

### Common Commands
```bash
# Local testing (requires environment variables)
node crawler.js

# Playwright installation
npx playwright install

# Manual workflow trigger (via GitHub UI)
# Actions → Workflow → Run workflow
```

## Key Technical Decisions

### Playwright over Puppeteer
- GitHub Actions環境との互換性が高い
- 複数ブラウザサポート
- 安定したセレクタAPI

### LINE Messaging API
- LINE Notify API終了（2025年3月31日）に伴う公式推奨移行先
- Push Message APIでユーザー・グループへの通知送信
- Channel Access Tokenベースの認証
- Flex Messageなど高度なメッセージ機能対応
- 長期サポート保証

### GitHub Actions over AWS Lambda/Cron Jobs
- インフラ管理不要
- GitHub Secretsとの統合が自然
- 無料枠で十分な実行回数

### Session Management
- Cookieベースのセッション維持
- ワークフロー終了時にクリーンアップ
- 認証状態の永続化なし（毎回ログイン）

---
_created: 2025-12-25_
