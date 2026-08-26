# 中学生コース しきい値一律3件化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中学生コースのストリーク成立に必要な完了講座数を、曜日別(平日3・土日5)から曜日によらず一律3件に統一し、曜日判定のコードを削除する。

**Architecture:** `src/streak.js` の `STREAK_REQUIREMENTS.juniorHighCourses` をオブジェクトから数値 `3` に変え、`getJuniorHighRequirement(dateString)` を削除する。しきい値が日付に依存しなくなるため `getRequirementForCourse(course, dateString)` は `getRequirementForCourse(course)` に簡約され、呼び出し側(`src/index.js` の夜通知・`src/morning-index.js` の朝通知)が追随する。データ移行は不要。

**Tech Stack:** Node.js >= 24 (CommonJS), Node.js built-in test runner (`node --test`), oxlint

## Global Constraints

- しきい値の定義元は `src/streak.js` の `STREAK_REQUIREMENTS` のみ。他ファイルでの数値の直書きは禁止
- 小学生コースのしきい値(`elementaryMissions: 4`)は変更しない
- `npm run lint` は `--deny-warnings` で走るため、未使用の変数・import が1つでも残るとエラーになる
- Markdown は日本語で書く
- 設計の出典: `docs/superpowers/specs/2026-08-14-junior-high-uniform-threshold-design.md`

---

### Task 1: しきい値の一律化と曜日ロジックの削除

**Files:**
- Modify: `src/streak.js:30-50`(定数と `getJuniorHighRequirement`)、`src/streak.js:274-284`(`getRequirementForCourse`)、`src/streak.js:303`(呼び出し)、`src/streak.js:430`(exports)
- Modify: `src/index.js:9`(import)、`src/index.js:245-255`(達成判定)、`src/index.js:279-286`(警告しきい値)
- Modify: `src/morning-index.js:13-20`(import)、`src/morning-index.js:175-178`(警告しきい値)
- Test: `tests/streak.test.js:10-25`(import)、`tests/streak.test.js:30-61`(定数と曜日関数のテスト)、`tests/streak.test.js:786-843`(`getRequirementForCourse` / `updateStreaksByCourse`)
- Test: `tests/index.test.js:185`(モックの `STREAK_REQUIREMENTS`)

**Interfaces:**
- Produces: `STREAK_REQUIREMENTS = { elementaryMissions: 4, juniorHighCourses: 3 }` — `juniorHighCourses` は数値
- Produces: `getRequirementForCourse(course: 'elementary'|'juniorHigh'|undefined) → number` — 第2引数の `dateString` を削除
- Removes: `getJuniorHighRequirement(dateString)` — exports からも削除。リポジトリ内に他の呼び出し元はない
- Unchanged: `updateStreaksByCourse(streakUsers, users, dateString)` の引数。`dateString` は確定日のキーとして引き続き必要

- [ ] **Step 1: テストを新しい仕様に書き換える**

`tests/streak.test.js` の import から `getJuniorHighRequirement` を削除する(10-25行目の分割代入):

```javascript
const {
  createInitialState,
  isStudied,
  countCompletedMissions,
  countStudyItems,
  confirmDay,
  updateStreaks,
  formatStreakInfo,
  settleBonuses,
  loadStreakData,
  saveStreakData,
  STREAK_REQUIREMENTS,
  getRequirementForCourse,
  updateStreaksByCourse
} = require('../src/streak');
```

30-61行目(`describe('STREAK_REQUIREMENTS')` と `describe('getJuniorHighRequirement')` の2ブロック)を、次の1ブロックに置き換える(曜日関数のテストは丸ごと削除する):

```javascript
describe('STREAK_REQUIREMENTS', () => {
  it('コースごとの必要完了数が正の整数として集約定義されている', () => {
    assert.ok(Number.isInteger(STREAK_REQUIREMENTS.elementaryMissions) && STREAK_REQUIREMENTS.elementaryMissions > 0);
    assert.ok(Number.isInteger(STREAK_REQUIREMENTS.juniorHighCourses) && STREAK_REQUIREMENTS.juniorHighCourses > 0);
  });

  it('中学生コースは曜日によらず一律のしきい値である(数値であること)', () => {
    assert.strictEqual(typeof STREAK_REQUIREMENTS.juniorHighCourses, 'number');
  });
});
```

> 実行時の裁定（2026-08-14）: 2本目の `it('中学生コースは曜日によらず一律のしきい値である(数値であること)')` は実装しなかった。1本目の `Number.isInteger()` に包含される重複アサーションのため。曜日非依存の回帰担保は、同じ Step で `describe('updateStreaksByCourse')` に追加した土曜(2026-07-11)のテストが持つ。

786-814行目の `describe('getRequirementForCourse')` を、日付引数なしの次の内容に置き換える(平日/土日の2テストは1本に統合する):

```javascript
describe('getRequirementForCourse', () => {
  it('elementary は elementaryMissions を返す', () => {
    assert.strictEqual(
      getRequirementForCourse('elementary'),
      STREAK_REQUIREMENTS.elementaryMissions
    );
  });

  it('juniorHigh は juniorHighCourses を返す', () => {
    assert.strictEqual(
      getRequirementForCourse('juniorHigh'),
      STREAK_REQUIREMENTS.juniorHighCourses
    );
  });

  it('未知/未設定コースは elementary 扱い', () => {
    assert.strictEqual(
      getRequirementForCourse(undefined),
      STREAK_REQUIREMENTS.elementaryMissions
    );
  });
});
```

`describe('updateStreaksByCourse')`(816行目以降)の中に、土曜の回帰テストを追加する。既存の「コースごとに異なるしきい値で確定する」テストの直後に置く:

```javascript
  it('土曜でも中学生は3講座で学習成立(曜日別しきい値を持たない)', () => {
    // 2026-07-11 は土曜。曜日別しきい値時代は5講座必要だった日付
    const jhUser = { userName: '花子', course: 'juniorHigh', missionCount: 3, missions: [] };
    const { streakUsers } = updateStreaksByCourse({}, [jhUser], '2026-07-11');
    assert.strictEqual(streakUsers['花子'].streak, 1, '土曜でも3講座で+1される');
  });
```

同じ describe 内の既存コメント・テスト名にある曜日の言及を修正する。818行目のコメント `// 小学生: 4ミッションで学習成立 / 中学生(月曜): 3講座で学習成立` から `(月曜)` を削除し、831行目のテスト名 `'中学生の平日しきい値未満(2講座)は学習不成立'` を `'中学生のしきい値未満(2講座)は学習不成立'` に変更する。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: FAIL。3種類の失敗が出る
- `STREAK_REQUIREMENTS`: `juniorHighCourses` がオブジェクトのため `Number.isInteger` / `typeof === 'number'` が false
- `getRequirementForCourse`: `juniorHigh` の期待値がオブジェクトとの比較になり不一致
- `updateStreaksByCourse`: 土曜は5講座要件のため 3講座では `streak` が 0 のまま(期待は 1)

- [ ] **Step 3: `src/streak.js` を実装する**

30-50行目(定数定義と `getJuniorHighRequirement` 関数)を、次の定数定義だけに置き換える(関数とその JSDoc は削除):

```javascript
// ストリーク更新(カウント+1)に必要な完了数。変更時はここだけ書き換える
const STREAK_REQUIREMENTS = {
  elementaryMissions: 4, // 小学生コース: 完了ミッション数(夜通知が使用)
  juniorHighCourses: 3   // 中学生コース: 完了講座数(朝通知が使用)。曜日によらず一律
};
```

274-284行目の `getRequirementForCourse` を JSDoc ごと次に置き換える:

```javascript
/**
 * コースのしきい値(ストリーク成立に必要な完了数)を返す(純粋関数)
 * @param {'elementary'|'juniorHigh'|undefined} course
 * @returns {number}
 */
function getRequirementForCourse(course) {
  return course === 'juniorHigh'
    ? STREAK_REQUIREMENTS.juniorHighCourses
    : STREAK_REQUIREMENTS.elementaryMissions;
}
```

303行目の呼び出しから日付引数を外す:

```javascript
    const threshold = getRequirementForCourse(course);
```

`module.exports`(423-438行目)から `getJuniorHighRequirement,` の行を削除する。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: PASS(全テスト green)

- [ ] **Step 5: 呼び出し側を追随させる**

`src/index.js` の9行目の import から `getTargetDates` を外す(Step 5 の後半で唯一の使用箇所が消えるため):

```javascript
const { getAllUsersDetailedData, getAllUsersMissionCounts, getUserList } = require('./crawler');
```

248-255行目の達成判定から `todayDateString` を削除する:

```javascript
    let hasUnqualifiedUser = false;
    currentData.forEach(user => {
      const threshold = getRequirementForCourse(user.course);
      if (!isStudied(user, { minCompletedMissions: threshold })) {
        hasUnqualifiedUser = true;
      }
    });
```

282-285行目の警告しきい値からも日付引数を外す:

```javascript
      missionWarningThresholds: {
        elementary: getRequirementForCourse('elementary'),
        juniorHigh: getRequirementForCourse('juniorHigh')
      }
```

`src/morning-index.js` の13-20行目の import から `getJuniorHighRequirement` を削除する(`getTargetDates` は他で使うため残す):

```javascript
const {
  loadStreakData,
  saveStreakData,
  updateStreaksByCourse,
  formatStreakInfo,
  STREAK_REQUIREMENTS
} = require('./streak');
```

175-178行目の警告しきい値を定数の直接参照に変える:

```javascript
      missionWarningThresholds: {
        elementary: STREAK_REQUIREMENTS.elementaryMissions,
        juniorHigh: STREAK_REQUIREMENTS.juniorHighCourses
      }
```

`tests/index.test.js` の185行目のモックを新しい形にする(184行目の `getRequirementForCourse` モックは既に `(course) => ...` のシグネチャのため変更しない):

```javascript
        STREAK_REQUIREMENTS: overrides.STREAK_REQUIREMENTS || { elementaryMissions: 4, juniorHighCourses: 3 }
```

- [ ] **Step 6: 全テストと lint を実行する**

Run: `npm test`
Expected: PASS(全ファイル green)

Run: `npm run lint`
Expected: 警告・エラーなしで終了。`src/index.js` に未使用の `getTargetDates` や `todayDateString` が残っていると `no-unused-vars` でエラーになるので、その場合は Step 5 の削除漏れを直す

Run: `grep -rn "getJuniorHighRequirement" src/ tests/ scripts/`
Expected: 出力なし(該当なしで終了コード1)

- [ ] **Step 7: コミットする**

```bash
git add src/streak.js src/index.js src/morning-index.js tests/streak.test.js tests/index.test.js
git commit -m "feat: 中学生コースのしきい値を曜日によらず一律3件にする"
```

---

### Task 2: ドキュメントの追随

**Files:**
- Modify: `CLAUDE.md:47`(ストリーク機能の説明行)

**Interfaces:**
- Consumes: Task 1 の `STREAK_REQUIREMENTS.juniorHighCourses: 3` と `getJuniorHighRequirement` の削除
- Produces: なし(ドキュメントのみ)

- [ ] **Step 1: CLAUDE.md のしきい値の記述を更新する**

47行目の長い箇条書きのうち、次の3箇所だけを書き換える。他の記述(ボーナス・おたすけ・コース単価など)には触れない。

変更前(該当部分の抜粋):

```text
**小学生コースは学習4件以上、中学生コースは平日3件・土日5件以上の完了講座**が必須（判定対象日の曜日で決まる。祝日は曜日のみで判定）。
```

変更後:

```text
**小学生コースは学習4件以上、中学生コースは3件以上の完了講座**が必須。
```

同じ行の次の一文を削除する(前後の句点はつながるように整える):

```text
中学生の曜日別しきい値は `getJuniorHighRequirement(dateString)` で取得する。
```

`閾値は STREAK_REQUIREMENTS（src/streak.js）に集約されており、変更時はここだけ書き換える。` の一文は残す。

- [ ] **Step 2: 古い記述が残っていないか確認する**

Run: `grep -n "土日5\|曜日別\|getJuniorHighRequirement" CLAUDE.md`
Expected: 出力なし(該当なしで終了コード1)

`docs/superpowers/plans/` と `docs/superpowers/specs/` の過去ドキュメントは当時の記録なので変更しない。

- [ ] **Step 3: 全テストと lint を再実行する**

Run: `npm test`
Expected: PASS

Run: `npm run lint`
Expected: 警告・エラーなし

- [ ] **Step 4: コミットする**

```bash
git add CLAUDE.md
git commit -m "docs: 中学生コースのしきい値一律3件化をCLAUDE.mdに反映する"
```
