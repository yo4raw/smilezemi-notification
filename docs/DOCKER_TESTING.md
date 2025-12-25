# Docker環境テスト手順書

Docker環境でスマイルゼミクローラーをテストするための詳細な手順書です。

## 目次

- [事前準備](#事前準備)
- [クイックスタート](#クイックスタート)
- [詳細手順](#詳細手順)
- [トラブルシューティング](#トラブルシューティング)
- [高度な使用方法](#高度な使用方法)

---

## 事前準備

### 必要なソフトウェア

1. **Docker Desktop**
   - [Docker Desktop公式サイト](https://www.docker.com/products/docker-desktop)からダウンロード
   - macOS、Windows、Linuxに対応

2. **Git**
   - コードのクローンに使用
   - 通常はOSにプリインストール済み

### システム要件

- **メモリ**: 最低4GB、推奨8GB以上
- **ディスク空き容量**: 最低5GB
- **ネットワーク**: インターネット接続（みまもるネットとLINE APIへのアクセス）

---

## クイックスタート

最短手順でDocker環境をテストする方法:

```bash
# 1. リポジトリをクローン
git clone <repository-url>
cd smilezemi-notification

# 2. .envファイルを作成
cp .env.example .env
# .envファイルを編集して認証情報を記入

# 3. 自動テストスクリプトを実行
npm run test:docker
```

**これだけで以下が自動実行されます:**
- ✅ 環境変数の検証
- ✅ Dockerイメージのビルド
- ✅ コンテナでのテスト実行
- ✅ エンドツーエンドテスト（オプション）

---

## 詳細手順

### ステップ1: リポジトリのクローン

```bash
# リポジトリをクローン
git clone <repository-url>

# プロジェクトディレクトリに移動
cd smilezemi-notification

# ファイル構成を確認
ls -la
```

**期待される出力:**
```
drwxr-xr-x  .github/
drwxr-xr-x  src/
drwxr-xr-x  tests/
-rw-r--r--  .env.example
-rw-r--r--  Dockerfile
-rw-r--r--  docker-compose.yml
-rw-r--r--  package.json
-rw-r--r--  README.md
```

### ステップ2: 環境変数の設定

#### 2.1 .envファイルの作成

```bash
# .env.exampleをコピー
cp .env.example .env
```

#### 2.2 .envファイルの編集

エディタで`.env`ファイルを開き、実際の認証情報を記入:

```bash
# お好みのエディタで編集
vim .env
# または
nano .env
# または
code .env  # VS Code
```

**.envファイルの内容:**
```env
# みまもるネット認証情報
SMILEZEMI_USERNAME=your_email@example.com
SMILEZEMI_PASSWORD=your_password

# LINE Messaging API認証情報
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
LINE_USER_ID=your_line_user_id
```

**重要:**
- すべての値を実際の認証情報に置き換えてください
- `your_email@example.com`や`your_password`のままでは動作しません

#### 2.3 環境変数の検証

```bash
# Node.jsがインストールされている場合
npm run validate:env

# またはDockerコンテナ内で検証
docker-compose run --rm crawler node scripts/validate-env.js
```

**成功時の出力:**
```
✅ .envファイルが見つかりました
✅ SMILEZEMI_USERNAME: your_e...com
✅ SMILEZEMI_PASSWORD: *****
✅ LINE_CHANNEL_ACCESS_TOKEN: your_...ken
✅ LINE_USER_ID: Uxxxx...xxx

✅ すべての環境変数が正しく設定されています！
```

### ステップ3: Dockerイメージのビルド

```bash
# Dockerイメージをビルド
docker-compose build
```

**処理内容:**
1. Playwright公式イメージをベースに使用
2. Node.js 24.xをセットアップ
3. プロジェクトファイルをコピー
4. 依存パッケージをインストール
5. Playwrightブラウザをインストール

**ビルド完了の確認:**
```bash
# イメージの確認
docker images | grep smilezemi
```

**期待される出力:**
```
smilezemi-notification-crawler   latest   <image-id>   X minutes ago   1.5GB
```

**注意:**
- 初回ビルドには5-10分程度かかる場合があります
- ビルドには安定したインターネット接続が必要です

### ステップ4: コンテナでのテスト実行

#### 4.1 ユニットテストの実行

```bash
# コンテナ内でテストを実行
docker-compose run --rm crawler npm test
```

**期待される出力:**
```
✔ 設定モジュール (src/config.js) (11 tests)
✔ 認証モジュール (src/auth.js) (11 tests)
✔ クローラーモジュール (src/crawler.js) (16 tests)
✔ データ管理モジュール (src/data.js) (16 tests)
✔ 通知モジュール (src/notifier.js) (13 tests)

67+ tests passed
```

**チェックポイント:**
- ✅ すべてのテストがパス
- ✅ 失敗（failed）が0件
- ✅ エラーメッセージが表示されない

#### 4.2 個別モジュールのテスト

特定のモジュールのみテストする場合:

```bash
# 認証モジュールのみテスト
docker-compose run --rm crawler npm test tests/auth.test.js

# クローラーモジュールのみテスト
docker-compose run --rm crawler npm test tests/crawler.test.js

# 通知モジュールのみテスト
docker-compose run --rm crawler npm test tests/notifier.test.js
```

### ステップ5: エンドツーエンドテストの実行

**注意:** このステップでは実際のみまもるネットとLINE APIに接続します。

#### 5.1 事前確認

- [ ] .envファイルに正しい認証情報が設定されている
- [ ] LINEボットを友だち追加している
- [ ] みまもるネットにログイン可能である

#### 5.2 実行

```bash
# コンテナを起動してクローラーを実行
docker-compose up
```

**実行ログの例:**
```
app_1  | 🚀 スマイルゼミ クローラー開始
app_1  | ✅ 設定の読み込みが完了しました
app_1  | 🌐 ブラウザを起動しています...
app_1  | 🔐 ログインページにアクセスしています...
app_1  | ✅ ログインに成功しました
app_1  | 📊 ユーザー一覧を取得しています...
app_1  | ✅ 2人のユーザーが見つかりました
app_1  | 📈 ミッション数を取得しています...
app_1  | ✅ すべてのユーザーのミッション数を取得しました
app_1  | 📱 LINE通知を送信しています...
app_1  | ✅ LINE通知を送信しました
app_1  | 💾 データを保存しています...
app_1  | ✅ データを保存しました
app_1  | 🎉 クローラーが正常に完了しました！
```

#### 5.3 結果の確認

**1. 生成されたファイルの確認:**

```bash
# ミッションデータの確認
cat data/mission_data.json
```

**期待される内容:**
```json
{
  "version": "1.0",
  "timestamp": "2025-12-25T09:00:00.000Z",
  "users": [
    {
      "userName": "太郎",
      "missionCount": 5,
      "date": "2025-12-25"
    },
    {
      "userName": "花子",
      "missionCount": 3,
      "date": "2025-12-25"
    }
  ]
}
```

**2. LINE通知の確認:**

LINEアプリを開き、ボットからの通知を確認:

```
📊 スマイルゼミ ミッション数

🔔 2件の変更がありました

✨ 太郎
新規: 5ミッション

✨ 花子
新規: 3ミッション
```

**3. スクリーンショットの確認（エラー時のみ）:**

```bash
# スクリーンショットの確認
ls -la screenshots/
```

エラーが発生した場合のみスクリーンショットが保存されます。

### ステップ6: コンテナの停止とクリーンアップ

#### 6.1 コンテナの停止

```bash
# Ctrl+C でコンテナを停止（docker-compose upを実行中の場合）

# または別のターミナルから
docker-compose down
```

#### 6.2 完全なクリーンアップ

```bash
# コンテナ、ボリューム、ネットワークをすべて削除
docker-compose down --volumes --remove-orphans

# Dockerイメージも削除する場合
docker-compose down --rmi all --volumes --remove-orphans
```

**注意:**
- `--volumes`を指定すると、保存されたデータ（`data/`、`screenshots/`）も削除されます
- 削除前にバックアップが必要な場合は、先にファイルをコピーしてください

---

## トラブルシューティング

### よくある問題と解決方法

#### 問題1: Dockerイメージのビルドに失敗する

**エラー例:**
```
ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully
```

**原因と対処方法:**

1. **ネットワーク接続の問題**
   ```bash
   # ネットワークをリセット
   docker-compose down
   docker system prune -f
   # 再ビルド
   docker-compose build --no-cache
   ```

2. **Dockerディスク容量不足**
   ```bash
   # ディスク使用量を確認
   docker system df

   # 不要なイメージ・コンテナを削除
   docker system prune -a
   ```

3. **package.jsonの問題**
   ```bash
   # ローカルで依存関係を確認
   npm ci
   ```

#### 問題2: 環境変数が読み込まれない

**症状:**
```
❌ SMILEZEMI_USERNAME: 未設定
```

**対処方法:**

1. **.envファイルの存在確認**
   ```bash
   ls -la .env
   ```

2. **.envファイルの内容確認**
   ```bash
   cat .env
   ```

3. **.envファイルの文字コード確認**
   ```bash
   file .env
   # UTF-8であることを確認
   ```

4. **docker-compose.ymlの確認**
   ```yaml
   services:
     crawler:
       env_file:
         - .env  # この行があるか確認
   ```

#### 問題3: コンテナ内でテストが失敗する

**症状:**
```
✖ クローラーモジュール - getUserList() (failing)
```

**対処方法:**

1. **ローカル環境でのテスト**
   ```bash
   # ローカルでテストを実行して問題を特定
   npm test
   ```

2. **コンテナのログ確認**
   ```bash
   # 詳細なログを表示
   docker-compose run --rm crawler npm test -- --reporter=spec
   ```

3. **コンテナに入って手動確認**
   ```bash
   # コンテナのシェルに入る
   docker-compose run --rm crawler /bin/bash

   # コンテナ内で確認
   node --version  # Node.jsバージョン
   npm test       # テスト実行
   exit
   ```

#### 問題4: LINE通知が送信されない

**症状:**
```
❌ 通知送信エラー: 401 Unauthorized
```

**対処方法:**

1. **LINE_CHANNEL_ACCESS_TOKENの確認**
   ```bash
   # .envファイルの確認
   grep LINE_CHANNEL_ACCESS_TOKEN .env
   ```

2. **LINE_USER_IDの確認**
   ```bash
   # .envファイルの確認
   grep LINE_USER_ID .env
   ```

3. **ボットの友だち追加確認**
   - LINEアプリでボットを友だち追加していますか？
   - ボットがブロックされていませんか？

4. **トークンの有効性確認**
   ```bash
   # curlでLINE APIをテスト
   curl -X POST https://api.line.me/v2/bot/message/push \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "to": "YOUR_USER_ID",
       "messages": [{"type": "text", "text": "テスト"}]
     }'
   ```

#### 問題5: ログインに失敗する

**症状:**
```
❌ ログイン失敗: タイムアウト
```

**対処方法:**

1. **認証情報の確認**
   ```bash
   # .envファイルの認証情報を確認
   grep SMILEZEMI_ .env
   ```

2. **スクリーンショットで原因を特定**
   ```bash
   # エラー時のスクリーンショットを確認
   ls -la screenshots/
   ```

3. **みまもるネットの画面変更確認**
   - ブラウザで手動ログインを試行
   - セレクタが変更されていないか確認

4. **ヘッドレスモードをオフにしてデバッグ**
   ```javascript
   // Dockerfile内で一時的に変更
   // headless: true → headless: false
   ```

#### 問題6: Playwrightブラウザがインストールされない

**症状:**
```
ERROR: Browser is not installed
```

**対処方法:**

1. **Dockerイメージの再ビルド**
   ```bash
   docker-compose build --no-cache
   ```

2. **手動でブラウザをインストール**
   ```bash
   docker-compose run --rm crawler npx playwright install chromium --with-deps
   ```

3. **Playwrightバージョンの確認**
   ```bash
   # package.jsonのPlaywrightバージョン確認
   grep playwright package.json
   ```

---

## 高度な使用方法

### カスタム設定でのテスト

#### 1. ポート番号の変更

**docker-compose.yml:**
```yaml
services:
  crawler:
    ports:
      - "3001:3000"  # ホスト:コンテナ
```

#### 2. メモリ制限の設定

**docker-compose.yml:**
```yaml
services:
  crawler:
    mem_limit: 2g
    memswap_limit: 2g
```

#### 3. ログレベルの変更

**docker-compose.yml:**
```yaml
services:
  crawler:
    environment:
      - LOG_LEVEL=debug
```

### 複数環境でのテスト

#### 1. 開発環境用の設定

**docker-compose.dev.yml:**
```yaml
services:
  crawler:
    environment:
      - NODE_ENV=development
    command: npm run dev
```

**実行:**
```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

#### 2. 本番環境用の設定

**docker-compose.prod.yml:**
```yaml
services:
  crawler:
    environment:
      - NODE_ENV=production
    restart: always
```

**実行:**
```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### デバッグモード

#### インタラクティブモードでの実行

```bash
# コンテナのシェルに入る
docker-compose run --rm crawler /bin/bash

# コンテナ内で個別にコマンドを実行
root@container:/app# node src/index.js
root@container:/app# npm test
root@container:/app# exit
```

#### ログの詳細表示

```bash
# すべてのログを表示
docker-compose logs -f

# 特定のサービスのログのみ表示
docker-compose logs -f app

# 最新100行のみ表示
docker-compose logs --tail=100
```

### パフォーマンス測定

```bash
# 実行時間を測定
time docker-compose up

# リソース使用状況を監視
docker stats
```

---

## ベストプラクティス

### 1. 定期的なイメージの更新

```bash
# 最新のベースイメージを取得
docker-compose pull

# イメージを再ビルド
docker-compose build --no-cache
```

### 2. ログの保存

```bash
# ログをファイルに保存
docker-compose logs > docker-logs-$(date +%Y%m%d).txt
```

### 3. データのバックアップ

```bash
# データディレクトリをバックアップ
tar -czf backup-$(date +%Y%m%d).tar.gz data/ screenshots/
```

### 4. セキュリティ

```bash
# .envファイルの権限を制限
chmod 600 .env

# .envファイルがgitignoreに含まれているか確認
git status .env
# → 表示されない場合は正常
```

---

## まとめ

このドキュメントに従って、以下の項目が実行できるようになります:

- ✅ Docker環境のセットアップ
- ✅ コンテナ内でのテスト実行
- ✅ エンドツーエンドテスト
- ✅ トラブルシューティング
- ✅ 本番環境への展開準備

問題が発生した場合は、[トラブルシューティング](#トラブルシューティング)セクションを参照してください。
