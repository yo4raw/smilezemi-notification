# スマイルゼミ 学習状況通知システム💖📱✨（今日も優勝）

みまもるネットから毎日ぜ〜んぶ自動で学習状況を回収して、LINEに詳細通知する仕組みだよん📩💞
勉強時間・ミッション詳細・点数まで全部取ってくるの、まじ神案件🙏✨（手動確認とかもう無理〜）
放置で勝手に回るし、学習進捗も可視化されるの最強💪✨

## できること（盛り盛り）🥳💫

- **自動ログイン**: みまもるネットに自動でログイン🔐✨（人間の手いらず）
- **詳細データ取得**: 全ユーザー・両コース(小学生・中学生)の学習状況を完全回収📊💯
  - ⏱️ **勉強時間**: その日の学習時間（"0:15"形式でスッキリ表示）
  - 📋 **ミッション詳細**: 講座名・点数(正答数タイプは 9/10 表記)・自主学習かどうかを全部取得
  - ✅ **学習件数**: ミッション+自主学習の件数と、しきい値未達なら「あと◯件!」の警告
- **連続学習ストリーク**: Duolingo風の連続学習日数を通知に表示🔥✨（`🔥 連続学習: 13日目  🛟 おたすけ: 1/3`）
  - 連続10日ごとに「おたすけ」+1ゲット🎁（最大3個までストック）
  - サボった日はおたすけが自動で身代わりになってストリーク死守🛟💦
  - おたすけ切れでサボったらリセット😢（また今日から頑張ろ）
  - 前日分を翌日に確定判定するから、20時以降の勉強もちゃんとカウントされるよ🌙✨
- **LINE通知**: 詳細情報をLINEにプッシュ通知📱🔔（一目で学習状況わかる）
  - 🌙 **夜通知（毎日20:00）**: 今日の学習状況の速報（全員が要件達成の日はLINEを節約してDiscordだけに記録）
  - ☀️ **朝通知（毎日7:00）**: 昨日の学習実績とストリークの確定（0件でも必ず届く）
  - 💰 **月次清算（毎月1日8:00）**: 先月のボーナスポイントをお小遣い額に換算して通知
- **データ保存**: ストリークデータを **Turso(libSQL)** のクラウドDBに保存🗄️✨（実行をまたいでちゃんと繋がる）
- **グレースフルデグラデーション**: 取得に失敗したユーザーは「⚠️ データを取得できませんでした」と出してストリークを誤リセットしない🛡️✨
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
| `DISCORD_WEBHOOK_URL` | 任意: LINEと併せて全通知を記録するDiscordのWebhook💬 |
| `TURSO_DATABASE_URL` | Turso(libSQL)データベースのURL🗄️（`libsql://xxx.turso.io`） |
| `TURSO_AUTH_TOKEN` | Tursoの認証トークン🔑 |

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
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxx/yyyyy
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token
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

# 朝通知をドライラン（LINE送信・ストリーク保存なしで安全に確認）🧪
DRY_RUN=true node --env-file=.env src/morning-index.js

# 夜通知をドライラン（LINE送信なしで安全に確認）🧪
DRY_RUN=true node --env-file=.env src/index.js
```

`.env` は自動で読み込まれないから `--env-file=.env` を忘れないでね⚠️（忘れると「環境変数が未設定」って怒られるやつ）

## GitHub Actionsで自動実行しちゃう🤖⏰✨（完全放置プレイ）

### スケジュール🗓️（毎日ちゃんと回る）

| ワークフロー | 通知時刻(JST) | 内容 |
|-------------|--------------|------|
| `crawler.yml` 🌙 | 毎日 20:00 | 両コースの今日の学習状況（速報） |
| `morning-crawler.yml` ☀️ | 毎日 7:00 | 両コースの昨日の学習実績とストリーク確定 |
| `monthly-bonus.yml` 💰 | 毎月1日 8:00 | 先月分のボーナスポイント清算 |

- 3本とも共通手順は `run-in-docker.yml` に1回だけ書いてあって、各ワークフローは cron とコマンドだけ持つ🧩
- **手動実行**: GitHubのActionsタブから "Run workflow" で手動でも回せるよ🖱️✨

### タイムゾーンと遅延対策🌍🕒（ここ沼りがち）

GitHub ActionsのcronはUTC設定な上に、実測1〜5.5時間も遅延するの😱
だから**前倒しで起動してワークフロー内で目標時刻までsleepする方式**を採用してるよ⏰✨

- 夜通知: `17 6 * * *`（UTC 6:17起動）→ JST 20:00まで待機
- 朝通知: `47 17 * * *`（UTC 17:47起動）→ JST 7:00まで待機

### データの引き継ぎ🔄☁️（ストリークの命綱）

ストリークデータ（`streak_data`）は **Turso(libSQL)** に保存してるよ🗄️✨

- `src/store.js` がTursoのHTTP API（`/v2/pipeline`）を直接叩いて1行読んで1行書くだけのシンプル構成🧵
- 書き込みは監査テーブル（`state_audit`）にもトリガーで履歴が残るから、いつ何を書いたか追える👀
- ワークフローのログ・アーティファクト・キャッシュに学習データを残さないから、実名が公開されない🔒✨
- テーブルが無い状態（移行前）は「初回実行」と区別されて、朝通知はストリークの確定処理をスキップするよ🛡️（0リセット防止）

### アーティファクト📦☁️（証拠保全は最小限）

- **スクリーンショット**: エラー時のスクリーンショット（3日保存）📸🗓️
  - 中身はみまもるネットの画面そのもの（実名・成績）だから、長く公開しないよう短期保存にしてる🔒
- 学習データのJSONはアーティファクトに出さないよ（実名の露出源になるし、Tursoに入ってるから重複）🚫🧾

## 検証とテスト（不安ゼロにしたい人向け）✅🧪

```bash
npm test          # 全テスト
npm run lint      # oxlint（警告もエラー扱い）
```

環境変数が足りなければ起動時の `loadConfig()` が名前付きで怒ってくれるよ🌿

### 詳細なドキュメント📚✨（困ったらここ）

- [DOM構造メモ](docs/DOM_STRUCTURE.md): みまもるネットのタイムラインのDOM構造🧷
- [GitHub Actions セットアップ](docs/GITHUB_ACTIONS_SETUP.md): Secrets 設定と動作確認🤖

## プロジェクト構造（迷子防止マップ）🗂️👀

```
smilezemi-notification/
├── .github/
│   └── workflows/
│       ├── run-in-docker.yml   # 共通手順（.env作成→build→JST待機→実行→失敗通知）
│       ├── crawler.yml         # 夜通知（両コース・20:00）
│       ├── morning-crawler.yml # 朝通知（両コース・7:00）
│       └── monthly-bonus.yml   # 月次ボーナス清算（毎月1日 8:00）
├── src/
│   ├── config.js               # 環境変数管理・マスキング
│   ├── config/
│   │   └── selectors.js        # DOMセレクタ定義
│   ├── auth.js                 # 認証モジュール
│   ├── crawler.js              # クローリングモジュール
│   ├── store.js                # Turso(libSQL)状態ストア🗄️
│   ├── streak.js               # ストリーク（連続学習日数）管理モジュール🔥
│   ├── notifier.js             # LINE通知・メッセージ整形
│   ├── discord.js              # Discord Webhook通知
│   ├── line-quota.js           # LINE残り送信可能数
│   ├── broadcast.js            # LINE+Discord の送信層
│   ├── retry.js                # 指数バックオフ付きリトライ
│   ├── index.js                # 夜通知エントリポイント
│   ├── morning-index.js        # 朝通知エントリポイント
│   └── monthly-bonus-index.js  # 月次ボーナス清算エントリポイント
├── tests/                      # node --test（src/ と scripts/ の各モジュールに対応）
├── scripts/
│   ├── show-streak-data.js     # ストリークデータの現在値を表示（読み取り専用）
│   ├── set-streak-field.js     # grace / streak / bonus を手動設定
│   └── set-exempt-dates.js     # 免除日（おやすみ）の登録・取り消し
├── docs/
│   ├── DOM_STRUCTURE.md        # みまもるネットのDOM構造メモ
│   └── GITHUB_ACTIONS_SETUP.md # GitHub Actions セットアップ
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

`headless: false` の Playwright で実ブラウザを開きながら目視でセレクタ調査するよ👀✨（調査結果は [docs/DOM_STRUCTURE.md](docs/DOM_STRUCTURE.md) にまとめてある）

#### 2. ステップバイステップでの実装（焦り禁止）🧩🐢

各機能（ログイン/ページ遷移/データ取得/ユーザー切り替え等）を1ステップずつ確認しながら実装するよ✅
一気に全部盛るより、確実に動くの積み上げが最強💪✨

#### 3. セレクタの段階的特定（都度アップデート）🧷

各ステップでDOM構造を調査して、適切なセレクタ（CSS Selector / XPath / テキスト等）を特定→実装に反映するよ🧠

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

1. **ブラウザでDOM構造を確認**（目視が正義）
   - `headless: false` の Playwright かブラウザの DevTools で要素を確認
   - 保存されたスクリーンショット（`screenshots/*.png`）も参照

2. **[docs/DOM_STRUCTURE.md](docs/DOM_STRUCTURE.md) を更新**（次の人のために）

3. **セレクタを更新**（ここ編集）
   - `src/config/selectors.js` のセレクタ定義を更新
   - 複数の代替セレクタを定義することを推奨

4. **ローカルでテスト**（動作確認）

   ```bash
   DRY_RUN=true node --env-file=.env src/index.js
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

Claude Code (AI Assistant)

---

**注意**: このシステムはみまもるネットの利用規約に従って使用してください⚠️🙏
