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

### DOM Manipulation Patterns

- **日付フォーマット**: MM/DD形式、ゼロパディング必須（例: "01/05"）
- **座標ベースフィルタリング**: X座標 < 250 で左側UI要素（日付ラベル）を識別
- **位置ベース範囲計算**: boundingBox() で Y座標範囲を計算してセクション分離
- **進捗表示の除外**: 日付形式の進捗表示（例: "2/5"）を X座標で区別

### Debugging Techniques

- **スクリーンショット検証**: fullPage: true で画面全体を撮影して DOM構造を視覚的に確認
- **DOM階層トラバース**: 親要素を順次遡って構造を調査
- **座標デバッグ**: boundingBox() で要素の位置情報を可視化
- **デバッグスクリプト**: scripts/investigate-*.js パターンで段階的に問題を分析

### Implementation Examples

```javascript
// 日付フォーマット（ゼロパディング）
function getTodayDate() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${month}/${day}`;
}

// X座標フィルタリング（左側の日付ラベルのみ抽出）
const allDateElements = await page.locator('text=/\\d+\\/\\d+/').all();
for (const el of allDateElements) {
  const box = await el.boundingBox();
  if (box && box.x < 250) {
    allDates.push({ element: el, text: await el.textContent(), box });
  }
}

// Y座標範囲計算（今日のセクション判定）
const todayBox = await todayHeader.boundingBox();
const nextDateY = nextDateIndex < allDates.length
  ? allDates[nextDateIndex].box.y
  : Infinity;
// フィルタリング: todayBox.y < missionBox.y < nextDateY
```

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
