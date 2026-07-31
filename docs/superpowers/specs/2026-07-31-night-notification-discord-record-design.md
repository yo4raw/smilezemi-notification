# 夜通知の全員達成日をDiscordに記録する 設計

日付: 2026-07-31
ステータス: 承認済み

## 背景・問題

2026-07-30 夜（JST 20:00）の通知が LINE にも Discord にも届かなかった。

調査で確定した事実:

- ワークフロー run 30528186992 は成功。クロールも成功し、小学生コース 6件（要件4件）・中学生コース 3件（木曜=平日要件3件）で両ユーザーとも当日のストリーク要件を達成していた
- `src/index.js` の条件送信により「全ユーザーが本日のストリーク要件を達成済み」として送信をスキップした。仕様どおりの動作であり、バグではない
- 一方で LINE の月間200カウントは 2026-07-25〜07-26 頃にすでに枯渇しており、以降すべての通知が `429 You have reached your monthly limit.` で失敗し Discord フォールバックに流れていた（7/26 朝通知以降、7/31 朝通知まで継続）
- `2026-07-26-line-quota-reduction-design.md` の夜通知スキップが実装・マージされたのは 7/27 で、枯渇した後だった

ここに設計上のねじれがある。夜通知のスキップは「LINEカウント節約」が目的だが、**LINEが枯渇して全通知がDiscordに流れている期間はスキップしても1カウントも節約にならず、記録が消えるだけ**になる。7/30 夜に Discord へ何も届かなかったのはこれが原因である。

なお LINE の月間枠は月初にリセットされるため、8/1 には LINE 送信自体は復活する見込み。本設計はその一時的な事象ではなく、上記の構造的なねじれを解消する。

## 対策方針

夜通知のスキップを「**LINE に送らない**」の意味に限定し、**Discord へは毎晩必ず送る**。Discord には月間送信数の上限がないため、LINE カウントの節約効果を保ったまま記録の欠落をなくせる。

### 送信ルール

| 当日の状況 | LINE | Discord |
|---|---|---|
| 未達ユーザーが1人以上 | 送る | LINE失敗時のみ転送（現状どおり） |
| 全員達成 | 送らない | 断り行付きで必ず送る（新規） |

全員達成の日に Discord へ送る本文は、通常の夜通知本文の先頭に断り行と空行を付けたもの:

```text
ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します(送信数節約)

📚 スマイルゼミ 学習状況 (07/30)
…（通常の夜通知本文）
```

断り行を付けるのは、Discord には LINE 失敗のフォールバック転送（先頭が `⚠️ LINEへの送信に失敗したためDiscordに転送しました`）も届くため、受信側が両者を区別できるようにするため。

### LINE 月間消費への影響

なし。全員達成の日の LINE 消費は現状と同じ 0 カウントで、`2026-07-26-line-quota-reduction-design.md` の見積もり（固定分≈128 = 朝124 + 月次4、夜通知の残枠≈72 = 月18日分）は据え置き。

### 対象外

朝通知（`src/morning-index.js`）と月次ボーナス清算（`src/monthly-bonus-index.js`）は変更しない。

## 変更内容

### 1. `src/broadcast.js` — 第3の宛先ポリシーを追加

`broadcastToDiscordOnly(message, config, options = {})` を追加する。`broadcastMessage`（LINE→失敗時Discord）・`broadcastToAll`（常に両方）と並ぶ第3の宛先ポリシーとして位置づける。

- `DISCORD_WEBHOOK_URL` 未設定 → `{ success: false, skipped: true, results: [] }` を返し、警告ログを出す。`sendDiscordMessage` は呼ばない
  - `success` の意味は既存2関数と同じく「1つ以上の宛先に届いたか」を保つ。「宛先がないから送らなかった」ことは `skipped` で表し、それを errors に積むかどうかは呼び出し側が決める
- 設定済み → Discord へ送信し `{ success, results }` を返す。`results` は discord 1件のみ。`skipped` は付けない
- 本文には理由行を付けず、渡された `message` をそのまま送る

あわせて private ヘルパを整理する。現在の `sendToDiscord(message, config, options, lineResult)` は「LINE の結果」を受け取って理由行の要否を判断しているが、`broadcastToDiscordOnly` には LINE の試行そのものが存在せず、偽の `{ success: true }` を渡すことになる。これを避けるため:

- `postToDiscord(body, config, options)` — 送信と例外の畳み込みだけを担い、理由行の判断を持たない
- 理由行の合成は呼び出し側3関数がそれぞれ行う
  - `broadcastMessage`: 必ず `formatFallbackMessage()` を通す（この関数に到達する時点で LINE は失敗している）
  - `broadcastToAll`: `lineResult.success` で分岐する
  - `broadcastToDiscordOnly`: 本文をそのまま渡す

既存2関数の外部契約（引数・戻り値・ログ）は変えない。

### 2. `src/index.js` — 全員達成の日を Discord 送信に置き換える

- 条件送信の早期 return（現行 `:264-293`）を削除する。`hasUnqualifiedUser` の算出（現行 `:247-256`）はそのまま残す
- 差分比較（`compareData` / `compareMissionDetails`）とメッセージ整形（`formatDetailedMessage`）は全員達成の日も通す。いずれも純粋関数で副作用はない。ただし早期 return の削除により `compareResult.success === false` の日は全員達成でも errors に積まれ終了コード1になる（従来は早期 return で0のまま終わっていた。未達者がいる日と同じ扱いになり一貫性は向上する）
- データ保存は通常経路の `saveData`（現行 `:352`）に合流する。削除する早期 return 内の保存処理と同一のため挙動は変わらない
- DRY_RUN も早期 return 内の専用分岐（現行 `:267-275`）を削除し、通常経路のプレビュー（現行 `:325-338`）に合流する。全員達成の日は断り行付きの本文を、宛先が Discord のみである旨のログとともに `DISCORD_MAX_MESSAGE_LENGTH`（2000）で切り詰めて表示する
- 送信箇所（現行 `:341`）を宛先の切り替えにする:

```js
const notifyResult = hasUnqualifiedUser
  ? await broadcastMessage(message, config)
  : await broadcastToDiscordOnly(`${DISCORD_ONLY_NOTICE}\n\n${message}`, config);
```

- 断り行の定数 `DISCORD_ONLY_NOTICE` は `src/index.js` に置く。「全員達成だから LINE を省いた」はストリーク要件を知っている `index.js` のドメイン知識であり、送信層は送らなかった理由を知らないほうがよい
- 結果判定を3分岐にする:

```js
if (notifyResult.success)      // ✅ 通知の送信が完了しました
else if (notifyResult.skipped) // ⚠️ DISCORD_WEBHOOK_URL 未設定のため記録を送信しませんでした（errorsに積まない）
else                           // errors.push(...) → 終了コード1
```

### 3. テスト

`tests/broadcast.test.js` に `broadcastToDiscordOnly()` の describe を追加する:

- 成功時に `success: true` を返し、`results` が discord 1件だけになる
- 本文に `⚠️ LINEへの送信に失敗したためDiscordに転送しました` の理由行が付かない
- Discord 送信が失敗したとき `success: false` を返し、`skipped` は付かない
- `DISCORD_WEBHOOK_URL` 未設定のとき `success: false, skipped: true` を返し、`sendDiscordMessage` が呼ばれない
- 2000文字を超える本文が `DISCORD_MAX_MESSAGE_LENGTH` で切り詰められる

既存の `broadcastMessage()` / `broadcastToAll()` のテストは、private ヘルパ整理後も無変更で通ること。

`tests/index.test.js`:

- broadcast モックに `broadcastToDiscordOnly` を追加する（`src/index.js` の require が増えるため、`MODULE_PATHS` とモック登録の追加が必須）
- 既存の「全員達成の日は夜通知を送信しない」を「全員達成の日は `broadcastToDiscordOnly` が1回呼ばれ、`broadcastMessage` は呼ばれない。データ保存も1回行われる」に書き換える
- 断り行が本文の先頭に付くことを検証する
- Discord 送信失敗時に `exitCode: 1` になることを検証する
- `DISCORD_WEBHOOK_URL` 未設定（`skipped: true`）時は `exitCode: 0` のままであることを検証する
- 「未達ユーザーが1人でもいる日は `broadcastMessage`」は現状維持
- 「ドライラン+全員達成の日は送信もデータ保存も行わない」は現状維持

### 4. ドキュメント

- `CLAUDE.md` の2箇所を更新する
  - エントリポイント説明の「（全員達成日はデータ保存のみ）」
  - 「LINE送信数の制約」節の「全員達成の日はスキップ」
- `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md` から本設計書への参照を張る

## エラー処理・エッジケース

- **Discord 送信失敗（Webhook 設定済み）**: 全員達成の日は宛先が Discord だけなので、失敗するとどこにも届かない。`errors` に積み終了コード1 とし、ワークフローを赤くして Webhook 失効に気づけるようにする
- **`DISCORD_WEBHOOK_URL` 未設定**: この設定は任意扱い。未設定環境で毎晩ワークフローが赤くなるのを避けるため、警告ログのみで正常終了する（現状の挙動と同じ）
- **本文長**: Discord の上限は 2000 文字で LINE の 5000 文字より短いため、全員達成の日の本文は宛先に合わせて 2000 文字で切り詰められる。現在の2ユーザー構成では余裕があるが、宛先ごとに文面長が変わる点は仕様とする
- **`dataReliable: false` のユーザー**: 完了数が0に見えるため未達扱いとなり `hasUnqualifiedUser` が真になる。従来どおり LINE 経路で送信される（安全側）
- **DRY_RUN**: 送信もデータ保存も行わない点は従来どおり。全員達成の日はプレビュー本文に断り行が含まれる

## 検証

- `npm test` が全件通ること
- `npm run lint` が通ること
- `DRY_RUN=true node -r dotenv/config src/index.js` を実行し、全員達成の日／未達者がいる日それぞれで宛先とプレビュー本文が期待どおりであること
- マージ後、最初の全員達成の夜に Discord へ断り行付きの記録が届くこと
