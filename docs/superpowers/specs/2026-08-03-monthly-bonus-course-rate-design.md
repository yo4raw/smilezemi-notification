# 月次ボーナス清算のコース別単価を修正する 設計

日付: 2026-08-03
ステータス: 承認済み

## 背景・問題

2026-08-01 の月次ボーナス清算で、中学生コースの子も小学生コースの単価（1ポイント ¥30）で計算されていた。正しくは中学生コースは ¥50 である。

原因は `src/monthly-bonus-index.js` の `toBonusYen()` が、表示名の文字列マッチでコースを判定していることにある。

```js
const rate = userName.includes('中学生コース')
  ? BONUS_POINT_YEN.juniorHigh   // ¥50
  : BONUS_POINT_YEN.elementary;  // ¥30
```

ところが本番の `streak_data.json` のキーはコース表記を含まない素の名前（`"◯◯さん"` 形式）だった。読み取り専用ワークフロー `show-streak-data.yml` で確認したところ、登録済み3ユーザーすべてがこの形式である。

表示名にコース名が付かないのは `src/crawler.js:1174` のためである。

```js
const displayName = courseName ? `${userName} (${courseName})` : userName;
```

対象ユーザーはコース選択画面を経由せず「コース選択なし」の経路（`src/crawler.js:1312`）を通るため、`getCourseData()` に `courseName` が `null` で渡り、コース名が付かない。結果 `includes('中学生コース')` は常に false になり、全員が小学生単価で清算される。

コース種別そのものは正しく判定できている。`src/crawler.js:1178` が `course`（`'elementary'` / `'juniorHigh'`）を付与しており、夜通知・朝通知のしきい値切り替えはこれで正しく動いている。**問題は `course` が `streak_data.json` に保存されておらず、清算まで届いていない**ことである。`settleBonuses()`（`src/streak.js:198-208`）が返すのは `{userName, bonus}` だけでコース情報を持たない。

コース別単価が導入されたのは 2026-07-27 頃のため、影響を受けた清算は 8/1 の1回だけである。

### テストがバグを見逃した理由

`tests/monthly-bonus-index.test.js:277` の「中学生コースは1ポイント50円で換算する」は通っていた。テストデータの名前が `"たろう (中学生コース)"` 形式だったためである。**テストが本番では成立しない前提を固定していた**ことが、見逃しの直接の原因である。

## 対策方針

`streak_data.json` の各ユーザー状態に `course` を保存し、清算はそれを見て単価を決める。名前の文字列マッチは廃止する。

### 廃案: 月次清算でクロールしてコースを取得する

確実だが、「クロール不要のためブラウザを起動しない」という月次清算の設計が崩れる。Playwright 起動・ログイン・ユーザー切り替えが必要になり実行時間は10秒から数分に伸び、クロール失敗が支給を止めるリスクも増える。

### 廃案: 表示名に必ずコース名を付ける

`src/crawler.js:1174` の `courseName` が null になる経路を直せば根本原因の修正に見えるが、`streak_data.json` のキーは表示名そのものなので、**既存ユーザーのストリーク（最大19日）とおたすけが全てリセットされる**。移行スクリプトでキーを付け替えれば回避できるが、単価を直すためだけに負うリスクではない。

### 8/1 分の差額

1ポイントあたり ¥20 の不足はコードでは扱わない。手渡しで調整する（ユーザー判断）。

## 変更内容

### 1. `src/streak.js` — 状態に `course` を保存する

各ユーザー状態に任意フィールド `course`（`'elementary'` | `'juniorHigh'`）を追加する。

```json
"たろう": { "streak": 19, "grace": 3, "bonus": 2, "lastConfirmedDate": "2026-08-02", "course": "juniorHigh" }
```

**`version` は 1.3 のまま上げない。** `loadStreakData()` の移行判定は次のようにハードコードされているため（`src/streak.js:347-351`）、1.4 に上げると既存の 1.3 データに対しておたすけ満タン付与が誤って再発火する。

```js
if (version !== '1.3') { Object.values(users).forEach(state => { state.grace = GRACE_MAX; }); }
```

`course` は欠落を許容する任意フィールドなので移行処理そのものが不要である。欠落時のフォールバックは `'elementary'` とし、`getRequirementForCourse()` や `updateStreaksByCourse()` の既存の慣例（`user.course || 'elementary'`）に揃える。

書き込みは `updateStreaks()`（`src/streak.js:219-241`）で行う。コースは学習したかどうかと無関係に分かる情報なので、**`dataReliable: false` で確定をスキップする経路（`:230-233`）でも書き込む**。`user.course` が undefined のときは既存値を保持し、上書きで消さない。純粋関数の性質（入力を破壊しない）は維持する。

意図的な挙動変更が1つある。現状 `dataReliable: false` の分岐は `updated[user.userName]` へ代入せずに return するため、初回クロールが失敗した新規ユーザーは登録されない。course を書くために代入するようになるので、そのユーザーは初期状態（streak 0 / grace 1 / bonus 0）で登録されるようになる。`confirmDay()` は呼ばれないままなので連続日数の誤確定は起きず、清算に 0 ポイントで並ぶだけである。表示の一貫性はむしろ上がる。

`settleBonuses()` は settlements の要素に `course` を載せる。

```js
settlements.push({ userName, bonus: state.bonus ?? 0, course: state.course });
```

### 2. `src/monthly-bonus-index.js` — コースで単価を決める

`toBonusYen()` の引数を名前からコースに変え、文字列マッチを捨てる。

```js
function toBonusYen(course, bonus) {
  const rate = course === 'juniorHigh' ? BONUS_POINT_YEN.juniorHigh : BONUS_POINT_YEN.elementary;
  return bonus * rate;
}
```

`BONUS_POINT_YEN`（小学生 ¥30 / 中学生 ¥50）の定義位置と「単価を変えるときはここだけ書き換える」という約束は変えない。メッセージに単価を表示するため、金額計算とラベル用の単価取得の両方が同じ値を参照する必要がある。二重定義を避けるため、コースから単価を返すヘルパ `toBonusRate(course)` を置き、`toBonusYen()` と整形処理の双方がそれを使う。上のコード例の分岐は `toBonusRate()` の中身であり、`toBonusYen()` は `bonus * toBonusRate(course)` を返す。

### 3. メッセージ書式に単価を明示する

金額だけでは単価が正しいか分からず、今回のバグが見つかりにくかったため、行ごとに単価を出す。

```text
💰 ボーナスポイント清算(7月分)

👤 たろう: 5ポイント × ¥50 → ¥250
👤 はなこ: 3ポイント × ¥30 → ¥90

合計: ¥340
ボーナスポイントはお小遣いとして支給してね!
```

0ポイントのユーザーも従来どおり行を出す（`0ポイント × ¥30 → ¥0`）。3桁区切り、合計行、支給の案内文、対象0人時に合計行を出さない挙動はすべて現状維持とする。

### 4. `scripts/show-streak-data.js` — course を表示する

`data/` は actions/cache 経由でしか存在しないため、`course` が書き込まれたことの確認は読み取り専用ワークフロー `show-streak-data.yml` で行う。現在の出力に course が含まれないので1項目追加する。

```text
  - "たろう": streak=19 grace=3 bonus=2 course=juniorHigh lastConfirmedDate=2026-08-02
```

未設定のユーザーは `course=(未設定)` と表示し、フォールバックで小学生単価が使われる状態を判別できるようにする。

### 5. テスト

まず既存テストの前提を差し替える。`tests/monthly-bonus-index.test.js` の金額テスト群（`:267-345`）は名前に `(中学生コース)` を含めることでコースを表現しているが、これが本番と乖離した前提そのものなので、`course` フィールドを持つ fixture に置き換える。名前は素の `"たろう"` 形式にして本番のキー形式に揃える。

`tests/streak.test.js` に追加する:

- `updateStreaks` が `user.course` を状態に保存する
- `dataReliable: false` のユーザーでも course が保存され、streak / grace / bonus は変化しない
- `user.course` が undefined のとき既存の course を消さない
- `settleBonuses` が settlements に course を載せる
- 既存の 1.3 移行テスト群（`:328-406`）はそのまま通ること（version を上げない回帰の防波堤）

`tests/monthly-bonus-index.test.js` に追加する:

- `course: 'juniorHigh'` は ¥50、`'elementary'` は ¥30 で換算する
- `course` が欠落したユーザーは ¥30 で換算する
- メッセージ行に `× ¥50` / `× ¥30` が出る
- コース混在時の合計が正しい

### 6. ドキュメント

- `src/streak.js` 冒頭のデータ構造コメント（`:4-16`）に `course` を追記する。あわせてキー例が `"ユーザー名 (コース名)"` となっているが本番は素の名前なので実態に合わせる
- `CLAUDE.md` のストリーク機能の節にある月次清算の単価説明に、コースの判定根拠が `streak_data.json` の `course` であることを追記する

## エラー処理・エッジケース

- **`course` 欠落**: `'elementary'` として扱い ¥30 で換算する。既存の `user.course || 'elementary'` の慣例に揃えた安全側の既定値。`show-streak-data.js` で `(未設定)` として可視化する
- **未知の course 値**: `'juniorHigh'` 以外はすべて `'elementary'` 扱い。真偽の分岐1つで済ませ、想定外の値でも支給が止まらないようにする
- **`dataReliable: false`**: course は書き込むが確定判定はスキップする（現状の誤リセット防止は維持）
- **キャッシュ消失**: `streak_data.json` ごと失われ bonus も 0 になるため、course 欠落による金額の誤りは発生しない（0ポイントは単価によらず ¥0）
- **デプロイから最初の朝通知までの窓**: この間に清算が走ると course 欠落で全員 ¥30 になる。次回清算は 9/1 で、それまでに毎日の朝通知が書き込むため実際には到達しない

## 移行と運用

コード側の移行処理は不要。デプロイ後、毎日 JST 7:00 の朝通知が確定処理で全ユーザーに `course` を書き込む。

## 検証

- `npm test` が全件通ること
- `npm run lint` が通ること
- `DRY_RUN=true node -r dotenv/config src/monthly-bonus-index.js` を実行し、プレビューに単価付きの行が出ること
- デプロイ翌朝以降に `show-streak-data.yml` を実行し、全ユーザーに `course` が入っていること
- 9/1 の清算で中学生コースの子が ¥50 換算になっていること
