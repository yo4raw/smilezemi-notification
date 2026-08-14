# 中学生コース: ストリーク必要講座数を一律3件に統一する設計

日付: 2026-08-14
ステータス: 承認済み

## 目的

中学生コースのストリーク(連続学習日数)更新に必要な完了講座数を、曜日別(平日3・土日5)から**曜日によらず一律3講座**に戻す。土日5講座は負担が重く、平日と同じ基準に揃える。

これは `docs/superpowers/specs/2026-07-13-junior-high-weekend-threshold-design.md` で導入した曜日別しきい値の撤回にあたる。

## 要件

- 中学生コースの必要講座数は判定対象日の曜日にかかわらず 3
- 曜日判定の仕組み自体を残さず削除する(結果が変わらない分岐をコードに残さない)
- 小学生コース(完了ミッション4個)は変更しない
- 朝通知の確定判定・未達警告行、夜通知のLINE送信可否判定・未達警告行のすべてが新しいしきい値に追従する
- しきい値の定義元は `src/streak.js` の `STREAK_REQUIREMENTS` のまま。数値の直書きは禁止

## 設計

### src/streak.js

`juniorHighCourses` を曜日別オブジェクトから単一の数値に変更する:

```js
const STREAK_REQUIREMENTS = {
  elementaryMissions: 4, // 小学生コース: 完了ミッション数
  juniorHighCourses: 3   // 中学生コース: 完了講座数(曜日によらず一律)
};
```

- `getJuniorHighRequirement(dateString)` を削除する(`module.exports` からも外す)
- `getRequirementForCourse(course, dateString)` から `dateString` を落とし `getRequirementForCourse(course)` にする。しきい値が日付に依存しなくなったため引数が不要になる

  ```js
  function getRequirementForCourse(course) {
    return course === 'juniorHigh'
      ? STREAK_REQUIREMENTS.juniorHighCourses
      : STREAK_REQUIREMENTS.elementaryMissions;
  }
  ```

- `updateStreaksByCourse` 内の呼び出しを `getRequirementForCourse(course)` に追随させる。`updateStreaksByCourse` 自身の `dateString` 引数は確定日として引き続き必要なため残す

### src/index.js(夜通知)

- `getRequirementForCourse` の3箇所の呼び出しから日付引数を除く
- これにより `todayDateString` が未使用になるため削除し、あわせて未使用になる `getTargetDates` の import も外す(`npm run lint` は `--deny-warnings` のため未使用変数は警告ではなくエラーになる)

### src/morning-index.js(朝通知)

- import から `getJuniorHighRequirement` を外す
- `missionWarningThresholds.juniorHigh` を `STREAK_REQUIREMENTS.juniorHighCourses` に変更する(小学生側が `STREAK_REQUIREMENTS.elementaryMissions` を直接参照しているのと同じ形になる)

### CLAUDE.md

- 「中学生コースは平日3件・土日5件以上の完了講座」→「中学生コースは3件以上の完了講座」に変更する
- 「中学生の曜日別しきい値は `getJuniorHighRequirement(dateString)` で取得する」の一文を削除する
- 「（判定対象日の曜日で決まる。祝日は曜日のみで判定）」の但し書きを削除する

## データ移行

不要。しきい値は `streak_data.json` に保存されず、コード側の定数のみで決まる。

確定済みの日は `lastConfirmedDate` により再判定されないため、過去のストリーク・おたすけ・ボーナスは一切変化しない。新しいしきい値が効くのは**次回の夜通知(当日の速報警告・LINE送信可否)と、次回の朝通知(前日分の確定判定)**から。

## テスト

- `tests/streak.test.js`
  - import と `describe('getJuniorHighRequirement')` ブロック(平日/土曜/日曜/月曜の4テスト + 「平日は3・土日は5である」)を削除する
  - `STREAK_REQUIREMENTS` の形テストを、`juniorHighCourses` が正の整数であることの検証に変更する(現在は `.weekday` / `.weekend` を個別に検証している)
  - `describe('getRequirementForCourse')` の各テストから日付引数を外す。「平日しきい値を返す」「土日しきい値を返す」の2テストは、`juniorHighCourses` を返す1テストに統合する
  - `describe('updateStreaksByCourse')` に**土曜日付(`2026-07-11`)で中学生3講座なら学習成立**するテストを追加する。曜日別しきい値に戻っていないことを確定判定のレベルで押さえる回帰テストで、今回の変更の実効的な担保になる
- `tests/index.test.js`
  - モックの `STREAK_REQUIREMENTS` を新しい形(`juniorHighCourses: 3`)に更新する。`getRequirementForCourse` のモックは既に `(course) => ...` のシグネチャのため変更不要
- 検証コマンド: `npm test` と `npm run lint`

## 影響しないもの

- 小学生コースのしきい値(4件)
- ストリーク・おたすけ・ボーナスの加算/消費ロジック
- 未達警告の文言(`missionWarningStyle` の夜/朝の出し分け)。残り件数のみを表示する形式のため、しきい値の変更で文言は変わらない
- 通知の送信経路(LINE / Discord)
