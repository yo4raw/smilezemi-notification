# Discord フォールバック通知 設計

作成日: 2026-07-27

## 背景と目的

LINE 公式アカウントの無料枠は月間 200 カウント。送信先がグループのため、1 メッセージがグループ人数分（4 人グループなら 4 カウント）消費される。2026-07 の削減施策（週間レポート廃止・夜通知の条件送信化。`2026-07-26-line-quota-reduction-design.md`）で無料枠内に収めたが、余裕は小さく、子供が増える・通知を足すといった変化ですぐ枠に達する。

枠に達すると LINE API は 429 を返し、`notifier.js` はこれを非リトライで即失敗させる。つまり**その月の残りの通知はすべて届かなくなる**。日々の学習状況も、クロール失敗のエラー通知も、月次のボーナス清算も、すべて無音になる。これが解決したい問題である。

そこで **Discord Webhook を LINE のフォールバック先**として追加する。Discord Webhook には月間送信数の上限がなく（レート制限は Webhook あたり毎秒 5 回程度で、1 日 3 通の本システムには無関係）、追加ライブラリも不要で `fetch` だけで送れる。

**達成したい状態**: LINE への送信が失敗しても通知が消滅せず、Discord に届く。

## スコープ

### やること

- Discord Webhook への送信モジュール追加
- LINE 失敗時のみ Discord へ転送するフォールバック層の追加
- 3 つのエントリポイント（夜・朝・月次）の送信呼び出しを、通常通知・エラー通知ともフォールバック層経由に置き換え
- 月次ボーナスのリセット条件の見直し
- ワークフロー・Docker・環境変数まわりの設定追加

### やらないこと

- **LINE の送信数削減ロジックの変更**: 夜通知の「全員がストリーク要件を達成した日はスキップ」判定（`src/index.js`）はそのまま維持する。Discord はあくまで失敗時の受け皿であり、LINE の枠を使い切ってよい理由にはならない
- **Discord への常時送信**: Discord は LINE が成功した日には一度も叩かれない
- **Discord Webhook の定期疎通確認**: 「既知の制約」に記載

## 全体像

```text
crawler → formatDetailedMessage()   ← 宛先非依存の 1 本の文字列
                 ↓
        broadcastMessage(message, config)          [src/broadcast.js  新規]
                 ↓
        truncate(5000) → sendPushMessage()         [src/notifier.js   既存]
                 ↓
            成功 → 終了（Discord は呼ばない）
                 ↓
            失敗 → 理由の 1 行を先頭に付加
                 → truncate(2000) → sendDiscordMessage()   [src/discord.js 新規]
                 ↓
        { success, results: [{channel, success, error}] }
```

送信の順序は逐次である。LINE の結果が出るまで Discord は呼ばない。

## モジュール設計

### `src/discord.js`（新規）

Discord Webhook への送信のみを担う。`notifier.js` の LINE 送信と同じ作法をとる。

```js
sendDiscordMessage(message, webhookUrl, options) → {success: boolean, error?: string}
```

- オプション: `maxRetries = 3`（指数バックオフ）、`timeoutMs = 10000`（`AbortController`）
- リトライ方針: 5xx・ネットワークエラー・タイムアウトはリトライする。4xx は非リトライで即失敗する（Webhook 削除による 404、ペイロード不正による 400 はリトライしても解決しないため）
- リクエストボディは `{content: message}` のみ。embed は使わない
- `maskWebhookUrl(text, webhookUrl)` を持つ。Webhook URL は末尾のトークン部分が漏れると誰でもそのチャンネルに投稿できるため、エラーメッセージ・ログ出力では `https://discord.com/api/webhooks/<id>/***` に伏せる。エラー文字列を返す前に必ず通す

### `src/broadcast.js`（新規）

「1 本のメッセージを、どの宛先へどの順序で送るか」だけを担うファサード。エントリポイントはこのモジュールだけを呼ぶ。

```js
broadcastMessage(message, config, options) → {
  success: boolean,
  results: Array<{channel: 'line'|'discord', success: boolean, error?: string}>
}
```

処理:

1. `truncateToLimit(message, 5000)` して `sendPushMessage()` に渡す
2. 成功したらそこで終了し、`{success: true, results: [line結果]}` を返す
3. 失敗したら `config.DISCORD_WEBHOOK_URL` を見る
   - 未設定なら「未設定のため Discord へのフォールバックをスキップ」とログに出し、`{success: false}` を返す
   - 設定済みならフォールバック用ヘッダを先頭に付けたメッセージを `truncateToLimit(..., 2000)` して `sendDiscordMessage()` に渡す

フォールバック用ヘッダの形式:

```text
⚠️ LINEへの送信に失敗したためDiscordに転送しました
理由: <LINE送信のエラー文字列>

<本文>
```

理由文には `sendPushMessage()` が返すエラー文字列をそのまま使う。この文字列は `notifier.js` 側でトークンがマスキング済みであり、LINE API のレスポンスボディ（例: `You have reached your monthly limit.`）を含むため、枠切れなのか障害なのかを受信者が判別できる。

成否の定義:

| LINE | Discord | `success` | 備考 |
|---|---|---|---|
| 成功 | 呼ばない | `true` | 通常ケース |
| 失敗 | 成功 | `true` | ログに警告を出す。ワークフローは赤くしない |
| 失敗 | 失敗 | `false` | |
| 失敗 | 未設定 | `false` | 導入前と同じ挙動 |

「1 つ以上の宛先に届けば成功」とする理由は、LINE の月間枠が尽きている間ずっとワークフローが失敗し続け、毎日 GitHub からの失敗通知が届く状態を避けるため。失敗した宛先の理由はログに警告として残す。

### `src/notifier.js`（変更）

- `truncateToLimit(message, maxLength = 5000)` に第 2 引数を追加する。既定値は現行値なので既存の呼び出しはそのまま動く。Discord の上限は 2000 文字（LINE は 5000 文字）で、宛先ごとに異なる長さで切る必要があるため
- LINE 送信の責務は変更しない

### `src/config.js`（変更）

- `DISCORD_WEBHOOK_URL` を **任意** の設定として読み込み、`loadConfig()` の戻り値に含める。未設定なら `undefined`
- `REQUIRED_SECRETS` には追加しない。Webhook を用意する前にデプロイしても全通知が止まらないようにするため
- `SENSITIVE_FIELDS` に `webhook` を追加し、`maskSensitiveData()` のマスキング対象にする
- 起動時のデバッグログに 1 行追加する（値は出さず、存在・未設定のみ）

## エントリポイントの変更

`src/index.js` / `src/morning-index.js` / `src/monthly-bonus-index.js` の 3 つとも、`sendPushMessage(message, config.LINE_CHANNEL_ACCESS_TOKEN, config.LINE_USER_ID)` の呼び出しを `broadcastMessage(message, config)` に置き換える。

対象は通常の通知だけでなく、**クロール失敗時・データ読み込み失敗時のエラー通知**（`src/index.js` の基本モード失敗時、`src/morning-index.js` のクロール失敗時、`src/monthly-bonus-index.js` のストリークデータ読み込み失敗時）も含む。障害を無音にしないことが目的の通知であり、フォールバックの価値が最も高い。

あわせて、各エントリポイントにある `message = truncateToLimit(message)` の呼び出しを削除する。切り詰めは宛先ごとに `broadcast.js` が行う。

### 月次ボーナスのリセット条件（`src/monthly-bonus-index.js`）

現在は「LINE 送信が成功したらボーナスを 0 にリセットして保存、失敗したらリセットせず持ち越して次回再清算」となっている。

これを **`broadcastMessage()` の `success` が `true` ならリセット**に変更する。つまり Discord にだけ届いた場合もリセットする。

理由: Discord に清算内容が届いているのにリセットを見送ると、次回実行時に同じ月のボーナスが再度清算・再投稿され、お小遣いが二重に支給される。「両方成功したときだけリセット」は一見安全だが、この二重支給を招く。

## 設定・ワークフロー

- `.env.example`・`docker-compose.yml` の `environment` に `DISCORD_WEBHOOK_URL` を追加
- `.github/workflows/` の 3 本（`crawler.yml` / `morning-crawler.yml` / `monthly-bonus.yml`）の `.env` 生成ステップに `DISCORD_WEBHOOK_URL` の 1 行を追加する。**必須 Secrets の検証ステップには追加しない**（任意項目のため）
- 各ワークフロー末尾の「失敗を LINE に通知」ステップ（ワークフロー自体がコケたときの最後の砦）も、LINE への curl が失敗し、かつ `DISCORD_WEBHOOK_URL` が空でない場合に Discord へ curl する形にする。Webhook 未設定なら黙ってスキップし、この通知自体の失敗でジョブを落とさない現行方針は維持する
- GitHub Secrets への `DISCORD_WEBHOOK_URL` 登録は完了済み

## テスト

- `tests/discord.test.js`（新規）: 送信成功 / 4xx は即失敗しリトライしない / 5xx はリトライする / タイムアウト / 返却するエラー文字列に Webhook トークンが含まれない
- `tests/broadcast.test.js`（新規）: LINE 成功時に Discord が呼ばれない / LINE 失敗 + Discord 成功で `success: true` / 両方失敗で `success: false` / Discord 未設定時はスキップして `success: false` / LINE には 5000・Discord には 2000 で切り詰めたメッセージが渡る / 転送メッセージの先頭に理由行が付く
- `tests/index.test.js`: `MODULE_PATHS` に `../src/broadcast` を追加し、モックを登録する（`src/index.js` に require を追加した際の必須手順。CLAUDE.md 記載）
- `tests/monthly-bonus-index.test.js`: Discord にだけ届いた場合もボーナスがリセットされること、両方失敗時はリセットされないこと
- `tests/notifier.test.js`: `truncateToLimit()` が引数なしで従来通り 5000 で切ること、明示指定で任意長に切れること

## 検証

1. `npm test` と `npm run lint` が通ること
2. `DRY_RUN=true node -r dotenv/config src/morning-index.js` — 送信は行われないため、メッセージプレビューが従来どおり出力され、Discord 関連の処理でクラッシュしないことの確認にとどまる
3. Discord Webhook 単体の疎通確認 — 使い捨てスクリプトから `sendDiscordMessage()` を直接呼び、テスト文言が Discord に届くこと。LINE の枠は消費しない
4. フォールバック経路の確認 — 使い捨てスクリプトから、`LINE_CHANNEL_ACCESS_TOKEN` を無効な値に差し替えた config で `broadcastMessage()` を呼び、Discord に理由行付きのメッセージが届くこと。エントリポイントを `DRY_RUN` なしで実行する方法は取らない（ローカルの `data/streak_data.json` を書き換えてしまうため）
5. `morning-crawler.yml` を `workflow_dispatch` で手動実行し、本番経路で LINE に通常どおり届くこと（Discord は呼ばれない）

検証 3・4 で使ったスクリプトは確認後に削除する。

## 既知の制約

- **Discord Webhook の劣化に気づけない**: Discord はフォールバック専用のため、LINE が成功している限り一度も叩かれない。その間に Webhook が削除・失効しても検知できず、いざ LINE の枠が尽きたときに両方が黙る可能性がある。本設計では自動の定期疎通確認を入れない。必要になった時点で、月次ボーナス通知のときだけ Discord にも送るなどの方法を別途検討する
- **Discord は 2000 文字**: LINE の 5000 文字より短いため、子供の人数が増えると転送時に末尾が欠ける。フォールバック経路でのみ発生する劣化として許容する
- **Webhook URL の秘匿**: Webhook URL は実質的なパスワードであり、漏れると誰でもそのチャンネルに投稿できる。GitHub Secrets と `.env`（gitignore 済み）でのみ管理し、ログ・エラーメッセージには `maskWebhookUrl()` を通した形でのみ出す
