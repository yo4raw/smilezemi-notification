# 月次清算の Discord 常時送信（Webhook 失効検知）設計

作成日: 2026-07-27

## 背景と目的

`2026-07-27-discord-fallback-notification-design.md` で、LINE 送信が失敗したときだけ Discord Webhook へ転送するフォールバックを実装した。その設計書の「既知の制約」に次の問題を記載していた。

> Discord はフォールバック専用のため、LINE が成功している限り一度も叩かれない。その間に Webhook が削除・失効しても検知できず、いざ LINE の枠が尽きたときに両方が黙る可能性がある。

これは実害のある穴である。Webhook URL は Discord 側のチャンネル削除・サーバー設定変更・手動削除で失効しうるが、フォールバック専用である限り失効は「LINE が落ちた当日」まで表面化しない。そして LINE が落ちる日とは、まさに通知が最も必要な日である。

そこで **月次ボーナス清算のときだけ、LINE の成否にかかわらず Discord にも送る**。月次清算は年12回実行され、他の通知と違って条件送信ではなく無条件に走るため、定期的な疎通確認として適している。

**達成したい状態**: Webhook が失効したら、遅くとも翌月1日にはワークフローの失敗として気づける。

## スコープ

### やること

- `src/broadcast.js` に全宛先送信の関数を追加する
- `src/monthly-bonus-index.js` をその関数に切り替え、リセット条件と終了コードの判定を分ける

### やらないこと

- **夜通知・朝通知の送り方は変更しない**。引き続き LINE 失敗時のみ Discord へ転送する。日次の通知を常時2宛先に送ると Discord 側が毎日の通知で埋まり、清算メッセージが「疎通確認の合図」として機能しなくなる
- **専用のヘルスチェックメッセージは作らない**。清算メッセージ本体を送る。内容に意味があるほうが受信側も届かないことに気づきやすい
- **Webhook 失効時の自動復旧**。検知までが本設計の範囲

## 全体像

```text
月次清算 (src/monthly-bonus-index.js)
   ↓
broadcastToAll(message, config)          [src/broadcast.js に追加]
   ├─→ LINE へ送信（成否にかかわらず次へ進む）
   └─→ Discord へ送信
         ├─ LINE 成功時: 清算メッセージそのまま
         └─ LINE 失敗時: formatFallbackMessage() で理由行を先頭に付ける
   ↓
{success, results: [{channel, success, error}, ...]}
   ↓
エントリポイントが results を見て「リセットするか」「終了コード」を別々に決める
```

## モジュール設計

### `src/broadcast.js`（変更）

既存の `broadcastMessage()` は変更しない。新しい関数を追加する。

```js
broadcastToAll(message, config, options) → Promise<{
  success: boolean,
  results: Array<{channel: 'line'|'discord', success: boolean, error?: string}>
}>
```

- LINE に送り、**成否にかかわらず** Discord にも送る
- LINE が失敗していた場合のみ、Discord 側のメッセージに `formatFallbackMessage()` で理由行を付ける。LINE が成功していれば清算メッセージをそのまま送る
- `config.DISCORD_WEBHOOK_URL` が未設定なら Discord をスキップし、警告ログを出して LINE の結果だけを返す（任意項目の方針を維持）
- 戻り値の `success` は `broadcastMessage()` と同じ意味で **「1つ以上の宛先に届いたか」**。関数によって `success` の意味を変えない
- 切り詰めは既存と同じく宛先ごと（LINE=5000 / Discord=2000）

**オプションフラグではなく別関数にする理由**: `broadcastMessage(msg, config, {alsoDiscord: true})` の形にすると、呼び出し箇所を見ただけでは送信の挙動が判断できない。関数が分かれていれば、月次だけが違う送り方をしていることがコード上で明示される。

**実装上の共有**: LINE 失敗時の Discord 送信処理は両関数で同一のため、内部ヘルパー（例: `sendFallbackToDiscord(message, lineError, config, options)`）に切り出して共有する。ロジックの逐語的な重複を作らない。

### `src/monthly-bonus-index.js`（変更）

`broadcastMessage()` の呼び出しを `broadcastToAll()` に変える。あわせて、これまで `success` 一つで決めていた「リセットするか」と「終了コード」を分離する。

| LINE | Discord | ボーナスのリセット | 終了コード |
|---|---|---|---|
| 成功 | 成功 | する | 0 |
| 成功 | 失敗 | する | 1 |
| 失敗 | 成功 | する | 0 |
| 失敗 | 失敗 | しない | 1 |
| 成功 | 未設定 | する | 0 |
| 失敗 | 未設定 | しない | 1 |

判定ロジック:

1. **リセット条件** = `success`（1つ以上の宛先に届いた）。従来と同じ
2. **終了コード** = リセットできなかった場合、または **Discord への送信を試みて失敗した場合** に 1

**「Discord 失敗でも必ずリセットする」のが要点**。LINE に清算内容が届いている以上、リセットを見送ると翌月の実行で同じ月のボーナスが再度清算・再投稿され、お小遣いが二重支給される。Webhook 失効は「通知が二重に出る」より軽い問題なので、リセットを優先し、失効は終了コードで知らせる。

`DISCORD_WEBHOOK_URL` 未設定は失敗ではない（任意項目のため）。この場合は Discord の結果が `results` に現れないので、終了コードには影響しない。

## エラーハンドリング

- LINE と Discord の送信は互いに独立している。片方の失敗がもう片方の送信を妨げない
- 各宛先のリトライ・タイムアウト・トークンのマスキングは、既存の `sendPushMessage()` / `sendDiscordMessage()` がそれぞれ担う。`broadcastToAll` は順序と結果集約だけを担当する
- LINE 送信が例外を投げた場合も「LINE 失敗」として扱い Discord への送信に進む（`broadcastMessage` と同じ扱い）

## テスト

`tests/broadcast.test.js` に追加:

- LINE 成功時も Discord に送ること（`broadcastMessage` との挙動差がここ）
- LINE 成功時、Discord に渡るのは理由行のない清算メッセージそのままであること
- LINE 失敗時、Discord に渡るメッセージには理由行が付くこと
- LINE 成功 + Discord 失敗で `success: true`、`results` に discord=false が入ること
- 両方失敗で `success: false`
- `DISCORD_WEBHOOK_URL` 未設定なら Discord を呼ばず、`results` に discord のエントリが入らないこと
- LINE 送信が例外を投げても Discord に送ること
- Discord へは 2000 文字に切り詰めて渡すこと

`tests/monthly-bonus-index.test.js` に追加:

- LINE 成功 + Discord 失敗のとき、ボーナスはリセットされ、終了コードは 1 になること（二重支給防止と失効検知の両立）
- LINE 成功 + Discord 未設定のとき、リセットされ終了コードは 0 になること
- 両方失敗のときリセットされず終了コード 1 になること（既存挙動の維持）

## ドキュメント

`CLAUDE.md` の「LINE送信数の制約（重要）」節にある「Discordはフォールバック専用で、LINEが成功している限り一度も呼ばれない。そのため Webhook が失効しても気づけない」の記述を、月次清算のみ常時送信する現在の挙動に合わせて更新する。

## 既知の制約

- **検知の遅延は最大1か月**。月初に Webhook が失効した場合、気づくのは翌月1日の清算時になる。日次通知を常時2宛先に送れば遅延はなくなるが、Discord 側が毎日の通知で埋まり清算メッセージが疎通確認の合図として機能しなくなるため採らない
- **Discord チャンネルに清算メッセージが年12回残る**。フォールバック時の転送と混ざるが、転送には先頭に「⚠️ LINEへの送信に失敗したためDiscordに転送しました」が付くため区別できる
