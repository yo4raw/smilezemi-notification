# LINE通知の2チャンネル分離 + 429ハンドリング改善 設計

日付: 2026-07-26
ステータス: 承認済み

## 背景・問題

2026-07-26 朝通知の GitHub Actions run が LINE API `429 Too Many Requests` で失敗した。

調査で確定した事実:

- 送信先 `LINE_USER_ID` は家族4人グループ。LINE Messaging API はグループへの push を「メッセージ数 × グループ人数」でカウントするため、**1通知 = 4カウント**
- 通常日は朝+夜で 8カウント/日、週間レポートのある月曜は 12（insight API 実績と一致）
- 無料プラン（コミュニケーションプラン）の月間上限は 200。7/25 時点で 197 消費しており、7/26 朝の送信（4カウント必要）が拒否された
- 朝夜通知の月間消費は約248カウントで、無料枠200を構造的に超過する（今月限りの事故ではない）
- コードのバグではない。429 発生時もストリーク確定とキャッシュ保存は成功しており、データ喪失はない

## 対策方針（承認済み）

LINE公式アカウント（Messaging APIチャンネル）をもう1つ無料で作成し、通知系統ごとにチャンネルを分離する。各チャンネルに月200枠が付くため、合計400カウント/月で収まる。

### チャンネル割当

| 通知 | チャンネル | Secret | 月間消費(概算) |
|---|---|---|---|
| 朝通知 | 新: Smilebot2 (@274wjrcu) | `LINE_CHANNEL_ACCESS_TOKEN_MORNING` | 約124 |
| 夜通知・週間レポート・月次ボーナス・失敗通知 | 既存 | `LINE_CHANNEL_ACCESS_TOKEN` | 約144 |

- 朝通知（ストリーク確定の本命）を新チャンネルに割り当て、今月中に復旧させる
- 夜・週次は既存チャンネルのまま 7/31 まで 429 で失敗継続を許容（8/1 の枠リセットで自動復旧）
- 新チャンネルは既存と同一プロバイダー配下に作成済みのため、`LINE_USER_ID`（グループID）は共通のまま使える

## 変更内容

### 1. `.github/workflows/morning-crawler.yml`（唯一のワークフロー変更）

`secrets.LINE_CHANNEL_ACCESS_TOKEN` を参照している全箇所（.env生成・環境変数検証・失敗通知step）を `secrets.LINE_CHANNEL_ACCESS_TOKEN_MORNING` に変更する。

- コンテナ内の環境変数名は `LINE_CHANNEL_ACCESS_TOKEN` のまま（アプリコードはトークンの出所を知らない）
- `src/` 配下・他ワークフロー・docker-compose.yml は変更しない

### 2. `src/notifier.js` の429ハンドリング改善

再発時の調査性向上と無駄リトライの排除:

- **429 は即時失敗**: 月間上限超過はリトライで解決しないため、401 と同様にリトライせず失敗を返す
- **エラーレスポンスボディをログに含める**: LINE API はエラー時に `{"message": "You have reached your monthly limit."}` 等の原因を返すが、現状は status とstatusText しか記録しておらず原因特定が遅れた。非OK応答時にボディを読んでエラーメッセージに含める（トークンマスキングは既存の `maskTokenInError` を通す）

### 3. テスト（`tests/notifier.test.js`）

- 429 応答でリトライせず1回で失敗すること
- エラーメッセージにレスポンスボディの内容が含まれること
- 既存テストの回帰がないこと

### 4. ドキュメント（`CLAUDE.md`）

Environment Variables セクションに `LINE_CHANNEL_ACCESS_TOKEN_MORNING`（朝通知専用・2チャンネル分離の理由）を追記する。

## 運用手順（コード外）

1. ~~新チャンネル作成（同一プロバイダー）~~ 完了: Smilebot2 (@274wjrcu)、応答メッセージOFF・グループ参加許可ON
2. ~~トークン発行・GitHub Secrets `LINE_CHANNEL_ACCESS_TOKEN_MORNING` 登録~~ 完了 (2026-07-26)
3. **残作業**: 家族グループに Smilebot2 を招待（スマホのLINEアプリから）
4. 招待後、`morning-crawler.yml` を workflow_dispatch で手動実行し、送信成功を確認（7/25分の通知が届く。ストリーク確定は `lastConfirmedDate` により冪等でスキップされる）

## エラー処理・エッジケース

- Secret 未設定で朝ワークフローが走った場合: 環境変数検証 step が `_MORNING` を検証するため、空トークンのまま実行される前に失敗する
- bot がグループ未参加のまま送信した場合: LINE API がエラーを返し、改善後のログにレスポンスボディが出るため原因を特定できる
- 既存チャンネルの 7月末までの 429: 仕様通りの失敗。run は赤くなるがキャッシュ保存は `if: always()` でデータは保全される

## 検証

- `npm test`（429テスト含む）と `npm run lint` が通ること
- `DRY_RUN=true node -r dotenv/config src/morning-index.js` が従来どおり動作すること（送信なし）
- マージ後、workflow_dispatch で朝通知の実送信成功を確認すること
