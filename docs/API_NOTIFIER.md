# Notifier API ドキュメント

LINE Messaging APIを使用した通知機能を提供するモジュールのAPIリファレンスです。

## 目次

- [概要](#概要)
- [公開API](#公開api)
  - [sendNotification](#sendnotification)
  - [sendUserListNotification](#senduserlistnotification)
  - [formatMessage](#formatmessage)
- [エラーハンドリング](#エラーハンドリング)
- [使用例](#使用例)
- [セキュリティ](#セキュリティ)

## 概要

`src/notifier.js`モジュールは、スマイルゼミのミッション数変更をLINEに通知する機能を提供します。

### 主な機能

- ミッション数の変更通知
- ユーザー一覧の通知
- 自動リトライ機能
- センシティブデータのマスキング
- メッセージ長制限の自動処理

### インポート

```javascript
const { sendNotification, sendUserListNotification, formatMessage } = require('./notifier');
```

## 公開API

### sendNotification

ミッション数の変更をLINEに通知します。

#### シグネチャ

```javascript
async function sendNotification(changes, accessToken, userId, options = {})
```

#### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `changes` | `Array<Change>` | ✓ | ミッション数の変更情報の配列 |
| `accessToken` | `string` | ✓ | LINE Channel Access Token |
| `userId` | `string` | ✓ | 通知送信先のLINE User ID |
| `options` | `object` | - | オプション設定 |
| `options.maxRetries` | `number` | - | 最大リトライ回数（デフォルト: 3） |
| `options.retryDelay` | `number` | - | リトライ間隔（ms、デフォルト: 1000、指数バックオフ） |

#### Change オブジェクト

```javascript
{
  userName: string,      // ユーザー名
  previousCount: number, // 前回のミッション数
  currentCount: number,  // 現在のミッション数
  diff: number,         // 差分
  type: 'increase' | 'decrease' | 'new' // 変更タイプ
}
```

#### 戻り値

```javascript
Promise<{
  success: boolean,  // 通知送信の成功/失敗
  error?: string    // エラーメッセージ（失敗時）
}>
```

#### 使用例

```javascript
const changes = [
  {
    userName: '太郎',
    previousCount: 5,
    currentCount: 8,
    diff: 3,
    type: 'increase'
  }
];

const result = await sendNotification(
  changes,
  process.env.LINE_CHANNEL_ACCESS_TOKEN,
  process.env.LINE_USER_ID
);

if (result.success) {
  console.log('通知送信成功');
} else {
  console.error('通知送信失敗:', result.error);
}
```

#### エラーケース

| ケース | 動作 | リトライ |
|--------|------|---------|
| 認証エラー (401) | 即座にエラーを返す | なし |
| サーバーエラー (500) | 指数バックオフでリトライ | あり (最大3回) |
| ネットワークエラー | 指数バックオフでリトライ | あり (最大3回) |
| パラメータ不足 | 即座にエラーを返す | なし |

#### 注意事項

- メッセージは自動的に5000文字以内に制限されます
- リトライ間隔は指数バックオフで増加します（1秒 → 2秒 → 4秒）
- 認証エラーはリトライされません
- エラーメッセージ内のトークンは自動的にマスキングされます

---

### sendUserListNotification

登録ユーザーの一覧情報をLINEに通知します。

#### シグネチャ

```javascript
async function sendUserListNotification(users, accessToken, userId, options = {})
```

#### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `users` | `Array<User>` | ✓ | ユーザー情報の配列 |
| `accessToken` | `string` | ✓ | LINE Channel Access Token |
| `userId` | `string` | ✓ | 通知送信先のLINE User ID |
| `options` | `object` | - | オプション設定（sendNotificationと同じ） |

#### User オブジェクト

```javascript
{
  name: string,   // ユーザー名
  index: number   // ユーザーインデックス
}
```

#### 戻り値

```javascript
Promise<{
  success: boolean,  // 通知送信の成功/失敗
  error?: string    // エラーメッセージ（失敗時）
}>
```

#### 使用例

```javascript
const users = [
  { name: '太郎', index: 0 },
  { name: '花子', index: 1 }
];

const result = await sendUserListNotification(
  users,
  process.env.LINE_CHANNEL_ACCESS_TOKEN,
  process.env.LINE_USER_ID
);

if (result.success) {
  console.log('ユーザー一覧通知送信成功');
}
```

#### 通知内容

通知メッセージには以下の情報が含まれます：

```
👥 スマイルゼミ ユーザー一覧

登録ユーザー数: 2名
```

**注意**: プライバシー保護のため、個別のユーザー名は含まれません（ユーザー数のみ表示）。

---

### formatMessage

変更情報を読みやすいLINEメッセージにフォーマットします。

#### シグネチャ

```javascript
function formatMessage(changes)
```

#### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `changes` | `Array<Change>` | ✓ | ミッション数の変更情報の配列 |

#### 戻り値

```javascript
string  // フォーマットされたメッセージ文字列（最大5000文字）
```

#### 使用例

```javascript
const changes = [
  {
    userName: '太郎',
    previousCount: 5,
    currentCount: 8,
    diff: 3,
    type: 'increase'
  }
];

const message = formatMessage(changes);
console.log(message);
// 出力:
// 📊 スマイルゼミ ミッション数レポート
//
// 太郎: 5 → 8 (+3) ↑
```

#### メッセージ形式

- **変更あり**: ユーザー名と変更内容を含む詳細メッセージ
- **変更なし**: 「変更なし」を示すシンプルなメッセージ
- **増加**: `↑` または `+` で表示
- **減少**: `↓` または `-` で表示
- **新規**: `NEW` または `新規` で表示

---

## エラーハンドリング

### リトライロジック

通知送信が失敗した場合、以下のロジックでリトライを実行します：

```javascript
// 指数バックオフでリトライ
リトライ1: 1秒待機 → 送信試行
リトライ2: 2秒待機 → 送信試行
リトライ3: 4秒待機 → 送信試行
→ 失敗時はエラーを返す
```

### リトライされないエラー

以下のエラーは即座に失敗として扱われ、リトライされません：

- **401 Unauthorized**: 認証トークンが無効
- **パラメータ不足**: 必須パラメータが欠けている

### エラーメッセージ例

```javascript
// 認証エラー
{
  success: false,
  error: '認証エラー: LINE APIへのアクセスが拒否されました (401)'
}

// パラメータエラー
{
  success: false,
  error: '必須パラメータが欠けています: accessToken と userId が必要です'
}

// ネットワークエラー（3回リトライ後）
{
  success: false,
  error: 'ネットワークエラー: 通知送信に失敗しました（3回試行）'
}
```

---

## 使用例

### 基本的な使用例

```javascript
const { sendNotification } = require('./notifier');
const { loadConfig } = require('./config');

async function notifyChanges(changes) {
  const config = loadConfig();

  const result = await sendNotification(
    changes,
    config.LINE_CHANNEL_ACCESS_TOKEN,
    config.LINE_USER_ID
  );

  if (!result.success) {
    console.error('通知送信失敗:', result.error);
    // エラーハンドリング処理
  }

  return result;
}
```

### カスタムリトライ設定

```javascript
const result = await sendNotification(
  changes,
  accessToken,
  userId,
  {
    maxRetries: 5,      // 最大5回リトライ
    retryDelay: 2000    // 初回リトライ間隔を2秒に設定
  }
);
```

### エラーハンドリングの完全な例

```javascript
async function sendNotificationWithErrorHandling(changes) {
  const config = loadConfig();

  const result = await sendNotification(
    changes,
    config.LINE_CHANNEL_ACCESS_TOKEN,
    config.LINE_USER_ID
  );

  if (!result.success) {
    // エラータイプに応じた処理
    if (result.error.includes('401')) {
      console.error('認証トークンを確認してください');
      // トークンの再発行を促す処理
    } else if (result.error.includes('ネットワーク')) {
      console.error('ネットワーク接続を確認してください');
      // 再試行のスケジュール
    } else {
      console.error('予期しないエラー:', result.error);
      // エラーログの保存
    }

    return false;
  }

  console.log('通知送信成功');
  return true;
}
```

---

## セキュリティ

### センシティブデータのマスキング

エラーメッセージ内の認証情報は自動的にマスキングされます：

```javascript
// エラーメッセージ例
// 実際のトークン: "secret_token_12345"
// マスキング後: "***"
```

マスキング対象：
- LINE Channel Access Token
- その他の認証トークン
- パスワード情報

### ベストプラクティス

1. **環境変数の使用**: トークンやユーザーIDは環境変数で管理
2. **ログへの出力制限**: センシティブな情報はログに出力しない
3. **HTTPS通信**: LINE APIは常にHTTPS経由で通信
4. **最小権限**: 必要最小限の権限を持つトークンを使用

```javascript
// 推奨: 環境変数から読み込み
const config = loadConfig();
const result = await sendNotification(
  changes,
  config.LINE_CHANNEL_ACCESS_TOKEN,  // 環境変数から
  config.LINE_USER_ID                // 環境変数から
);

// 非推奨: ハードコード
const result = await sendNotification(
  changes,
  'hardcoded_token',  // ❌ セキュリティリスク
  'hardcoded_user_id' // ❌ セキュリティリスク
);
```

---

## 変更履歴

### v1.1.0 (2025-12-25)

- **変更**: `formatUserListMessage`を内部関数に変更
  - プライバシー保護のため、ユーザー名のリスト送信を削除
  - ユーザー数のみを表示するように変更
  - モジュールエクスポートから削除（内部使用のみ）

### v1.0.0

- 初回リリース
- 基本的な通知機能の実装

---

## 関連ドキュメント

- [README.md](../README.md) - プロジェクト全体の概要
- [VALIDATION_CHECKLIST.md](VALIDATION_CHECKLIST.md) - テストと検証手順
- [LINE Messaging API リファレンス](https://developers.line.biz/ja/reference/messaging-api/) - LINE公式ドキュメント

---

## サポート

問題が発生した場合は、以下を確認してください：

1. 環境変数が正しく設定されているか
2. LINE Channel Access Tokenが有効か
3. ボットが友だち追加されているか
4. エラーメッセージの内容を確認

詳細なトラブルシューティングは[README.md](../README.md)を参照してください。
