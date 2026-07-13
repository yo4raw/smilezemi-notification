# ミッション5個完了ルール(夜通知の警告 + ストリーク条件) 設計書

作成日: 2026-07-13
ステータス: ユーザー承認済み(適用範囲・未達時の扱い・判定基準の3点を質疑で確定)

## 要件

1. 夜通知(20時・小学生コース)で、完了ミッションが5個未満のユーザーには警告文を表示する
2. 完了ミッションが5個未満の日は連続学習ストリークにカウントしない

## 確定した仕様判断

| 論点 | 決定 |
|------|------|
| 適用範囲 | **小学生コースのみ**。中学生コース(朝通知)のストリークは現行基準(勉強時間またはミッションがあればOK)のまま |
| 完了5個未満の日の扱い | **未学習日と同じ**。おたすけを自動消費してストリーク維持(+1なし)、尽きたらリセット |
| 判定基準 | **完了ミッション数のみ**。勉強時間があっても完了5個未満ならカウントしない |

## 設計

### 1. ストリーク判定 (`src/streak.js`)

- `countCompletedMissions(user)` ヘルパーを追加しエクスポートする。`user.missionCount`(クローラーが数えた完了ミッション数)を使い、数値でない場合は `user.missions` の `completed: true` 件数にフォールバックする
- `isStudied(user, options = {})` に `minCompletedMissions`(デフォルト0)を追加する。1以上が指定された場合は「`countCompletedMissions(user) >= minCompletedMissions`」のみで判定し、勉強時間は見ない。未指定(0)なら現行判定のまま
- `updateStreaks(streakUsers, users, dateString, options = {})` が第4引数のオプションを `isStudied` に伝搬する
- `confirmDay` は無変更。「未学習日と同じ扱い」のため、studied=false として既存のおたすけ消費→リセットの流れに乗る
- `dataReliable: false` ガードは現行のまま有効。ミッション数の取得に失敗した日は未達に見えても確定判定をスキップし、誤リセットを防ぐ

### 2. 夜通知 (`src/index.js`)

定数 `REQUIRED_MISSIONS_FOR_STREAK = 5` を定義し、3箇所に適用する。

1. 前日分の確定判定: `updateStreaks(..., { minCompletedMissions: 5 })`
2. 当日の暫定+1表示: `todayStudied: isStudied(user, { minCompletedMissions: 5 })`(5個完了して初めて「N+1日目」表示になる)
3. 警告表示: `formatDetailedMessage(..., { streaks, missionWarningThreshold: 5 })`

朝通知(`src/morning-index.js`)・週間レポートは無変更。夜通知のクロールは `courseFilter: 'elementary'` のため、対象は小学生コースに限定される。

### 3. 警告文 (`src/notifier.js`)

`formatDetailedMessage` にオプション `missionWarningThreshold`(デフォルトnull=非表示)を追加する。ユーザーごとに、勉強時間行の直後に以下の条件で警告を1行表示する。

- 条件: `countCompletedMissions(user) < missionWarningThreshold` かつ `user.dataReliable !== false`(取得失敗による誤警告を防ぐ)
- 文言: `⚠️ ミッション完了 {n}/{閾値}個 — {閾値}個完了しないと連続学習にカウントされないよ!`

完了数のカウントは streak.js の `countCompletedMissions` を再利用する(判定と表示の基準を一致させるため)。

### 4. 挙動が変わる点(意図された仕様変更)

- 小学生コースで「勉強はしたが完了5個未満」の日は、これまで+1だったものがおたすけ消費(またはリセット)になる
- 導入日から即適用。過去の確定済みストリークは変更しない(データ移行なし)
- 夜通知の暫定表示も同基準になるため、5個未満の日は「N+1日目」ではなく確定値のまま表示される

### 5. テスト

- `tests/streak.test.js`: `countCompletedMissions`(missionCount優先・フォールバック)、`isStudied` の境界(4個=false / 5個=true / 勉強時間のみ=false / オプション未指定は現行挙動)、`updateStreaks` のオプション伝搬
- `tests/notifier.test.js`: 警告行の表示(4/5個)・非表示(5個以上、閾値未指定、dataReliable:false)
- `tests/index.test.js`: `updateStreaks` の第4引数と `formatDetailedMessage` のオプションに閾値5が渡ること

## 受け入れ基準

1. `npm test` 全件グリーン
2. `DRY_RUN=true` の夜通知ローカル実行で、完了5個未満のユーザーに警告文が表示され、暫定+1が付かないこと
3. 朝通知のプレビュー出力が変更前と同一であること(中学生コースへの影響なし)
