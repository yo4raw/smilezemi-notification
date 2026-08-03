# 全通知のLINE・Discord同時送信 設計

作成日: 2026-08-03

## 背景

Discordは日次通知（夜・朝）ではフォールバック専用で、LINE送信が成功している限り一度も叩かれない。
そのため次の2点が問題になっていた。

- LINEに届いた通知がDiscordに残らず、記録がLINEのトーク履歴だけに散らばる
- Webhookの失効に気づけるのが「LINEが落ちた当日」か、月次ボーナス清算の疎通確認（年12回）だけ

全通知をLINEとDiscordの両方へ送ることで、Discordを常時の記録先にし、失効も翌日には検知できるようにする。

## 決定事項

### 送信ポリシー

LINE送信を行うすべての通知を、LINEの成否にかかわらずDiscordへも送る。
既存の `broadcastToAll()` の挙動そのものなので、日次通知の呼び出しをこれに差し替える。

**夜通知の全員達成日は変更しない。** この日は従来どおりLINEに送らずDiscordのみへ記録する
（`broadcastToDiscordOnly()`）。LINEグループへのpushは人数分カウントされ無料枠（月200）が
逼迫しているため、この節約は維持する。したがってLINEの月間カウントは現状と変わらない
（固定分≈128 = 朝124 + 月次4、夜通知は未達ユーザーがいる日のみ）。

### Discord送信失敗時の終了コード

Discordだけが失敗した場合（LINEは成功）、夜・朝・月次のいずれも終了コード1にする。
Webhook失効を翌日には検知するため。従来は月次のみが赤くなっていた。

`DISCORD_WEBHOOK_URL` が未設定の環境は「宛先がないから送らなかった」であり失敗ではないため、
終了コードは0のままとする（Discord連携を任意扱いにする既存方針を維持）。

## 実装

### 送信層 (`src/broadcast.js`)

- `broadcastMessage()`（LINE失敗時のみDiscordへ転送）を削除する。呼び出し元がなくなるため。
  送信層は `broadcastToAll()`（常に両方）と `broadcastToDiscordOnly()`（Discordのみ）の2本になり、
  宛先ポリシーが関数名から読み取れる。
- `getDiscordFailure(notifyResult)` を新設・エクスポートする。`results` からDiscordのエントリを探し、
  失敗していればエラー文字列を、成功またはエントリなし（未設定でスキップ）なら `null` を返す。
  `monthly-bonus-index.js` に直書きされていた同じ判定をここへ集約し、3エントリで共有する。
- `formatFallbackMessage()` の文言を実態に合わせる。常時両方へ送るようになると
  「Discordに転送しました」は不正確なため、「⚠️ LINEへの送信に失敗しました（この通知はDiscordにのみ届いています）」に
  変更する。理由行と、LINE成功時は理由行を付けない分岐はそのまま。

### エントリポイント

| 箇所 | 変更 |
|---|---|
| `src/index.js` 夜通知（通常日） | `broadcastMessage` → `broadcastToAll` |
| `src/index.js` 夜通知（全員達成日） | 変更なし（`broadcastToDiscordOnly`） |
| `src/index.js` 基本モード通知・エラー通知 | `broadcastToAll` |
| `src/morning-index.js` 朝通知・エラー通知 | `broadcastToAll` |
| `src/monthly-bonus-index.js` | 呼び出しは変更なし。Discord失敗判定を `getDiscordFailure` に置き換え |

送信後の判定は3エントリで統一する。

```js
const discordError = getDiscordFailure(notifyResult);
if (discordError) {
  console.error('❌ Discordへの送信に失敗しました。Webhookが失効している可能性があります:', discordError);
  errors.push(`Discordへの送信に失敗しました: ${discordError}`);
}
```

`errors` に積まれれば既存のロジックで `exitCode: 1` になる。
エラー通知のパスはもともと `exit 1` で返るため、追加の判定は入れない。

### DRY_RUN表示

- `src/index.js`: 「実行時はLINEに送信します(失敗時はDiscordへ転送)」→「実行時はLINEとDiscordの両方に送信します」。
  全員達成日の表示は据え置き。
- `src/morning-index.js`: 同じ1行を追加する（現状は宛先の説明がない）。

## トレードオフ

LINE成功時にDiscordを叩かなかったため、通常の夜・朝通知がDiscordの2000文字制限で切り詰められることは
これまでなかった。今後は毎日Discordにも送るため、本文が2000文字を超える日はDiscord側だけ末尾が切れる
（LINEは5000文字なので影響なし）。全員達成日の記録では既に起きている挙動であり、新規の欠陥ではない。
文字数削減は今回のスコープ外とし、切り詰めは現行のままとする。

Discordの送信数は月約63件（朝31 + 夜31 + 月次1）に増えるが、Webhookに月間上限はない。

## テスト

- `tests/broadcast.test.js`: `broadcastMessage` のテスト群を削除。`getDiscordFailure` のテスト
  （Discord失敗あり／成功／エントリなし）を追加。
- `tests/index.test.js` / `tests/morning-index.test.js`: モックを `broadcastToAll` に差し替え。
  「LINE成功・Discord失敗 → `exitCode: 1`」「Discord未設定 → `exitCode: 0`」を追加。
  夜通知の全員達成日が引き続き `broadcastToDiscordOnly` を使うことの確認は現行テストを維持。
- `tests/monthly-bonus-index.test.js`: `getDiscordFailure` 経由に変えても既存の判定が壊れないことを確認。

## ドキュメント

`CLAUDE.md` の「Discordは日次通知では原則フォールバック専用」という記述を、
「全通知をLINEとDiscordの両方へ送る（夜通知の全員達成日のみDiscord単独）」に書き換える。
