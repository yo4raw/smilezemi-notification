# Project Structure

## Organization Philosophy

GitHub Actionsワークフロー中心の単機能プロジェクト。スクリプトは単一責任原則に従い、認証・クローリング・通知を明確に分離。

## Directory Patterns

### `.github/workflows/`
**Purpose**: GitHub Actionsワークフロー定義
**Example**: `crawler.yml` - cron + workflow_dispatchトリガー、Playwright環境セットアップ

### `src/` または `/` (ルート)
**Purpose**: クローラースクリプト本体
**Pattern**: 機能別モジュール分割
**Example**:
```
src/
├── auth.js        # ログイン処理
├── crawler.js     # クローリングロジック
├── notifier.js    # LINE通知送信
└── index.js       # メインエントリーポイント
```

### `data/` (optional)
**Purpose**: 前回実行時のデータ保存（変更検出用）
**Note**: GitHub Actionsアーティファクトまたはリポジトリコミットで永続化

### `.kiro/`
**Purpose**: 仕様駆動開発の管理ディレクトリ
**Reference**: `.kiro/specs/` に機能仕様、`.kiro/steering/` にプロジェクトメモリ

## Naming Conventions

- **Files**: kebab-case (`auth.js`, `line-notifier.js`)
- **Functions**: camelCase (`loginToMimamoruNet`, `sendLineNotification`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`, `TIMEOUT_MS`)

## Import Organization

```javascript
// Node.js built-in modules
import fs from 'fs/promises';
import path from 'path';

// External dependencies
import { chromium } from 'playwright';
import axios from 'axios';

// Local modules
import { login } from './auth.js';
import { crawl } from './crawler.js';
```

**Module System**: ESM (`import/export`) 推奨、CommonJS (`require`) も許容

## Code Organization Principles

### Single Responsibility
- 各モジュールは1つの責務に集中
- `auth.js` → ログインのみ、`crawler.js` → データ抽出のみ

### Error Boundary
- 各モジュールで明示的なエラーハンドリング
- トップレベルで集約してLINE通知

### Configuration
- 環境変数から設定を取得（`process.env`）
- ハードコードされた設定を避ける

### Data Flow
```
GitHub Secrets → Auth → Crawler → Data Comparison → LINE Notification
                    ↓
              Error Handler → LINE Error Notification
```

---
_created: 2025-12-25_
