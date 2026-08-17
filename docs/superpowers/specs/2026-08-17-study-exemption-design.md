# 学習免除日（おやすみ）機能 設計

日付: 2026-08-17
ステータス: 承認済み

## 目的

どうしても勉強できない日（旅行・体調不良・行事など）を「免除日」として登録できるようにする。免除日は未学習でもストリークをリセットせず、**おたすけ（grace）も消費しない**。免除日は未来日付にも過去日付にも登録でき、過去日付の場合は既に確定済みの判定を巻き戻して修復する。

## 要件

- 免除日に未学習でも `streak` は据え置き、`grace` は消費しない
- 免除日に学習していた場合は**学習を優先**し、通常どおり `streak +1`・マイルストーン・ボーナスが動く（免除は「未学習でも罰しない盾」として働くだけ）
- 免除は**未来日付**（旅行の予定を事前登録）と**過去日付**（体調不良に翌日以降に気づいた）の両方に対応する
- 過去日付は日数の制限なく遡れる（ただし履歴の保持期間内。後述）
- 登録は「対象（1人 / 全員） × 期間（開始日〜終了日）」の単位で行い、取り消しもできる
- 免除日は通知に明示する（夜は警告の代わりに「おやすみ」、朝は「記録はそのまま」）
- 本番のデータは GitHub Actions キャッシュ内にのみ存在するため、登録経路は既存の `adjust-streak-field.yml` と同じ workflow_dispatch 方式にする

## 用語

- **判定対象日**: ストリークの成否を判定する日。朝通知では前日
- **確定**: 判定対象日について `streak` / `grace` を更新し、その日を判定済みにすること
- **リプレイ**: 保存した履歴を日付順に `confirmDay` へ通し直し、`streak` / `grace` を導出すること

## データモデル

`data/streak_data.json` を v1.3 → **v1.4** に上げ、各ユーザーに3つのフィールドを足す。

```jsonc
{
  "version": "1.4",
  "timestamp": "ISO 8601",
  "users": {
    "たろう": {
      "streak": 12,                  // リプレイの導出値
      "grace": 2,                    // リプレイの導出値
      "bonus": 4,                    // リプレイ対象外（後述）
      "course": "juniorHigh",
      "lastConfirmedDate": "2026-08-16",
      "exemptDates": ["2026-08-20", "2026-08-21"],  // 免除日。未来・過去を問わない
      "history": {                   // 判定対象日 → その日に学習が成立したか
        "2026-08-15": true,
        "2026-08-16": false
      },
      "replayBase": {                // history より前の状態のチェックポイント
        "streak": 5,
        "grace": 3,
        "date": "2026-06-01"         // このチェックポイントが「確定済み」としている最後の日
      }
    }
  }
}
```

### history の性質

- **実際に確定判定した日だけ**を持つ。`dataReliable: false` でスキップした日は記録しないため、現行の「未判定の空白日は中立扱い（ペナルティなし）」がそのまま保たれる
- 値は「その日に学習が成立したか」（`isStudied()` の結果）であって、完了件数ではない。しきい値が将来変わっても過去の判定結果は動かない
- 保持期間は **90日**。溢れた古い日は `replayBase` に畳み込む（後述のプルーニング）

### replayBase の性質

- `history` に載っていない過去すべてを1つの状態に圧縮したもの
- `replayBase.date` は「この状態がどの日まで確定済みか」を表す。`history` のキーはすべてこの日より後になる
- `bonus` は持たない（リプレイ対象外のため）

## 確定ロジック

### confirmDay の変更

`confirmDay(state, dateString, studied)` に第4引数 `options` を足し、`options.exempt` を受け取る。追加する分岐は1つだけ。

```javascript
// （studied のブロックを抜けた後、`streak === 0` の判定より前に置く）
// 免除日は未学習でも罰しない: streak も grace も据え置き、日付だけ進める
if (options.exempt) {
  return {
    state: { streak: state.streak, grace: state.grace, bonus, lastConfirmedDate: dateString },
    event: 'exempt'
  };
}
```

`studied === true` の経路は先に return するため、この分岐に届くのは未学習の日だけである。免除日でも学習していれば通常どおり加算・マイルストーン・ボーナスが動く。

`createInitialState()` には `exemptDates: []` / `history: {}` / `replayBase: { streak: 0, grace: GRACE_INITIAL, date: null }` を足す。`replayBase.date` が `null` のときは「まだ1日も確定していない」を意味し、`confirmDay` の既存ガード（`state.lastConfirmedDate &&` で始まる）がそのまま正しく働く。

### replayStreak（新規・純粋関数）

```javascript
replayStreak(replayBase, history, exemptDates)
  → { streak, grace, lastConfirmedDate, events }
```

`history` のキーを日付昇順に並べ、`replayBase` を初期状態として `confirmDay` を順に適用する。`events` は「日付 → その日のイベント（`milestone` / `grace_used` / `reset` / `bonus` / `exempt` / `none`）」のマップで、通知が当日分の文言を選ぶために使う。

`bonus` はどの分岐の条件にも影響しない（`confirmDay` は `bonus` を読み書きするだけで、遷移の判断には使わない）ため、リプレイは `bonus` を扱わない。

### 日次の流れ（朝通知）

1. 判定対象日が既に `history` にあれば何もしない（同日再実行の冪等性。現行の `lastConfirmedDate` ガードと同じ役割）
2. `history[判定対象日] = isStudied(...)` を追記
3. `replayStreak()` でリプレイし、`streak` / `grace` / `lastConfirmedDate` を書き戻す
4. `events[判定対象日] === 'bonus'` なら `bonus += 1`（現行と同じ挙動）
5. プルーニングを適用して保存

### 遡及免除の流れ（スクリプト実行時）

1. 対象日を `exemptDates` に追加（`--action remove` なら取り除く）
2. `replayStreak()` でリプレイ
3. `streak` / `grace` の before → after を表示して保存

リセットもおたすけ消費も、リプレイの結果として自動的に巻き戻る。取り消し（`remove`）も同じ流れで、外した日の罰がリプレイによって再適用される。

既に登録済みの日を `add` した場合と、登録されていない日を `remove` した場合は、いずれも変更なしとして表示だけ行う（エラーにはしない。期間指定では一部だけ登録済みという状態が普通に起きるため）。

対象日が `history` の範囲外（保持期間より前、または移行前）のときは修復できないため、**スクリプトはエラーで中断**し、既存の `smilezemi-set-streak` / `smilezemi-set-grace` スキルでの手動調整を案内する。未来日付は `history` にまだ無いのが当然なので、この検査は「対象日が `replayBase.date` 以前」のときだけ行う。

### プルーニング

保存時に、`history` のうち最も新しい日から数えて90日より古いエントリを、古い順に `confirmDay` へ通して `replayBase` に畳み込み、`history` から取り除く。畳み込みの際も `exemptDates` を参照するため、免除の効果はチェックポイントに正しく織り込まれる。畳み込みが済んだ日の `exemptDates` エントリも併せて取り除く（効果は `replayBase` に反映済みのため）。

## ボーナスの扱い（意図的にリプレイ対象外）

`bonus` はリプレイで再計算せず、現行どおり「その日の確定イベントが `bonus` なら +1、月次清算で 0」のまま維持する。

遡及免除は理屈の上では過去のボーナス獲得数にも影響しうる（リセットが消えると `grace` が満タンのまま推移し、後続の学習日がボーナス付与になる）。それでも再計算しないのは、**ボーナスは毎月1日に現金として支給済みの可能性があるお金**であり、支給後に金額が変わる方が害が大きいためである。過去分を補填したい場合は既存の `smilezemi-set-bonus` スキルで手動調整する。

この判断により、`src/monthly-bonus-index.js`・`scripts/set-streak-field.js`・`smilezemi-set-bonus` スキルには変更が入らない。

## 移行（v1.3 → v1.4）

読み込み時に、v1.4 未満のデータへ次を適用する。

- `replayBase = { streak: 現在の streak, grace: 現在の grace, date: lastConfirmedDate }`
- `history = {}`
- `exemptDates = []`

つまり**移行より前の日は遡及できない**。遡れるのは本機能を投入した日以降に確定した日だけであり、この制約は運用スキルの説明にも明記する。

`loadStreakData()` の許可バージョン一覧に `'1.4'` を足し、`saveStreakData()` は常に `'1.4'` で書き出す。既存の 1.3 未満向けのおたすけチャージ移行は現状のまま残す。

## 運用経路

### scripts/set-exempt-dates.js（新規）

```bash
node scripts/set-exempt-dates.js --user "たろう" --from 2026-08-20 [--to 2026-08-22] --action add [--dry-run]
node scripts/set-exempt-dates.js --all --from 2026-08-20 --to 2026-08-22 --action remove
```

検証はすべてこのスクリプトに集約する（既存の `set-streak-field.js` と同じ方針）。

- `--user` と `--all` はどちらか一方が必須
- 日付は `YYYY-MM-DD` 形式のみ。`--to` 省略時は `--from` と同じ日
- `from <= to` であること
- 一度に登録できる期間の上限は **31日**（打ち間違いで大量の免除日を作らないため）
- `--user` 指定時は既存ユーザーキーのみ（未知キーは登録済み一覧を出して中断）
- `--action add` で対象日が `history` の範囲外なら中断し、手動調整スキルを案内する
- 実行時は免除日の増減と、`streak` / `grace` の before → after を必ず表示する
- `--dry-run` では保存しない

### .github/workflows/exempt-days.yml（新規）

`adjust-streak-field.yml` と同じ構造にする: キャッシュ復元 → 復元の整合性検証（既存エントリがあるのに復元できなければ中断）→ Node セットアップ → スクリプト実行 → 成功かつ非 dry-run なら新しい `run_id` キーで保存。入力はシェルへ直接展開せず `env` 経由で渡す。

`workflow_dispatch` の入力: `user`（`__all__` で全員）/ `from` / `to`（任意）/ `action`（`add` | `remove`）/ `dry_run`。ワークフローは `user` が `__all__` のときスクリプトへ `--all` を、それ以外のときは `--user "<入力値>"` を渡す。

### .claude/skills/smilezemi-exempt-day/（新規）

既存3スキルと同じ形式。既存スキルを field ごとに分けたのは誤操作防止のためだが、本機能は操作対象が免除日ひとつなので、add と remove を1スキルで扱う。

### scripts/show-streak-data.js（変更）

各ユーザーの `exemptDates` と、直近7日ぶんの `history` を表示に加える。

## 通知

### 夜通知（src/index.js）

- 当日が免除日のユーザーは `hasUnqualifiedUser` の判定から除外する（免除日のために LINE を消費しない）
- そのユーザーには未達警告行を出さず、代わりに `🏝️ 今日はおやすみ（免除日）` を出す
- **この変更により、夜通知が `streak_data.json` を読むようになる**。現行は「夜はストリーク値を表示しないため読まない」設計であり、CLAUDE.md の該当記述も更新する
- 読み込みに失敗した場合は「免除日なし」として通知を継続する（グレースフルデグラデーション）

### 朝通知（src/morning-index.js / notifier.js）

- 判定対象日のイベントが `exempt` のユーザーには `😌 免除日のため記録はそのままです` を出す
- そのユーザーには未達警告行を出さない

### notifier.js のインターフェース

`formatDetailedMessage` のオプションに `exemptUserNames`（免除ユーザー名の配列）を足す。`missionWarningThresholds` と同じく、呼び出し側が判定済みの情報を渡す形にして、`notifier.js` からストリークデータへの依存を作らない。

## エラー処理

- `history` の壊れたエントリ（`YYYY-MM-DD` 形式でないキー、boolean でない値）は無視してログに残す
- `replayBase` が欠けている場合は、そのユーザーの現在の `streak` / `grace` から復元する。履歴の不備を理由に `streak` を 0 にする方が被害が大きいため、リプレイは「分かる範囲で復元して続行」する
- `streak_data.json` そのものが壊れている場合の扱いは現行どおり（エラーを記録しつつ空状態で続行し、次回保存で自己修復）

## LINE送信数への影響

夜通知は「当日のストリーク要件未達のユーザーが1人でもいる日」だけ LINE に送る。免除ユーザーがこの判定から外れるため、**全員が免除の日は LINE を使わず Discord だけの記録になる**。送信数は減る方向に動き、月間200カウントの枠に対して有利である。

## テスト

- `tests/streak.test.js`
  - `confirmDay`: 免除 × 未学習で `streak` / `grace` が据え置き `event: 'exempt'`、免除 × 学習で通常どおり +1（マイルストーン・ボーナスも動く）、`streak === 0` の免除日
  - `replayStreak`: 免除日ゼロなら現行のインクリメンタル確定と同じ値になること、途中日を免除するとリセットが巻き戻ること、マイルストーンとおたすけ上限が再計算されること、壊れたエントリを無視すること、`replayBase` 欠損時の復元
  - プルーニング: 90日を超えた分が `replayBase` に畳み込まれ、その際に免除が反映されること、畳み込み済みの `exemptDates` が取り除かれること
  - 移行: v1.3 のデータを読むと `replayBase` / `history` / `exemptDates` が補われること
  - 日次の流れ: 同じ日を2回確定しても値が動かないこと（冪等性）
- `tests/set-exempt-dates.test.js`（新規）: 入力検証（形式・`from <= to`・31日上限・`--user` と `--all` の排他）、add / remove、範囲外日付での中断、未知ユーザーでの中断、`--dry-run` で保存しないこと
- `tests/index.test.js`: 免除ユーザーが夜の LINE 送信判定から外れること、`exemptUserNames` が `formatDetailedMessage` に渡ること
- `tests/notifier.test.js`: 免除ユーザーに「おやすみ」行が出て未達警告行が出ないこと、朝の `exempt` イベントの文言
- 検証コマンド: `npm test` と `npm run lint`

## 影響しないもの

- ストリークのしきい値（小学生4件 / 中学生3件）と `isStudied` の判定ロジック
- 月次ボーナス清算（`src/monthly-bonus-index.js`）とコース別単価
- 既存の `smilezemi-set-grace` / `smilezemi-set-streak` / `smilezemi-set-bonus` スキルと `scripts/set-streak-field.js`
- 通知の送信経路（LINE / Discord）とその失敗時の扱い
- クローリング処理（`src/crawler.js`）と DOM セレクタ

## 今後やらないこと（YAGNI）

- 免除日の自動判定（祝日カレンダー連携など）。手動登録で足りる
- 免除日の理由や種別の記録。運用は家族内で、理由は口頭で共有される
- 免除の残数制限（月◯回まで等）。登録するのは保護者であり、乱用の心配がない
