# スマイルゼミ ミッション数通知システム💖📱✨（今日も優勝）

みまもるネットから毎日ぜ〜んぶ自動で学習ミッション数を回収して、LINEに通知する仕組みだよん📩💞
放置で勝手に回るの、まじ神案件🙏✨（手動確認とかもう無理〜）

## できること（盛り盛り）🥳💫

- **自動ログイン**: みまもるネットに自動でログイン🔐✨（人間の手いらず）
- **ミッション数取得**: 全ユーザーの学習ミッション数を取得📊📝（ちゃんと集計）
- **変更検出**: 前回との差分を自動で検出👀⚡（変化だけ拾う）
- **LINE通知**: 変更があったらLINEにプッシュ通知📱🔔（即わかる）
- **データ保存**: 取ったデータをGitHub Artifactsに保存🗃️☁️（後から追える）
- **エラーハンドリング**: エラー時はスクショ残す📸😵‍💫（原因追跡ラク）

## セットアップ（ここ乗り越えたら勝ち）🛠️💗

### 必要な環境（ここガチで大事）✅

- Node.js 24.x 以上🟢（ここ満たしてね）
- GitHub リポジトリ🐙（Actions動かすなら必須）
- LINE Messaging API チャネル💬（通知のための入口）

### GitHub Secretsの設定🔑✨（漏れたら泣くやつ）

下のシークレットをGitHubリポジトリに設定してね🙏💦
「コピペして保存」までがセットだよ〜🫶

| シークレット名 | 説明 |
|--------------|------|
| `SMILEZEMI_USERNAME` | みまもるネットのユーザー名（メールアドレス）📧 |
| `SMILEZEMI_PASSWORD` | みまもるネットのパスワード🔒 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging APIのチャネルアクセストークン🎫 |
| `LINE_USER_ID` | LINE通知の送信先ユーザーID👤 |

### LINE Messaging APIの設定💚📲（通知の心臓）

1. [LINE Developers Console](https://developers.line.biz/console/) にアクセス🌐
2. 新しいプロバイダー + Messaging APIチャネルを作る🧩
3. チャネルアクセストークンを発行する🪪✨
4. ユーザーIDを確認（LINEアプリでボット友だち追加→メッセ送ると取れるよ）💬👀

## ローカル環境でのテスト（まずは手元で安定させる）🧪✨

### 1. 依存関係のインストール📦💨（準備運動）

```bash
npm ci
npm run install:browsers
```

### 2. 環境変数の設定🌿🔧（シークレット入れる）

`.env.example` をコピーして `.env` を作ってね✍️（テンプレ使うのが正義）

```bash
cp .env.example .env
```

`.env` にガチの認証情報入れるやつ〜🔐💦（ここだけはマジで間違えないで）

```env
SMILEZEMI_USERNAME=your_email@example.com
SMILEZEMI_PASSWORD=your_password
LINE_CHANNEL_ACCESS_TOKEN=your_line_token
LINE_USER_ID=your_line_user_id
```

### 3. Docker環境でのテスト🐳💙（環境差を消す）

```bash
# イメージをビルド
npm run docker:build

# コンテナを起動して実行
npm run docker:run
```

### 4. ローカル実行🏃‍♀️💨（本番前の最終チェック）

```bash
# テストを実行
npm test

# クローラーを実行
node src/index.js
```

## GitHub Actionsで自動実行しちゃう🤖⏰✨（完全放置プレイ）

### スケジュール🗓️（毎日ちゃんと回る）

- **自動実行**: 毎日 18:00 JST（UTC 9:00）🌙
- **手動実行**: GitHubのActionsタブから "Run workflow" で手動でも回せるよ🖱️✨

### タイムゾーンについて🌍🕒（ここ沼りがち）

GitHub ActionsのcronはUTCで設定されるから注意ね⚠️（JSTで考えるとズレるやつ）

- `0 9 * * *` = UTC 9:00 = JST 18:00

### アーティファクト📦☁️（証拠保全も完璧）

- **スクリーンショット**: エラー時のスクリーンショット（90日保存）📸🗓️
- **ミッションデータ**: 取得したミッションデータJSON（90日保存）🧾🗓️

## 検証とテスト（不安ゼロにしたい人向け）✅🧪

### 環境変数の検証🌿（まずココ）

```bash
# 環境変数が正しく設定されているか確認
npm run validate:env
```

### セキュリティ検証🛡️✨（守り固め）

```bash
# セキュリティチェックを実行
npm run validate:security

# またはすべての検証を実行
npm run validate:all
```

### Docker環境でのテスト🐳🧪（本番想定）

```bash
# Docker環境での自動テスト
npm run test:docker

# または手動でDocker実行
npm run docker:build
npm run docker:run
```

### 詳細なドキュメント📚✨（困ったらここ）

- [Notifier API リファレンス](docs/API_NOTIFIER.md): LINE通知モジュールのAPI仕様書📄
- [検証チェックリスト](docs/VALIDATION_CHECKLIST.md): 統合テストと本番環境検証の完全ガイド✅
- [Docker環境テスト手順書](docs/DOCKER_TESTING.md): Docker環境でのテスト詳細手順🐳

## プロジェクト構造（迷子防止マップ）🗂️👀

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
│   ├── API_NOTIFIER.md         # Notifier APIリファレンス
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

## 開発（ガチ勢しか勝たん）👩‍💻🔥

### テスト🧪（回して安心）

```bash
# 全テストを実行
npm test

# 特定のテストファイルを実行
npm test tests/crawler.test.js
```

### コード品質✨（ちゃんとしてる）

- **TDD**: 全モジュールはTest-Driven Developmentで開発💯
- **モジュラー設計**: 各モジュールは独立して動くよ🧩
- **エラーハンドリング**: 全てのエラーケースに対応😤🛠️
- **センシティブデータ保護**: パスワードとトークンは自動マスキング🔒✨

## 実装方針と開発ガイドライン（雑にやると詰むので注意）🧠⚠️

### セレクタの段階的特定（ここが勝敗）🎯

みまもるネットは認証必須のWebアプリで、実際にログインするまでDOM構造・セレクタが確定しないのがポイント⚠️
だから下の流れで“確認しながら”進めるのがいちばん安全だよ🫶

#### 1. ローカル環境でのブラウザ確認（マスト）🖥️👀

```bash
# セレクタ調査用デバッグスクリプトを実行
node scripts/investigate-selectors.js
```

このスクリプトは `headless: false` で実行されて、実ブラウザを開きながら目視でセレクタ調査できるよ👀✨

#### 2. ステップバイステップでの実装（焦り禁止）🧩🐢

各機能（ログイン/ページ遷移/データ取得/ユーザー切り替え等）を1ステップずつ確認しながら実装するよ✅
一気に全部盛るより、確実に動くの積み上げが最強💪✨

#### 3. セレクタの段階的特定（都度アップデート）🧷

各ステップでDOM構造を調査して、適切なセレクタ（CSS Selector / XPath / テキスト等）を特定→実装に反映するよ🧠
`scripts/investigate-selectors.js` でセレクタ候補を複数試すのがコツ✨

#### 4. スクリーンショット保存（証拠残す）📸

各ステップでスクショを `screenshots/` に保存して、DOMとセレクタの対応を記録するよ📸🗂️

#### 5. 実装時の注意事項（ここ守れば強い）⚠️✨

- ❌ 事前にセレクタを仮定してコードを書かない
- ✅ 必ず実際のサイトで確認してから実装する
- ✅ DOM要素が動的に生成される可能性を考慮し、適切な待機処理（`waitForSelector`等）を実装する
- ✅ セレクタが変更される可能性を考慮し、複数の代替セレクタや柔軟な要素検索ロジックを実装する
- ✅ エラー発生時にはスクリーンショットとDOM構造をログに記録し、問題の特定を容易にする

## トラブルシューティング（詰んだ時ここ）🆘✨

### ログインに失敗する（あるある）😵‍💫

1. GitHub Secretsの認証情報が正しいか確認🔑
2. みまもるネットの画面構造が変わってないか確認👀
3. スクリーンショット見てエラー原因を特定📸

### DOMセレクタが見つからない（だいたい画面変わった）🔎

画面構造が変わった可能性あるかも👀⚡ 下の手順でセレクタ更新してね：

#### セレクタ調査手順（これで勝つ）🧠🧷

1. **デバッグスクリプトを実行**（まず動かす）

   ```bash
   node scripts/investigate-selectors.js
   ```

2. **ブラウザでDOM構造を確認**（目視が正義）
   - スクリプトはブラウザを開いたまま10秒待機するので、その間にDevToolsで要素を確認
   - 保存されたスクリーンショット（`screenshots/debug-*.png`）も参照

3. **セレクタを更新**（ここ編集）
   - `src/config/selectors.js` のセレクタ定義を更新
   - 複数の代替セレクタを定義することを推奨

4. **ローカルでテスト**（動作確認）

   ```bash
   node src/index.js
   ```

5. **動作確認後、GitHubにプッシュ**（反映して完成）

### LINE通知が送信されない（通知ゼロは泣く）📵

1. LINE_CHANNEL_ACCESS_TOKENが有効か確認🎫
2. LINE_USER_IDが正しいか確認👤
3. ボットを友だち追加してるか確認➕

## セキュリティ（大事すぎ）🛡️🔐

- **認証情報の保護**: `.env` ファイルはGitignore済み
- **自動マスキング**: ログにパスワードやトークンは出力されません
- **HTTPS通信**: 全ての通信はHTTPS経由
- **最小権限**: 必要最小限の権限のみ使用

## ライセンス（いちおう）📄

このプロジェクトは個人利用目的だよ〜🙋‍♀️✨

## 作成者（つよつよ）👑

Claude Code (AI Assistant) with Kiro Spec-Driven Development

---

**注意**: このシステムはみまもるネットの利用規約に従って使用してください⚠️🙏
