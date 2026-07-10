# 設計: 中学生コース 朝7時通知

日付: 2026-07-10
ステータス: 承認待ち

## 背景・目的

中学生は夜(20時以降)に学習することが多く、現在の JST 20:00 通知では当日の学習実績が
不完全な状態で通知されてしまう。中学生コースの通知を翌朝 JST 7:00 に移し、
**前日の確定した学習実績**を通知する。

## 要件(決定事項)

| 項目 | 決定内容 |
|------|----------|
| 朝通知の時刻 | JST 7:00(cron遅延対策として前倒し起動 + sleep 方式) |
| 朝通知の対象 | 中学生コースを持つ全ユーザー(中学生のみ・両コース持ちの両方) |
| 朝通知の内容 | 前日(JST)の勉強時間・講座詳細・点数。差分比較なし |
| 未学習の日 | **0件でも必ず通知**。「⚠️ 昨日は学習していません」を明示表示 |
| 20:00通知の変更 | 小学生コースのみ対象。中学生のみ・両コース持ちユーザーはスキップ |
| データ保存 | 朝実行は `mission_data.json` への保存・比較を行わない |
| 実装方式 | エントリポイント分離(案A)。既存 crawler/notifier をパラメータ化して再利用 |

## アーキテクチャ

```text
[既存] crawler.yml         cron UTC 06:17 → JST 20:00 待機 → node src/index.js
                           → 小学生コース・当日分 → 差分比較 → LINE通知 → 保存

[新規] morning-crawler.yml cron UTC 17:47 (JST 2:47) → JST 7:00 待機
                           → node src/morning-index.js
                           → 中学生コース・前日分 → LINE通知(比較・保存なし)
```

### 新規ワークフロー `.github/workflows/morning-crawler.yml`

- cron: `47 17 * * *`(UTC 17:47 = JST 2:47 起動。毎時0分は遅延最大化のため回避)
- 既存 crawler.yml と同じ「目標時刻まで sleep」ステップで JST 7:00 まで待機
  (既に過ぎていれば即実行)。timeout-minutes: 300
- 実行コマンド: `docker compose run --rm crawler node src/morning-index.js`
  (weekly-report.yml と同じ起動パターン)
- workflow_dispatch による手動実行対応
- スクリーンショットのアーティファクト保存(always)。ミッションデータの保存ステップは不要

### 新規エントリポイント `src/morning-index.js`

フロー:

1. 設定読込(`loadConfig`)
2. ブラウザ起動・ログイン(既存 `auth.js` を再利用)
3. `getAllUsersDetailedData(page, { courseFilter: 'juniorHigh', dateOffset: -1 })` で
   中学生コースの前日分を取得
4. `formatDetailedMessage` の朝バリエーションでメッセージ整形 → `truncateToLimit` → LINE Push 送信
5. ブラウザクリーンアップ(finally)

`loadPreviousData` / `compareData` / `saveData` は呼ばない。
基本モード(ミッション数のみ)へのフォールバックは小学生タイムライン前提のため
朝実行では行わず、クロール失敗時はエラー扱いとする。

## コンポーネント変更

### `src/crawler.js`

1. **`getAllUsersDetailedData(page, options = {})`** にオプションを追加
   - `courseFilter: 'elementary' | 'juniorHigh'`(省略時は現行動作 = 互換維持)
   - `dateOffset: 0 | -1`(省略時 0 = 当日)
   - コース選択画面での分岐:
     - `courseFilter: 'elementary'` → 小学生コースのみ選択。中学生コースしか持たない
       ユーザーはスキップ(ログに「中学生コースのみのためスキップ」と明示)。
       **両コース持ちユーザーもスキップ**(実学習は中学生コース側のため。現行の
       「両コース持ちは中学生コースのみ取得」仕様を踏襲した判断)
     - `courseFilter: 'juniorHigh'` → 中学生コースのみ選択。小学生コースしか持たない
       ユーザーはスキップ
   - コース選択画面が出ないユーザー(単一コース)は、現在いるタイムラインの種別
     (`/study/c/` = 中学生)で対象判定する
2. **日付計算の JST 明示化**
   - 新関数 `getTargetDates(dateOffset = 0)` を追加し、既存の `getTodayDate()` /
     `getTodayDates()` の利用箇所を置き換える
   - **重要**: GitHub Actions コンテナは UTC。朝 7:00 JST は UTC では前日 22:00 のため、
     ローカル時刻ベースの `new Date()` では日付がずれる。`Date.now() + 9時間` を
     UTC メソッドで読む等、JST を明示して計算する
   - 戻り値は既存互換の `{ withPadding, withoutPadding }`(MM/DD)+ `dateString`(YYYY-MM-DD)
3. **下位取得関数への日付伝搬**
   - `getStudyTime` / `getTodayMissionCount` / `getMissionDetails` および中学生版
     (`getStudyTimeForJuniorHigh` 等)に対象日付を引数で渡せるようにする
     (省略時は当日 = 互換維持)
   - 「対象日付がタイムラインに見つからない → 0時間・0件扱い」の既存処理はそのまま活かす
     (これが「0件でも必ず通知」の基盤になる)

### `src/notifier.js`

- `formatDetailedMessage(userData, missionChanges, options = {})` にオプション追加
  - `options.dateLabel`: ヘッダを「📊 スマイルゼミ 昨日(MM/DD)の学習状況」の形式に変更可能にする
  - 未学習(勉強時間 0:00 かつ講座 0 件)のユーザーには
    「⚠️ 昨日は学習していません」の一行を追加(朝モード時のみ)
- 通知イメージ(未学習日):

```text
📊 スマイルゼミ 昨日(07/09)の学習状況

👤 光志郎 (中学生コース)
⏱️ 勉強時間: 00:00
⚠️ 昨日は学習していません
```

### `src/index.js`(20:00)

- `getAllUsersDetailedData(page, { courseFilter: 'elementary' })` に変更するのみ
- 対象ユーザーが 0 件(全員中学生コース)の場合は通知を送らず正常終了
- 差分比較・保存フローは変更なし。`mission_data.json` には以後小学生コースのデータのみが
  保存される。移行直後の 1 回だけ保存済みの中学生エントリが currentData から消えるが、
  `compareData` は増分検出のため通知に悪影響はない

## エラーハンドリング

| 状況 | 挙動 |
|------|------|
| 朝実行でクロール失敗 | スクリーンショット保存 + exit 1(フォールバックなし) |
| 前日日付がタイムラインにない | エラーではなく 0 時間・0 件として通知 |
| LINE送信失敗 | エラーログ + exit 1(既存と同じ) |
| cron遅延で JST 7:00 超過起動 | 即実行(前日分取得のため内容は正しい) |
| 一部ユーザーの取得失敗 | partialFailure として続行、取得できた分を通知(既存と同じ) |

## テスト

- `tests/crawler.test.js`
  - `getTargetDates`: `dateOffset: 0 / -1`、UTC 環境で JST 日付が跨るケース
    (UTC 22:00 = JST 翌 7:00)の検証
  - `courseFilter` によるコース選択・スキップ判定
- `tests/notifier.test.js`
  - 朝ヘッダ(「昨日(MM/DD)の学習状況」)のフォーマット
  - 未学習ユーザーへの「⚠️ 昨日は学習していません」表示
  - 既存フォーマット(オプション省略時)が変わらないこと
- `tests/morning-index.test.js`
  - エントリポイントが比較・保存を呼ばないこと、エラー時の exitCode
- 手動検証: `workflow_dispatch` で morning-crawler.yml を実行し、実サイトでの前日データ
  取得と LINE 通知を確認

## スコープ外

- 週間レポート(`weekly-report-*`)の変更(未コミットの中学生スキップ対応は別作業)
- 通知先の追加や通知チャネルの変更
- `mission_data.json` の実行間永続化の改善(現状ワークフローに復元ステップがない件)
