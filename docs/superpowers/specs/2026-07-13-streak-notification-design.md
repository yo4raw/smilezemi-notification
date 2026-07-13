# 連続学習日数(ストリーク)通知機能 設計書

作成日: 2026-07-13

## 背景と目的

Duolingoの連続学習日数(ストリーク)のように、子供の学習継続を可視化してモチベーションを高めたい。日次のLINE通知に「連続学習日数」と「おたすけ(猶予)」の状態を表示する。

現状の課題: GitHub Actions 上では前回データが引き継がれていない(`mission_data.json` は artifact にアップロードするのみで、次回実行時に復元していない)。ストリークは日をまたいだ状態保持が必須のため、永続化機構を新設する。

## 仕様

### 学習判定

- 「勉強時間が0 かつ ミッション0件」の日を**未学習**とする(`src/notifier.js` の既存判定式 `hours === 0 && minutes === 0 && missions.length === 0` を再利用)
- 日付は JST 基準(`getTargetDates()` の `dateString` = `YYYY-MM-DD`)

### ストリークの確定タイミング

- **前日分を翌日に確定判定**する。夜通知は JST 20:00 実行のため当日20時以降の学習を拾えないが、翌日の判定で正しく反映される
- 夜通知(小学生): 当日分クロールに加えて**前日分もクロール**し、前日分でストリークを確定。通知には「確定ストリーク + 当日すでに学習していれば+1」を暫定表示
- 朝通知(中学生): 元々前日分(`dateOffset: -1`)を取得しているため、そのデータで確定判定

### ストリーク更新ルール

学習した日(確定判定時):

- `streak += 1`
- `streak` が10の倍数に到達するたびに `grace += 1`(上限3、超過分は切り捨て)

未学習の日(確定判定時):

- `grace > 0` なら `grace -= 1` し、`streak` は**維持**(+1しない。Duolingoのフリーズと同方式)
- `grace === 0` なら `streak = 0`、`grace = 0` にリセット(貯めた猶予も持ち越さない)

### エッジケース

| ケース | 挙動 |
|--------|------|
| 初回実行(ストリークデータなし) | 全員 `streak: 0, grace: 0` から開始し、その日の判定から積み上げ |
| 同日再実行(手動ワークフロー実行など) | `lastConfirmedDate` が判定対象日と同じなら確定判定をスキップ(冪等)。表示のみ行う |
| 判定できなかった空白日(CI障害等で `lastConfirmedDate` と判定対象日の間に隙間がある) | **中立扱い**: ストリーク維持・+1なし・猶予消費なし。システム側の問題で子供にペナルティを与えない |
| キャッシュ消失(actions/cache の7日超過・削除) | ストリークは0から再開(cache方式のトレードオフとして許容) |
| クロール失敗で前日分データが取得できない | 確定判定をスキップし、前回の確定値をそのまま表示。翌日以降は空白日ルールで中立処理 |

### 表示対象

夜通知(小学生コース)・朝通知(中学生コース)の**両方**に表示する。

## アーキテクチャ

### データ永続化: actions/cache

- `crawler.yml` / `morning-crawler.yml` の両方に追加:
  - 実行前: `actions/cache/restore`(key prefix `smilezemi-data-` の restore-keys 一致で最新キャッシュを復元)
  - 実行後: `actions/cache/save`(key `smilezemi-data-${{ github.run_id }}` で毎回新規保存)
- **`data/` ディレクトリごとキャッシュ**する。`streak_data.json` に加えて `mission_data.json` も引き継がれるため、現在CI上で機能していなかった前日比較(📈📉表示)も副次的に修復される
- 夜(20:00)→翌朝(7:00)→翌夜と、両ワークフローが同一キャッシュ系列を交互に更新する

### 新モジュール `src/streak.js`

ストリークのロジックは純粋関数として実装し、単体テストを容易にする。

```
loadStreakData()  → Promise<{success, data, error?}>   // data/streak_data.json 読込。ファイルなしは初期状態
saveStreakData(data) → Promise<{success, error?}>
isStudied(user)   → boolean                             // 判定式を notifier.js から移設し共用
confirmDay(state, dateString, studied) → { state, events }  // 1日分の確定判定(純粋関数)
updateStreaks(streakData, users, dateString) → { streakData, results }  // 全ユーザー分適用
formatStreakInfo(state, options) → string               // 通知用のストリーク行を生成
```

`confirmDay` の返す `events` は表示用イベント(`milestone` / `grace_used` / `reset` / `none`)。

### データ形式 `data/streak_data.json`

ユーザー名(表示名文字列。既存設計と同じくコース名込み)をキーに、子供ごとに独立管理:

```json
{
  "version": "1.0",
  "users": {
    "光志郎 (中学生コース)": {
      "streak": 12,
      "grace": 1,
      "lastConfirmedDate": "2026-07-12"
    }
  }
}
```

`mission_data.json` とはファイルを分離する(朝通知はミッションデータを保存しないため、混在させると更新タイミングの整合性が壊れる)。

### エントリポイントへの統合

- `src/index.js`(夜通知): `getAllUsersDetailedData(page, { courseFilter: 'elementary', dateOffset: -1 })` で前日分を追加クロール → ストリーク確定 → `saveStreakData` → 通知メッセージにストリーク情報を渡す
- `src/morning-index.js`(朝通知): 取得済みの前日分データで確定判定 → `saveStreakData` → 通知に反映
- `src/notifier.js`: `formatDetailedMessage` の `options` に `streaks`(userName → 表示情報のマップ)を追加し、ユーザーブロックの勉強時間行の上にストリーク行を出力

### 通知イメージ

```
👤 光志郎 (中学生コース)
🔥 連続学習: 13日目  🛟 おたすけ: 1/3
⏱️ 勉強時間: 00:45
...
```

イベント発生時の追加行:

- 🎉 `10日連続達成!おたすけ+1(残り2)` — マイルストーン到達時
- 💤 `昨日はおたすけを使って連続記録を守りました(残り1)` — 猶予消費時
- 😢 `連続記録がリセットされました。今日からまた頑張ろう!` — リセット時

## テスト方針

既存の Node.js built-in test runner(`node --test`)パターンに従う。

- `tests/streak.test.js`(新設): `confirmDay` の確定判定・10日ごとのマイルストーン・猶予上限3・猶予消費・リセット・空白日の中立処理・同日再実行の冪等性、`loadStreakData`/`saveStreakData` のファイルI/O(data.test.js のパターン踏襲)
- `tests/notifier.test.js`: ストリーク行の表示、イベント行(マイルストーン/猶予消費/リセット)、`streaks` オプション省略時の後方互換
- `tests/index.test.js` / `tests/morning-index.test.js`: ストリーク統合分のフロー確認

## 検証方法

1. `npm test` で全テスト通過
2. ローカルで `.env` を使い `node src/index.js` を実行し、`data/streak_data.json` が生成・更新されること、LINE通知にストリーク行が含まれることを確認
3. 連続実行(同日再実行)でストリークが二重加算されないことを確認
4. ワークフローの cache restore/save ステップは手動実行(`workflow_dispatch`)で動作確認
