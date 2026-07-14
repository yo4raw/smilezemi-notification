# 夜通知・朝通知の両コース対応 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 夜通知(`index.js`)・朝通知(`morning-index.js`)の両方が小学生コースと中学生コースの両方を扱うようにし、ストリーク確定は朝通知に一本化する。

**Architecture:** クロールデータに `course` フィールドを追加し、コース別のしきい値(小学生=4 / 中学生=平日3・土日5)をストリーク判定・警告表示に適用する。夜通知は当日の両コースを速報(暫定表示のみ・確定/保存なし)、朝通知は前日の両コースを確定(唯一の確定点)。

**Tech Stack:** Node.js (CommonJS), Playwright, Node.js built-in test runner (`node --test`)

## Global Constraints

- Module System: CommonJS (`require`/`module.exports`)
- テスト実行: `node --test`。単一ファイルは `node --test --test-force-exit --experimental-test-isolation=none tests/<file>.test.js`
- I/O関数は `{success, data?/error?}` を返す。純粋関数は値を直接返す
- プロジェクトに書く Markdown は全て日本語
- しきい値の定義元は `src/streak.js` の `STREAK_REQUIREMENTS`。数値の直書き禁止、必ずここを参照する
- コミットは feature ブランチ `feature/both-courses-both-notifications` 上で行う(既に作成済み)
- コミットメッセージ末尾に付与: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: streak.js にコース別ヘルパーを追加

`getRequirementForCourse`(コース別しきい値の解決)と `updateStreaksByCourse`(コース別にバッチ分割して確定)を純粋関数として追加する。朝通知の確定と夜通知の暫定判定の両方で使う土台。

**Files:**
- Modify: `src/streak.js`(関数追加と `module.exports` への追加)
- Test: `tests/streak.test.js`(末尾に describe を追加)

**Interfaces:**
- Consumes: 既存の `getJuniorHighRequirement(dateString)`, `updateStreaks(streakUsers, users, dateString, options)`, `STREAK_REQUIREMENTS`
- Produces:
  - `getRequirementForCourse(course, dateString) → number` — `course === 'juniorHigh'` なら `getJuniorHighRequirement(dateString)`、それ以外は `STREAK_REQUIREMENTS.elementaryMissions`
  - `updateStreaksByCourse(streakUsers, users, dateString) → { streakUsers, results }` — `users` を `user.course`(未設定は `'elementary'` 扱い)で分割し、各コースの `getRequirementForCourse` を `minCompletedMissions` として `updateStreaks` を順に適用。`results` は全コース分を結合

- [ ] **Step 1: 失敗するテストを書く**

`tests/streak.test.js` の末尾(最後の `});` の前ではなくファイル最後)に追記する。ファイル冒頭の `require('../src/streak')` の分割代入に `getRequirementForCourse` と `updateStreaksByCourse` を追加すること。

```js
describe('getRequirementForCourse', () => {
  it('elementary は elementaryMissions を返す', () => {
    assert.strictEqual(
      getRequirementForCourse('elementary', '2026-07-13'),
      STREAK_REQUIREMENTS.elementaryMissions
    );
  });

  it('juniorHigh は平日しきい値を返す(2026-07-13は月曜)', () => {
    assert.strictEqual(
      getRequirementForCourse('juniorHigh', '2026-07-13'),
      STREAK_REQUIREMENTS.juniorHighCourses.weekday
    );
  });

  it('juniorHigh は土日しきい値を返す(2026-07-11は土曜)', () => {
    assert.strictEqual(
      getRequirementForCourse('juniorHigh', '2026-07-11'),
      STREAK_REQUIREMENTS.juniorHighCourses.weekend
    );
  });

  it('未知/未設定コースは elementary 扱い', () => {
    assert.strictEqual(
      getRequirementForCourse(undefined, '2026-07-13'),
      STREAK_REQUIREMENTS.elementaryMissions
    );
  });
});

describe('updateStreaksByCourse', () => {
  it('コースごとに異なるしきい値で確定する', () => {
    // 小学生: 4ミッションで学習成立 / 中学生(月曜): 3講座で学習成立
    const elemUser = { userName: '太郎 (小学生コース)', course: 'elementary', missionCount: 4, missions: [] };
    const jhUser = { userName: '花子 (中学生コース)', course: 'juniorHigh', missionCount: 3, missions: [] };

    const { streakUsers, results } = updateStreaksByCourse(
      {}, [elemUser, jhUser], '2026-07-13'
    );

    assert.strictEqual(streakUsers['太郎 (小学生コース)'].streak, 1, '小学生は4ミッションで+1');
    assert.strictEqual(streakUsers['花子 (中学生コース)'].streak, 1, '中学生は3講座で+1');
    assert.strictEqual(results.length, 2, '両コース分のresultが返る');
  });

  it('中学生の平日しきい値未満(2講座)は学習不成立', () => {
    const jhUser = { userName: '花子 (中学生コース)', course: 'juniorHigh', missionCount: 2, missions: [] };
    const { streakUsers } = updateStreaksByCourse({}, [jhUser], '2026-07-13');
    assert.strictEqual(streakUsers['花子 (中学生コース)'].streak, 0, '2講座では+1されない');
  });

  it('入力の streakUsers を破壊しない', () => {
    const input = {};
    const elemUser = { userName: '太郎 (小学生コース)', course: 'elementary', missionCount: 4, missions: [] };
    updateStreaksByCourse(input, [elemUser], '2026-07-13');
    assert.deepStrictEqual(input, {}, '入力マップは変更されない');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: FAIL(`getRequirementForCourse is not a function` / `updateStreaksByCourse is not a function`)

- [ ] **Step 3: 最小実装を書く**

`src/streak.js` の `updateStreaks` 関数定義の直後(`module.exports` の前)に追加:

```js
/**
 * コースのしきい値(ストリーク成立に必要な完了数)を返す(純粋関数)
 * @param {'elementary'|'juniorHigh'|undefined} course
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @returns {number}
 */
function getRequirementForCourse(course, dateString) {
  return course === 'juniorHigh'
    ? getJuniorHighRequirement(dateString)
    : STREAK_REQUIREMENTS.elementaryMissions;
}

/**
 * コース別にしきい値を切り替えて確定判定を適用する(純粋関数、入力は変更しない)
 * user.course で elementary / juniorHigh に分割し、それぞれのしきい値で updateStreaks を連鎖適用する
 *
 * @param {object} streakUsers - userName → state のマップ
 * @param {Array} users - 判定対象日のクロール済みユーザーデータ(course フィールド付き)
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @returns {{streakUsers: object, results: Array<{userName: string, state: object, event: string}>}}
 */
function updateStreaksByCourse(streakUsers, users, dateString) {
  let current = streakUsers;
  const results = [];

  for (const course of ['elementary', 'juniorHigh']) {
    const courseUsers = users.filter(user => (user.course || 'elementary') === course);
    if (courseUsers.length === 0) continue;

    const threshold = getRequirementForCourse(course, dateString);
    const updateResult = updateStreaks(current, courseUsers, dateString, {
      minCompletedMissions: threshold
    });
    current = updateResult.streakUsers;
    results.push(...updateResult.results);
  }

  return { streakUsers: current, results };
}
```

`module.exports` に2つを追加:

```js
module.exports = {
  createInitialState,
  isStudied,
  countCompletedMissions,
  confirmDay,
  STREAK_REQUIREMENTS,
  getJuniorHighRequirement,
  getRequirementForCourse,
  updateStreaks,
  updateStreaksByCourse,
  formatStreakInfo,
  settleBonuses,
  loadStreakData,
  saveStreakData
};
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: PASS(全ケース)

- [ ] **Step 5: コミット**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "$(cat <<'EOF'
feat: streakにコース別しきい値ヘルパーを追加

getRequirementForCourse と updateStreaksByCourse を追加。両通知の
両コース対応の土台。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: クロールデータに course フィールドを追加

`getCourseData` が返す各ユーザーデータに `course: 'elementary' | 'juniorHigh'` を付与する。コース別のストリーク確定・しきい値解決の土台。

**Files:**
- Modify: `src/crawler.js`(`getCourseData` 内、`isJuniorHighSchool` を利用)
- Test: `tests/crawler.test.js`(`describe('resolveTargetCourses', ...)` の後に describe を追加)

**Interfaces:**
- Consumes: 既存の `isJuniorHighSchool(courseName, page)`
- Produces: `getCourseData(...)` の返す `data` オブジェクトに `course` フィールド(`'elementary'` または `'juniorHigh'`)を追加

**Note:** `getCourseData` は `page` を多用するため直接の単体テストは行わず、course 導出ロジックの根拠となる `isJuniorHighSchool` の分岐をテストで固定する(course = juniorHigh ⇔ isJuniorHighSchool が true)。course フィールドの実データ確認は Task 5 完了後の DRY_RUN 検証で行う。

- [ ] **Step 1: 失敗するテストを書く**

`tests/crawler.test.js` の `describe('resolveTargetCourses', ...)` ブロックの直後に追記。ファイル冒頭で `const crawler = require('../src/crawler');` 相当が既にある前提(既存の `crawler.resolveTargetCourses` 呼び出しと同じ `crawler` を使う)。

```js
describe('isJuniorHighSchool (course 導出の根拠)', () => {
  it('コース名が中学生コースなら true', () => {
    assert.strictEqual(crawler.isJuniorHighSchool('中学生コース', null), true);
  });

  it('コース名が小学生コースなら false', () => {
    assert.strictEqual(crawler.isJuniorHighSchool('小学生コース', null), false);
  });

  it('コース名未指定でも URL が /study/c/ なら true', () => {
    const fakePage = { url: () => 'https://smile-zemi.jp/mimamoru-net/ui/study/c/timeline' };
    assert.strictEqual(crawler.isJuniorHighSchool(null, fakePage), true);
  });

  it('コース名未指定で URL が /study/s/ なら false', () => {
    const fakePage = { url: () => 'https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline' };
    assert.strictEqual(crawler.isJuniorHighSchool(null, fakePage), false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/crawler.test.js`
Expected: FAIL(`crawler.isJuniorHighSchool is not a function` — 現状 `isJuniorHighSchool` は未エクスポート)

- [ ] **Step 3: 実装する**

(3-1) `src/crawler.js` の `module.exports` に `isJuniorHighSchool` を追加(テスト用にエクスポート):

```js
module.exports = {
  getUserList,
  getMissionCount,
  getAllUsersMissionCounts,
  getAllUsersDetailedData,
  getStudyTime,
  getMissionDetails,
  getTotalScore,
  getTargetDates,
  resolveTargetCourses,
  shouldProcessSingleCourseUser,
  isJuniorHighSchool,
  switchToUser,
  checkCourseSelection,
  selectCourse,
  returnToCourseSelection
};
```

(3-2) `getCourseData` 内、`const displayName = ...` の直後に course を算出し、返却データに追加する。該当箇所(現状 `src/crawler.js` の返却部)を次のように変更:

```js
    // ユーザー名にコース名を追加（コース選択がある場合）
    const displayName = courseName ? `${userName} (${courseName})` : userName;

    // コース種別(小学生/中学生)を判定して付与する。
    // ストリーク確定・警告のしきい値をコース別に切り替えるために使う。
    const course = isJuniorHighSchool(courseName, page) ? 'juniorHigh' : 'elementary';

    const dataReliable = studyTimeResult.success && missionCountResult.success && missionsResult.success;

    // v2.0データ構造で返却
    return {
      success: true,
      data: {
        userName: displayName,
        course,
        missionCount,
        date: dateString,
        studyTime,
        totalScore,
        missions,
        dataReliable
      },
      detailsAvailable
    };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/crawler.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/crawler.js tests/crawler.test.js
git commit -m "$(cat <<'EOF'
feat: クロールデータにcourseフィールドを追加

getCourseData の返すデータに course('elementary'|'juniorHigh')を付与。
コース別のストリーク確定・警告しきい値の土台。isJuniorHighSchool を
テスト用にエクスポート。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: notifier のコース別しきい値対応

`formatDetailedMessage` にコース別しきい値オプション `missionWarningThresholds` を追加し、ユーザーの `course` フィールド(なければ名前サフィックス)でコース判定するようにする。既存の単一数値 `missionWarningThreshold` は後方互換で残す。

**Files:**
- Modify: `src/notifier.js`(`formatDetailedMessage`)
- Test: `tests/notifier.test.js`(`describe('formatDetailedMessage - ミッション未達警告 ...')` に追記)

**Interfaces:**
- Consumes: 各 `user` の `course` フィールド(Task 2 で付与)、`countCompletedMissions`(既存 import)
- Produces: `formatDetailedMessage(userData, missionChanges, options)` が `options.missionWarningThresholds = { elementary, juniorHigh }` を受け付ける。両方指定時は `missionWarningThresholds` を優先。course 判定は `user.course || (名前に'中学生コース'を含めば juniorHigh)`

- [ ] **Step 1: 失敗するテストを書く**

`tests/notifier.test.js` の `describe('formatDetailedMessage - ミッション未達警告 (missionWarningThreshold)', ...)` ブロックの末尾(最後の `it(...)` の後、その describe の閉じ `});` の直前)に追記:

```js
    it('missionWarningThresholds: courseフィールドで小学生に elementary 閾値を適用', () => {
      const user = {
        userName: '祥吾', course: 'elementary', missionCount: 3,
        date: '2026-07-13', studyTime: { hours: 1, minutes: 0 }, totalScore: 240,
        missions: [{ name: '算数', score: 80, completed: true }]
      };
      const message = notifier.formatDetailedMessage([user], null, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /⚠️ ミッション完了 3\/4個/, '小学生は elementary(4) 閾値・ミッション表記');
    });

    it('missionWarningThresholds: courseフィールドで中学生に juniorHigh 閾値を適用', () => {
      const user = {
        userName: '光志郎', course: 'juniorHigh', missionCount: 2,
        date: '2026-07-13', studyTime: { hours: 0, minutes: 30 }, totalScore: 150,
        missions: [{ name: '数学: 図形', score: 66, completed: true }]
      };
      const message = notifier.formatDetailedMessage([user], null, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /⚠️ 講座完了 2\/3個/, '中学生は juniorHigh(3) 閾値・講座表記');
    });

    it('missionWarningThresholds: 混在データを1メッセージでコース別に警告する', () => {
      const elem = {
        userName: '祥吾', course: 'elementary', missionCount: 3,
        date: '2026-07-13', studyTime: { hours: 1, minutes: 0 }, totalScore: 240,
        missions: [{ name: '算数', score: 80, completed: true }]
      };
      const jh = {
        userName: '光志郎', course: 'juniorHigh', missionCount: 2,
        date: '2026-07-13', studyTime: { hours: 0, minutes: 30 }, totalScore: 150,
        missions: [{ name: '数学: 図形', score: 66, completed: true }]
      };
      const message = notifier.formatDetailedMessage([elem, jh], null, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /ミッション完了 3\/4個/, '小学生の警告');
      assert.match(message, /講座完了 2\/3個/, '中学生の警告');
    });

    it('missionWarningThresholds は course 未設定時に名前サフィックスで判定する', () => {
      const jh = {
        userName: '光志郎 (中学生コース)', missionCount: 2,
        date: '2026-07-13', studyTime: { hours: 0, minutes: 30 }, totalScore: 150,
        missions: [{ name: '数学: 図形', score: 66, completed: true }]
      };
      const message = notifier.formatDetailedMessage([jh], null, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /⚠️ 講座完了 2\/3個/, 'サフィックスで中学生と判定');
    });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: FAIL(`missionWarningThresholds` 未対応のため警告行が出ない)

- [ ] **Step 3: 実装する**

`src/notifier.js` の `formatDetailedMessage` を3箇所変更する。

(3-1) オプション分割代入(現状の `const { dateLabel = null, ... } = options;` 行)を変更:

```js
  const {
    dateLabel = null,
    showNoStudyWarning = false,
    streaks = null,
    missionWarningThreshold = null,
    missionWarningThresholds = null
  } = options;
```

(3-2) ユーザーループ内のコース判定(現状 `const isJuniorHigh = user.userName.includes('中学生コース');` 行)を変更:

```js
    // コース種別: course フィールド優先、なければ名前サフィックスで判定
    const course = user.course || (user.userName.includes('中学生コース') ? 'juniorHigh' : 'elementary');
    const isJuniorHigh = course === 'juniorHigh';
    const scoreUnit = isJuniorHigh ? '%' : '点';
    const detailLabel = isJuniorHigh ? '学習詳細' : 'ミッション詳細';
```

(3-3) 警告行のしきい値解決(現状 `if (missionWarningThreshold && user.dataReliable !== false && ...)` ブロック)を変更:

```js
    // 完了数未達の警告。コース別しきい値(missionWarningThresholds)を優先し、
    // なければ単一の missionWarningThreshold を使う(後方互換)。
    const warnThreshold = missionWarningThresholds
      ? (isJuniorHigh ? missionWarningThresholds.juniorHigh : missionWarningThresholds.elementary)
      : missionWarningThreshold;

    if (warnThreshold && user.dataReliable !== false && !(showNoStudyWarning && isNoStudy)) {
      const completedCount = countCompletedMissions(user);
      if (completedCount < warnThreshold) {
        const unitLabel = isJuniorHigh ? '講座' : 'ミッション';
        message += `⚠️ ${unitLabel}完了 ${completedCount}/${warnThreshold}個 — ${warnThreshold}個完了しないと連続学習にカウントされないよ!\n`;
      }
    }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: PASS(新規4ケース + 既存の `missionWarningThreshold` 単数ケースも全て通ること)

- [ ] **Step 5: コミット**

```bash
git add src/notifier.js tests/notifier.test.js
git commit -m "$(cat <<'EOF'
feat: formatDetailedMessageにコース別しきい値を追加

missionWarningThresholds {elementary, juniorHigh} を追加し、course
フィールド(なければ名前サフィックス)でコース別に警告閾値を切替。単一
missionWarningThreshold は後方互換で維持。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 朝通知を両コース確定に変更

朝通知の前日クロールを両コース(`courseFilter: null`)にし、`updateStreaksByCourse` でコース別にストリークを確定。警告しきい値もコース別に渡す。

**Files:**
- Modify: `src/morning-index.js`
- Test: `tests/morning-index.test.js`(エクスポート確認は維持。ロジック検証は Task 1 の `updateStreaksByCourse` テストでカバー済み)

**Interfaces:**
- Consumes: `updateStreaksByCourse`(Task 1), `STREAK_REQUIREMENTS` / `getJuniorHighRequirement`(streak), course 付きクロールデータ(Task 2), `missionWarningThresholds`(Task 3)
- Produces: 前日・両コースの確定通知(唯一の確定点)

- [ ] **Step 1: import を更新**

`src/morning-index.js` の streak import 行を次に変更:

```js
const {
  loadStreakData,
  saveStreakData,
  updateStreaksByCourse,
  formatStreakInfo,
  getJuniorHighRequirement,
  STREAK_REQUIREMENTS
} = require('./streak');
```

- [ ] **Step 2: 前日クロールを両コースに変更**

`getAllUsersDetailedData` 呼び出しの `courseFilter` を変更(現状 `courseFilter: 'juniorHigh'`):

```js
    const crawlResult = await getAllUsersDetailedData(page, {
      courseFilter: null,
      dateOffset: -1
    });
```

併せて直前のログを実態に合わせる(現状 `前日(...)の中学生コースデータを取得しています...`):

```js
    console.log(`🔍 前日(${targetDates.withPadding})の両コースデータを取得しています...`);
```

- [ ] **Step 3: ストリーク確定をコース別バッチに変更**

現状の確定ブロック(`const requiredCourses = getJuniorHighRequirement(...)` から `updateStreaks(...)` と `results.forEach(...)` まで)を次で置き換える:

```js
    // 前日は確定データ。コース別しきい値で確定する(小学生4 / 中学生は前日曜日で3or5)
    const { streakUsers, results } = updateStreaksByCourse(
      previousStreakUsers,
      crawlResult.data,
      targetDates.dateString
    );

    streaks = {};
    results.forEach(result => {
      streaks[result.userName] = formatStreakInfo(result);
    });
```

- [ ] **Step 4: 警告しきい値をコース別に変更**

`formatDetailedMessage` 呼び出しの `missionWarningThreshold: requiredCourses` を `missionWarningThresholds` に変更:

```js
    let message = formatDetailedMessage(crawlResult.data, null, {
      dateLabel: `昨日(${targetDates.withPadding})`,
      showNoStudyWarning: true,
      streaks,
      missionWarningThresholds: {
        elementary: STREAK_REQUIREMENTS.elementaryMissions,
        juniorHigh: getJuniorHighRequirement(targetDates.dateString)
      }
    });
```

- [ ] **Step 5: エクスポートテストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/morning-index.test.js`
Expected: PASS(`main` 関数がエクスポートされていること)

- [ ] **Step 6: 全テストが通ることを確認**

Run: `npm test`
Expected: PASS(既存テストが壊れていないこと)

- [ ] **Step 7: 朝通知の DRY_RUN 検証**

Run: `DRY_RUN=true node -r dotenv/config src/morning-index.js`
Expected: プレビューに小学生コースと中学生コースの両方が前日分として表示され、各ユーザーにコース別しきい値でストリーク行が出ること。LINE送信・streak保存が行われないこと(ログに「ドライランモード」)。

> **Note:** `.env` に本番認証情報が必要。ローカルに無い場合はこのステップをスキップし、CI(手動 workflow_dispatch)で確認する旨を記録して次へ進む。

- [ ] **Step 8: コミット**

```bash
git add src/morning-index.js
git commit -m "$(cat <<'EOF'
feat: 朝通知を両コースの前日確定に変更

courseFilter を null(両コース)にし、updateStreaksByCourse でコース別
しきい値で確定。警告しきい値もコース別に。朝通知が唯一の確定点になる。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 夜通知を両コース速報(表示のみ)に変更

夜通知の当日クロールを両コース(`courseFilter: null`)にし、前日クロール・確定・保存を削除。ストリークは `streak_data.json` を読んで「確定値＋当日暫定+1」を表示するだけにする。

**Files:**
- Modify: `src/index.js`
- Test: `tests/index.test.js`(夜通知のストリーク関連テストを書き換え)

**Interfaces:**
- Consumes: `loadStreakData`, `createInitialState`, `isStudied`, `formatStreakInfo`, `getRequirementForCourse`(Task 1), course 付きクロールデータ(Task 2), `missionWarningThresholds`(Task 3), `getTargetDates`
- Produces: 当日・両コースの速報通知(確定・保存なし)

- [ ] **Step 1: 失敗するテストに書き換える**

`tests/index.test.js` を次のように変更する。

(1-1) `setupMocks` 内の `../src/streak` モック(現状 line 150-161 付近)を次に置き換える。`getRequirementForCourse` を追加し、`updateStreaks` は「呼ばれたら記録する」形にして呼ばれないことを検証可能にする:

```js
    require.cache[resolveModule('../src/streak')] = {
      id: resolveModule('../src/streak'), filename: resolveModule('../src/streak'), loaded: true,
      exports: {
        loadStreakData: overrides.loadStreakData || (async () => ({ success: true, data: {} })),
        saveStreakData: overrides.saveStreakData || (async () => {
          callLog.push({ type: 'saveStreakData' });
          return { success: true };
        }),
        updateStreaks: overrides.updateStreaks || (() => {
          callLog.push({ type: 'updateStreaks' });
          return { streakUsers: {}, results: [] };
        }),
        formatStreakInfo: overrides.formatStreakInfo || (() => 'テストストリーク情報'),
        isStudied: overrides.isStudied || (() => false),
        createInitialState: overrides.createInitialState || (() => ({ streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null })),
        getRequirementForCourse: overrides.getRequirementForCourse || ((course) => course === 'juniorHigh' ? 3 : 4),
        STREAK_REQUIREMENTS: overrides.STREAK_REQUIREMENTS || { elementaryMissions: 4, juniorHighCourses: { weekday: 3, weekend: 5 } }
      }
    };
```

(1-2) 既存テスト「正常系: 夜通知はストリーク判定・暫定表示・警告表示に5ミッション閾値を適用する」(現状 line 307)を、次のテスト群で**置き換える**:

```js
    it('正常系: 夜通知は確定処理(updateStreaks/saveStreakData)を行わない', async () => {
      await mainModule.main();

      const updateCalls = callLog.filter(c => c.type === 'updateStreaks');
      const saveStreakCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(updateCalls.length, 0, '夜通知はupdateStreaksを呼ばない');
      assert.strictEqual(saveStreakCalls.length, 0, '夜通知はsaveStreakDataを呼ばない');
    });

    it('正常系: 夜通知は当日学習判定にコース別しきい値を使い、警告閾値も渡す', async () => {
      let capturedIsStudiedOptions;
      let capturedFormatOptions;
      setupMocks({
        isStudied: (user, options) => { capturedIsStudiedOptions = options; return true; },
        getRequirementForCourse: (course) => course === 'juniorHigh' ? 3 : 4,
        formatDetailedMessage: (currentData, changes, options) => {
          capturedFormatOptions = options;
          return 'テスト詳細メッセージ';
        }
      });

      await mainModule.main();

      // デフォルトの太郎は course 未設定 → elementary 扱い → 4
      assert.deepStrictEqual(
        capturedIsStudiedOptions,
        { minCompletedMissions: 4 },
        '当日暫定判定に elementary しきい値(4)が渡ること'
      );
      assert.ok(capturedFormatOptions.missionWarningThresholds, 'missionWarningThresholds が渡ること');
      assert.strictEqual(capturedFormatOptions.missionWarningThresholds.elementary, 4);
      assert.strictEqual(capturedFormatOptions.missionWarningThresholds.juniorHigh, 3);
    });
```

(1-3) 「ストリーク統合」describe 内の既存テスト「正常系: 前日分クロールが courseFilter:elementary, dateOffset:-1 で呼ばれる」(現状 line 410)を、次で**置き換える**:

```js
    it('正常系: 当日クロールが courseFilter:null で1回だけ呼ばれる(前日クロールしない)', async () => {
      const detailedCalls = [];
      setupMocks({
        getAllUsersDetailedData: async (page, options) => {
          detailedCalls.push(options);
          return {
            success: true,
            data: [{ userName: '太郎', course: 'elementary', missionCount: 5, date: '2025-12-25', studyTime: { hours: 1, minutes: 30 }, missions: [], totalScore: 100 }],
            detailsAvailable: true,
            partialFailure: false
          };
        }
      });

      await mainModule.main();

      assert.strictEqual(detailedCalls.length, 1, 'getAllUsersDetailedData は当日分の1回だけ');
      assert.deepStrictEqual(detailedCalls[0], { courseFilter: null }, '両コース(null)で当日分を取得すること');
    });
```

(1-4) 「ストリーク統合」describe 内の既存テスト「異常系: 前日分クロール失敗時、saveStreakDataが呼ばれず通知処理は継続する」(現状 line 434)を**削除**する(夜通知に前日クロールが無くなるため該当シナリオが消滅)。

(1-5) 「ストリーク統合」describe 内の既存テスト「異常系: loadStreakData失敗時、errorsに記録されるが空状態で続行し自己修復する」(現状 line 465)を、次で**置き換える**(夜通知は保存しないため自己修復ではなく「表示のみ続行」):

```js
    it('異常系: loadStreakData失敗時、errorsに記録し保存せず表示のみで続行する', async () => {
      let capturedFormatOptions;
      setupMocks({
        loadStreakData: async () => ({ success: false, error: 'ストリークデータ読み込み失敗' }),
        formatDetailedMessage: (currentData, changes, options) => {
          capturedFormatOptions = options;
          return 'テスト詳細メッセージ';
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1, 'loadStreakData失敗時は終了コード1');
      assert.strictEqual(result.errors.includes('ストリークデータ読み込み失敗'), true, 'errorsに記録されること');

      const saveStreakCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveStreakCalls.length, 0, '夜通知は保存しないこと');

      const pushCalls = callLog.filter(c => c.type === 'sendPushMessage');
      assert.strictEqual(pushCalls.length, 1, '通知は送信されること');
      assert.ok(capturedFormatOptions.streaks, 'streaksマップは渡されること(空状態ベース)');
    });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`
Expected: FAIL(現状の `index.js` は前日クロール・updateStreaks・saveStreakData を行うため、上記の新テストが失敗する)

- [ ] **Step 3: index.js を実装変更する**

(3-1) import を変更。streak の分割代入(現状 line 12)を次に変更(`updateStreaks`/`STREAK_REQUIREMENTS` を外し `getRequirementForCourse` を追加):

```js
const { loadStreakData, formatStreakInfo, isStudied, createInitialState, getRequirementForCourse } = require('./streak');
```

(3-2) 定数 `REQUIRED_MISSIONS_FOR_STREAK`(現状 line 16-17)を**削除**する。

(3-3) ストリーク確定ブロック全体(現状「6.5 ストリーク...」コメントから、前日クロール・`updateStreaks`・`saveStreakData`・`streaks` 構築の `currentData.forEach(...)` まで、すなわち `let streaks = null;` から通知用 `streaks` 構築の終わりまで)を、次の「読み取り＋暫定表示」ブロックで置き換える:

```js
    // 6.5 ストリーク(連続学習日数)の表示
    // 夜通知は速報のため確定・保存はしない(確定は翌朝の朝通知が前日分で行う)。
    // streak_data.json の確定値を読み、当日すでにしきい値達成なら暫定+1して表示する。
    let streaks = null;
    console.log('🔥 ストリーク情報を読み込んでいます...');
    const streakLoadResult = await loadStreakData();

    let streakUsers;
    if (streakLoadResult.success) {
      streakUsers = streakLoadResult.data;
    } else {
      // 読み込み失敗はエラー記録しつつ空状態で表示を続行する(確定は朝が担うため保存はしない)
      console.error('❌ ストリークデータの読み込みに失敗しました:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
      console.warn('⚠️ ストリークデータを初期化して表示します');
      streakUsers = {};
    }

    const todayDateString = getTargetDates(0).dateString;
    streaks = {};
    currentData.forEach(user => {
      const state = streakUsers[user.userName] || createInitialState();
      const threshold = getRequirementForCourse(user.course, todayDateString);
      const todayStudied = isStudied(user, { minCompletedMissions: threshold });
      streaks[user.userName] = formatStreakInfo({ state, event: 'none' }, { todayStudied });
    });
```

(3-4) 当日クロールの `courseFilter` を変更(現状 line 126 `courseFilter: 'elementary'`)。併せて直前コメントも実態に更新:

```js
    // 両コース(小学生・中学生)の当日分を速報として取得する。
    // ストリーク確定は翌朝の朝通知が前日分で行うため、ここでは確定しない。
    console.log('🔍 詳細データを取得しています...');
    const crawlResult = await getAllUsersDetailedData(page, { courseFilter: null });
```

(3-5) 0件ガードのメッセージ(現状 line 220-222)を一般化:

```js
    // 対象ユーザーが0件の場合は通知せず正常終了
    if (currentData.length === 0) {
      console.log('ℹ️ 対象ユーザーがいないため、通知をスキップして終了します');
      return { success: true, exitCode: 0 };
    }
```

(3-6) `formatDetailedMessage` 呼び出しのオプション(現状 line 322-325)を変更:

```js
    let message = formatDetailedMessage(currentData, missionChangesResult, {
      streaks,
      missionWarningThresholds: {
        elementary: getRequirementForCourse('elementary', todayDateString),
        juniorHigh: getRequirementForCourse('juniorHigh', todayDateString)
      }
    });
```

(3-7) 詳細モードのドライラン分岐(現状 line 331-342)は変更不要だが、直前に `saveStreakData` が無くなったことを確認する。ドライランのメッセージプレビューはそのまま。

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`
Expected: PASS(書き換えた新テスト + 既存の正常系/異常系/ドライラン/終了コードテストが全て通ること)

- [ ] **Step 5: 全テストが通ることを確認**

Run: `npm test`
Expected: PASS(全ファイル)

- [ ] **Step 6: 夜通知の DRY_RUN 検証**

Run: `DRY_RUN=true node -r dotenv/config src/index.js`
Expected: プレビューに小学生コースと中学生コースの両方が当日分として表示され、ストリークは確定値＋暫定表示になること。各ユーザーの `course` に応じてスコア単位(%/点)と警告(講座/ミッション)が正しいこと。LINE送信・データ/streak保存が行われないこと。

> **Note:** `.env` が無い場合は CI(手動 workflow_dispatch)で確認する旨を記録してスキップ。

- [ ] **Step 7: コミット**

```bash
git add src/index.js tests/index.test.js
git commit -m "$(cat <<'EOF'
feat: 夜通知を両コース速報(表示のみ)に変更

当日クロールを両コース(null)にし、前日クロール・updateStreaks・
saveStreakData を削除。ストリークは確定値の読み取り＋当日暫定表示のみ。
確定は翌朝の朝通知に一本化。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: ワークフローとドキュメントの更新

処理コマンドは不変のため機能変更はない。名称・コメント・`CLAUDE.md` を実態に合わせる。

**Files:**
- Modify: `.github/workflows/crawler.yml`(コメント)
- Modify: `.github/workflows/morning-crawler.yml`(`name` とコメント)
- Modify: `CLAUDE.md`(エントリポイントとストリーク仕様の記述)

- [ ] **Step 1: morning-crawler.yml の name を更新**

現状 `name: スマイルゼミ 朝通知(中学生コース・前日分)` を変更:

```yaml
name: スマイルゼミ 朝通知(両コース・前日分)
```

- [ ] **Step 2: crawler.yml のコメントを更新**

`crawler.yml` の該当コメント(現状「小学生コースの...」等、対象コースに言及している箇所があれば)を「両コース(小学生・中学生)の当日速報」に更新する。無ければワークフロー冒頭付近に対象を明記するコメントを追加する。

- [ ] **Step 3: CLAUDE.md を更新**

`## Architecture Overview` の「Four Entry Points」1・2番の記述を実態に合わせて書き換える:

- 1番(日次通知): 「小学生コースの...」→「**両コース(小学生・中学生)の当日分**を速報通知。ストリークは確定値＋当日暫定+1を表示するのみで確定・保存はしない」
- 2番(朝通知): 「中学生コースの...」→「**両コース(小学生・中学生)の前日確定分**を通知。前日は確定データのためストリークを確定する(唯一の確定点)」

`### ストリーク（連続学習日数）機能` の該当記述を更新:

- 「小学生コースは夜通知が使用/中学生コースは朝通知が使用」→「しきい値はコース別(小学生=完了ミッション4個 / 中学生=完了講座 平日3・土日5)。**ストリーク確定は朝通知が両コースまとめて前日分で行う(唯一の確定点)**。夜通知は速報で、確定値＋当日暫定+1を表示するのみ」
- 前日確定に関する既存記述(夜通知が前日を追加クロールして確定、の箇所)を「夜は確定しない/朝が確定」に整合させる

- [ ] **Step 4: 全テストが通ることを確認(リグレッション)**

Run: `npm test`
Expected: PASS(全ファイル)

- [ ] **Step 5: コミット**

```bash
git add .github/workflows/crawler.yml .github/workflows/morning-crawler.yml CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: 両コース対応に合わせてワークフロー名とCLAUDE.mdを更新

朝通知の name を「両コース・前日分」に。CLAUDE.md のエントリポイントと
ストリーク仕様を「夜=速報/朝=確定・両通知が両コース」に更新。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 完了確認

- [ ] `npm test` が全て通る
- [ ] `DRY_RUN=true node -r dotenv/config src/index.js` で当日・両コースが速報表示される(暫定ストリーク・確定/保存なし)
- [ ] `DRY_RUN=true node -r dotenv/config src/morning-index.js` で前日・両コースが確定表示される
- [ ] `CLAUDE.md` が実態と一致している
