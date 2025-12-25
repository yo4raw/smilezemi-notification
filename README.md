# スマイルゼミ ミッション数通知システム

みまもるネットから毎日自動で学習ミッション数を取得し、LINEに通知するシステムです。

## 機能

- **自動ログイン**: みまもるネットに自動でログイン
- **ミッション数取得**: 全ユーザーの学習ミッション数を取得
- **変更検出**: 前回との差分を自動で検出
- **LINE通知**: 変更があった場合、LINEにプッシュ通知
- **データ保存**: 取得したデータをGitHub Artifactsに保存
- **エラーハンドリング**: エラー時はスクリーンショットを保存

## セットアップ

### 必要な環境

- Node.js 24.x 以上
- GitHub リポジトリ
- LINE Messaging API チャネル

### GitHub Secretsの設定

以下のシークレットをGitHub リポジトリに設定してください：

| シークレット名 | 説明 |
|--------------|------|
| `SMILEZEMI_USERNAME` | みまもるネットのユーザー名（メールアドレス） |
| `SMILEZEMI_PASSWORD` | みまもるネットのパスワード |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging APIのチャネルアクセストークン |
| `LINE_USER_ID` | LINE通知の送信先ユーザーID |

### LINE Messaging APIの設定

1. [LINE Developers Console](https://developers.line.biz/console/) にアクセス
2. 新しいプロバイダーとMessaging APIチャネルを作成
3. チャネルアクセストークンを発行
4. ユーザーIDを確認（LINEアプリでボットを友だち追加後、メッセージを送信すると取得可能）

## ローカル環境でのテスト

### 1. 依存関係のインストール

```bash
npm ci
npm run install:browsers
```

### 2. 環境変数の設定

`.env.example` をコピーして `.env` を作成：

```bash
cp .env.example .env
```

`.env` ファイルに実際の認証情報を記入：

```env
SMILEZEMI_USERNAME=your_email@example.com
SMILEZEMI_PASSWORD=your_password
LINE_CHANNEL_ACCESS_TOKEN=your_line_token
LINE_USER_ID=your_line_user_id
```

### 3. Docker環境でのテスト

```bash
# イメージをビルド
npm run docker:build

# コンテナを起動して実行
npm run docker:run
```

### 4. ローカル実行

```bash
# テストを実行
npm test

# クローラーを実行
node src/index.js
```

## GitHub Actionsでの自動実行

### スケジュール

- **自動実行**: 毎日 18:00 JST（UTC 9:00）
- **手動実行**: GitHubのActionsタブから "Run workflow" で実行可能

### タイムゾーンについて

GitHub ActionsのcronはUTC時刻で設定されます。

- `0 9 * * *` = UTC 9:00 = JST 18:00

### アーティファクト

- **スクリーンショット**: エラー発生時のスクリーンショット（90日保存）
- **ミッションデータ**: 取得したミッションデータのJSON（90日保存）

## 検証とテスト

### 環境変数の検証

```bash
# 環境変数が正しく設定されているか確認
npm run validate:env
```

### セキュリティ検証

```bash
# セキュリティチェックを実行
npm run validate:security

# またはすべての検証を実行
npm run validate:all
```

### Docker環境でのテスト

```bash
# Docker環境での自動テスト
npm run test:docker

# または手動でDocker実行
npm run docker:build
npm run docker:run
```

### 詳細なドキュメント

- [検証チェックリスト](docs/VALIDATION_CHECKLIST.md): 統合テストと本番環境検証の完全ガイド
- [Docker環境テスト手順書](docs/DOCKER_TESTING.md): Docker環境でのテスト詳細手順

## プロジェクト構造

```
smilezemi-notification/
├── .github/
│   └── workflows/
│       └── crawler.yml         # GitHub Actionsワークフロー定義
├── src/
│   ├── config.js               # 環境変数管理
│   ├── config/
│   │   └── selectors.js        # DOMセレクタ定義
│   ├── auth.js                 # 認証モジュール
│   ├── crawler.js              # クローリングモジュール
│   ├── data.js                 # データ管理モジュール
│   ├── notifier.js             # 通知モジュール
│   └── index.js                # メインオーケストレーション
├── tests/
│   ├── config.test.js          # 環境変数テスト
│   ├── auth.test.js            # 認証テスト
│   ├── crawler.test.js         # クローリングテスト
│   ├── data.test.js            # データ管理テスト
│   ├── notifier.test.js        # 通知テスト
│   └── index.test.js           # オーケストレーションテスト
├── scripts/
│   ├── validate-env.js         # 環境変数検証スクリプト
│   ├── validate-security.sh    # セキュリティ検証スクリプト
│   └── test-docker.sh          # Docker環境テストスクリプト
├── docs/
│   ├── VALIDATION_CHECKLIST.md # 統合テスト・本番検証チェックリスト
│   └── DOCKER_TESTING.md       # Docker環境テスト詳細手順
├── data/                       # データ保存ディレクトリ
│   └── mission_data.json       # ミッションデータ（生成される）
├── screenshots/                # スクリーンショット保存ディレクトリ
├── .env.example                # 環境変数テンプレート
├── .gitignore                  # Gitignore設定
├── package.json                # Node.js設定
├── Dockerfile                  # Docker設定
├── docker-compose.yml          # Docker Compose設定
└── README.md                   # このファイル
```

## 開発

### テスト

```bash
# 全テストを実行
npm test

# 特定のテストファイルを実行
npm test tests/crawler.test.js
```

### コード品質

- **TDD**: 全モジュールはTest-Driven Developmentで開発
- **モジュラー設計**: 各モジュールは独立して動作可能
- **エラーハンドリング**: 全てのエラーケースに対応
- **センシティブデータ保護**: パスワードとトークンは自動マスキング

## トラブルシューティング

### ログインに失敗する

1. GitHub Secretsの認証情報が正しいか確認
2. みまもるネットの画面構造が変更されていないか確認
3. スクリーンショットを確認してエラー原因を特定

### DOMセレクタが見つからない

画面構造が変更された可能性があります。`src/config/selectors.js` のセレクタを更新してください。

### LINE通知が送信されない

1. LINE_CHANNEL_ACCESS_TOKENが有効か確認
2. LINE_USER_IDが正しいか確認
3. ボットを友だち追加しているか確認

## セキュリティ

- **認証情報の保護**: `.env` ファイルはGitignore済み
- **自動マスキング**: ログにパスワードやトークンは出力されません
- **HTTPS通信**: 全ての通信はHTTPS経由
- **最小権限**: 必要最小限の権限のみ使用

## ライセンス

このプロジェクトは個人利用目的です。

## 作成者

Claude Code (AI Assistant) with Kiro Spec-Driven Development

---

**注意**: このシステムはみまもるネットの利用規約に従って使用してください
