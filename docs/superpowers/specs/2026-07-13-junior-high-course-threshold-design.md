# 中学生コースの講座4完了ルール + 閾値定数の集約 設計書

作成日: 2026-07-13
ステータス: ユーザー承認済み(警告表示あり・閾値のグローバル定数化の指示を反映)

## 要件

1. 中学生コースにはミッションがない(講座)ため、**講座を4つ終えること**をストリークのカウント条件にする
2. 朝通知に「講座完了 N/4個」の警告文を表示する
3. ストリーク更新に必要な小学生のミッション数(5)・中学生の講座完了数(4)を**グローバルな定数として集約**し、変更を容易にする

## 前提(データの意味)

中学生コースの `missionCount` はタイムラインに載った実施済み講座数(`getTodayMissionCountForJuniorHigh` が `.course__KrAEA` をカウント)。講座詳細は全件 `completed: true` でスコア付き。したがって「講座を4つ終えた」= `missionCount >= 4` であり、既存の `minCompletedMissions` オプションがそのまま使える。

## 設計

### 1. 閾値定数の集約 (`src/streak.js`)

```js
// ストリーク更新(カウント+1)に必要な完了数。変更時はここだけ書き換える
const STREAK_REQUIREMENTS = {
  elementaryMissions: 5, // 小学生コース: 完了ミッション数
  juniorHighCourses: 4   // 中学生コース: 完了講座数
};
```

- `STREAK_REQUIREMENTS` をエクスポートする
- `src/index.js` のローカル定数 `REQUIRED_MISSIONS_FOR_STREAK` を削除し、`STREAK_REQUIREMENTS.elementaryMissions` の参照に置換する
- `tests/index.test.js` の streak モックに `STREAK_REQUIREMENTS` を追加する(require.cache 注入方式のため必須)

### 2. 朝通知の配線 (`src/morning-index.js`)

- 前日確定判定: `updateStreaks(..., { minCompletedMissions: STREAK_REQUIREMENTS.juniorHighCourses })`
- 警告表示: `formatDetailedMessage(..., { ..., missionWarningThreshold: STREAK_REQUIREMENTS.juniorHighCourses })`
- 4つ未満の日は小学生コースと同じ未学習扱い(おたすけ消費→尽きたらリセット)。`dataReliable: false` の誤リセット防止ガードは既存のまま有効
- 朝通知は前日の確定データを扱うため、暫定+1表示は元々なく追加不要

### 3. 警告文の調整 (`src/notifier.js`)

- 警告の単位ラベルをコースで切り替える: 中学生コース=「講座」、小学生コース=「ミッション」
  - 中学生: `⚠️ 講座完了 2/4個 — 4個完了しないと連続学習にカウントされないよ!`
  - 小学生: `⚠️ ミッション完了 3/5個 — 5個完了しないと連続学習にカウントされないよ!`(既存表記のまま)
- **完全未学習の日は既存の「⚠️ 昨日は学習していません」のみ表示**し、閾値警告と重複させない。条件: `showNoStudyWarning && isNoStudy` のときは閾値警告をスキップ(夜通知は `showNoStudyWarning` を指定しないため現行どおり 0/5 でも警告が出る)
- 実装上、`isJuniorHigh` / `isNoStudy` の算出を警告ブロックより前に移動する

### 4. 挙動が変わる点(意図された仕様変更)

中学生コースで「勉強時間はあるが講座4つ未満」の日は、これまで+1だったものがカウントされなくなる。翌朝7時の通知(前日分の確定)から適用される。

## テスト

- `tests/streak.test.js`: `STREAK_REQUIREMENTS` がエクスポートされ、`elementaryMissions` / `juniorHighCourses` が正の整数であること
- `tests/notifier.test.js`: 中学生ユーザーで「講座完了 N/4個」表記になる / 小学生は「ミッション完了」のまま / `showNoStudyWarning` 併用時、完全未学習なら閾値警告が出ない(部分学習なら出る)
- `tests/index.test.js`: 既存の「閾値5が渡る」テストがモック更新後もグリーン
- morning-index はテスト基盤が薄い(エクスポート確認のみ)ため、配線は DRY_RUN 実行で確認する

## 受け入れ基準

1. `npm test` 全件グリーン
2. `DRY_RUN=true` の朝通知ローカル実行で、講座4未満の日に「⚠️ 講座完了 N/4個」が表示される(完全未学習日は「昨日は学習していません」のみ)
3. `DRY_RUN=true` の夜通知ローカル実行で、小学生の警告表記が従来と同一である
