# 夜通知の簡素化と未達警告の強調 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 夜通知からストリーク行と勉強時間行を削除し、未達警告行を目立つ文言に変える（朝通知は過去形の文言にする）。

**Architecture:** `src/notifier.js` の `formatDetailedMessage()` にオプションを2つ（`showStudyTime` / `missionWarningStyle`）追加し、夜通知（`src/index.js`）と朝通知（`src/morning-index.js`）が出し分ける。夜通知はストリーク行を出さなくなるため `streak_data.json` の読み込みごと削除する。

**Tech Stack:** Node.js 24 / CommonJS / Node.js built-in test runner（`node --test`）/ oxlint

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-08-04-night-notification-simplification-design.md`
- LINE と Discord の両方にプレーンテキストで届くため、マークダウン記法（`**太字**` 等）は使わない
- 単一テストファイルの実行には `--test-force-exit --experimental-test-isolation=none` の2オプションが必須
- Markdown・コメント・コミットメッセージはすべて日本語で書く
- 作業ブランチは `feature/night-notification-simplification`（作成済み）
- 通知文面に子どもの実名を書かない（テストfixtureは たろう/はなこ/じろう を使う）

## File Structure

| ファイル | 役割 | 変更 |
| --- | --- | --- |
| `src/notifier.js` | 通知メッセージの整形 | オプション2つ追加、警告文言テーブル追加 |
| `src/index.js` | 夜通知のオーケストレーション | ストリーク読み込み削除、呼び出し引数変更 |
| `src/morning-index.js` | 朝通知のオーケストレーション | `missionWarningStyle: 'past'` を追加 |
| `tests/notifier.test.js` | 整形のテスト | 新オプションのテスト追加、既存アサーション更新 |
| `tests/index.test.js` | 夜通知のテスト | ストリーク非使用の検証に変更 |
| `CLAUDE.md` | プロジェクト説明 | 夜通知・警告行の記述を更新 |

---

### Task 1: 勉強時間行の表示切り替え（`showStudyTime`）

**Files:**
- Modify: `src/notifier.js:302-309`（オプション destructure）, `src/notifier.js:344-347`（勉強時間行）, `src/notifier.js:294-301`（JSDoc）
- Test: `tests/notifier.test.js`（`formatDetailedMessage - 朝通知オプション` describe の直後、738行付近に新規 describe を追加）

**Interfaces:**
- Produces: `formatDetailedMessage(userData, missionChanges, options)` の `options.showStudyTime`（boolean、既定 `true`）。`false` のとき `⏱️ 勉強時間: HH:MM` 行を出力しない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/notifier.test.js` の `describe('formatDetailedMessage - ストリーク表示', ...)` の直前（739行付近）に、次の describe を丸ごと挿入する。

```javascript
  describe('formatDetailedMessage - 勉強時間の表示切り替え', () => {
    const { formatDetailedMessage } = require('../src/notifier');

    const userData = [{
      userName: 'たろう (小学生コース)',
      course: 'elementary',
      studyItemCount: 4,
      missionCount: 0,
      date: '2026-08-03',
      studyTime: { hours: 0, minutes: 13 },
      totalScore: 202,
      missions: [{ name: '国語テスト(2年生：夏)', score: 20, completed: true }]
    }];

    it('showStudyTime: false で勉強時間行を出さない', () => {
      const message = formatDetailedMessage(userData, null, { showStudyTime: false });
      assert.ok(!message.includes('勉強時間'), message);
      assert.ok(message.includes('✅ 学習4件'), '学習件数行は残ること');
    });

    it('showStudyTime 省略時は従来どおり勉強時間行を出す', () => {
      const message = formatDetailedMessage(userData, null, {});
      assert.ok(message.includes('⏱️ 勉強時間: 00:13'), message);
    });

    it('showStudyTime: false でも朝通知の完全未学習判定は勉強時間を見る', () => {
      const noStudy = [{
        userName: 'はなこ (小学生コース)',
        course: 'elementary',
        studyItemCount: 0,
        missionCount: 0,
        date: '2026-08-03',
        studyTime: { hours: 0, minutes: 0 },
        totalScore: 0,
        missions: []
      }];
      const message = formatDetailedMessage(noStudy, null, {
        showStudyTime: false,
        showNoStudyWarning: true
      });
      assert.ok(message.includes('⚠️ 昨日は学習していません'), message);
    });
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`

Expected: FAIL。`showStudyTime: false で勉強時間行を出さない` が `message.includes('勉強時間')` で落ちる（オプションが未実装のため勉強時間行が出る）。他2件は PASS でよい。

- [ ] **Step 3: `showStudyTime` を実装する**

`src/notifier.js` の destructure（302-309行）に `showStudyTime = true` を追加する。

```javascript
function formatDetailedMessage(userData, missionChanges = null, options = {}) {
  const {
    dateLabel = null,
    showNoStudyWarning = false,
    showStudyTime = true,
    streaks = null,
    missionWarningThreshold = null,
    missionWarningThresholds = null
  } = options;
```

344-347行の勉強時間行を条件付きにする。`hours` / `minutes` は後段の完全未学習判定（`isNoStudy`）でも使うため、定数の宣言は残して出力だけを囲む。

```javascript
    // 勉強時間(夜通知は翌朝の確定通知でカバーするため出さない)
    const hours = user.studyTime?.hours ?? 0;
    const minutes = user.studyTime?.minutes ?? 0;
    if (showStudyTime) {
      message += `⏱️ 勉強時間: ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}\n`;
    }
```

JSDoc（294-301行）の `@returns` の直前に次の行を足す。

```javascript
 * @param {object} [options] - 表示オプション
 * @param {boolean} [options.showStudyTime=true] - 勉強時間行を表示するか(夜通知は false)
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`

Expected: PASS（既存テストを含め全件）

- [ ] **Step 5: コミットする**

```bash
git add src/notifier.js tests/notifier.test.js
git commit -m "feat: 勉強時間行の表示をshowStudyTimeオプションで切り替える"
```

---

### Task 2: 未達警告の文言を `missionWarningStyle` で切り替える

**Files:**
- Modify: `src/notifier.js:15-17`付近（定数追加）, `src/notifier.js:302-309`（destructure）, `src/notifier.js:378-383`（警告行）, `src/notifier.js:294-301`（JSDoc）
- Modify: `src/morning-index.js:170-178`
- Test: `tests/notifier.test.js:529-678`（既存アサーションの更新）, `tests/notifier.test.js:954-991`（既存アサーションの更新）

**Interfaces:**
- Consumes: Task 1 で追加した `options.showStudyTime`
- Produces: `options.missionWarningStyle`（`'today'` / `'past'`、既定 `'past'`）。
  - `'today'` → `🚨🚨 あと${remaining}件! がんばろう! 🚨🚨`
  - `'past'` → `😢😢 あと${remaining}件たりなかった… 😢😢`
  - `remaining` は `しきい値 - 学習件数`。コース（小学生／中学生）で文言は変わらない。

- [ ] **Step 1: 失敗するテストを書く（既存アサーションの更新）**

`tests/notifier.test.js` の既存テストを次のとおり書き換える。旧文言（`⚠️ ○○完了 n/m件` と `連続学習にカウントされないよ`）を検証している箇所がすべて対象。

543-548行を差し替える。

```javascript
    it('完了ミッションが閾値未満なら警告行が表示される(today)', () => {
      const message = notifier.formatDetailedMessage([baseUser], null, {
        missionWarningThreshold: 5,
        missionWarningStyle: 'today'
      });

      assert.match(message, /🚨🚨 あと2件! がんばろう! 🚨🚨/, '残り件数つきの励まし文言が出ること');
    });

    it('missionWarningStyle: past は過去形の文言になる', () => {
      const message = notifier.formatDetailedMessage([baseUser], null, {
        missionWarningThreshold: 5,
        missionWarningStyle: 'past'
      });

      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, '過去形の文言が出ること');
    });

    it('missionWarningStyle 省略時は past 扱いになる', () => {
      const message = notifier.formatDetailedMessage([baseUser], null, { missionWarningThreshold: 5 });

      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, '既定は past であること');
    });
```

550-568行の「警告行が含まれないこと」を検証する3件は、正規表現を新文言に合わせる。`assert.doesNotMatch(message, /学習完了 \d+\/\d+件/, '警告行が含まれないこと');` の3箇所（554行・560行・567行）をすべて次に置き換える。

```javascript
      assert.doesNotMatch(message, /あと\d+件/, '警告行が含まれないこと');
```

570-587行の「中学生コースのユーザーには『講座完了』表記で警告する」テストは、コース別表記がなくなったため、次のテストに丸ごと差し替える。

```javascript
    it('警告文言はコースが違っても同一になる', () => {
      const juniorUser = {
        userName: 'たろう (中学生コース)',
        course: 'juniorHigh',
        missionCount: 2,
        date: '2026-07-13',
        studyTime: { hours: 0, minutes: 30 },
        totalScore: 150,
        missions: [
          { name: '数学: いろいろな図形', score: 66, completed: true },
          { name: '英語: 不定詞', score: 80, completed: true }
        ]
      };
      const message = notifier.formatDetailedMessage([juniorUser], null, {
        missionWarningThreshold: 4,
        missionWarningStyle: 'today'
      });

      assert.match(message, /🚨🚨 あと2件! がんばろう! 🚨🚨/, '小学生と同じ文言になること');
      assert.doesNotMatch(message, /講座完了/, '旧表記が残っていないこと');
      assert.doesNotMatch(message, /連続学習/, '「連続学習」への言及が消えていること');
    });
```

604行を置き換える。

```javascript
      assert.doesNotMatch(message, /あと\d+件/, '閾値警告が重複しないこと');
```

621行を置き換える。partialUser は `missionCount: 1`・閾値4なので残り3件。

```javascript
      assert.match(message, /😢😢 あと3件たりなかった… 😢😢/, '閾値警告が表示されること');
```

634行を置き換える。`missionCount: 3`・elementary 閾値4なので残り1件。

```javascript
      assert.match(message, /😢😢 あと1件たりなかった… 😢😢/, '小学生は elementary(4) 閾値が使われること');
```

646行を置き換える。`missionCount: 2`・juniorHigh 閾値3なので残り1件。

```javascript
      assert.match(message, /😢😢 あと1件たりなかった… 😢😢/, '中学生は juniorHigh(3) 閾値が使われること');
```

649-665行の混在テストは、文言が同一になって2人を区別できないため、中学生側の `missionCount` を 1 に変えて残り件数で区別する。テスト全体を次に差し替える。

```javascript
    it('missionWarningThresholds: 混在データを1メッセージでコース別に警告する', () => {
      const elem = {
        userName: 'じろう', course: 'elementary', missionCount: 3,
        date: '2026-07-13', studyTime: { hours: 1, minutes: 0 }, totalScore: 240,
        missions: [{ name: '算数', score: 80, completed: true }]
      };
      const jh = {
        userName: 'たろう', course: 'juniorHigh', missionCount: 1,
        date: '2026-07-13', studyTime: { hours: 0, minutes: 30 }, totalScore: 150,
        missions: [{ name: '数学: 図形', score: 66, completed: true }]
      };
      const message = notifier.formatDetailedMessage([elem, jh], null, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /😢😢 あと1件たりなかった… 😢😢/, '小学生の警告(4-3=1件)');
      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, '中学生の警告(3-1=2件)');
    });
```

676行を置き換える。`missionCount: 2`・juniorHigh 閾値3なので残り1件。

```javascript
      assert.match(message, /😢😢 あと1件たりなかった… 😢😢/, 'サフィックスで中学生と判定');
```

954-972行の「小学生コースの未達警告は『学習』表記になる」テストは、`it` の名前と2つのアサーションを差し替える。`studyItemCount: 2`・閾値4なので残り2件。

```javascript
    it('小学生コースの未達警告に残り件数が出る', () => {
```

```javascript
      assert.ok(message.includes('😢😢 あと2件たりなかった… 😢😢'), message);
```

（971行の `4件完了しないと連続学習にカウントされないよ!` を検証する行は削除する）

974-991行の「中学生コースの未達警告は『講座』表記のまま」テストも、`it` の名前と990行のアサーションを差し替える。`studyItemCount: 1`・閾値3なので残り2件。

```javascript
    it('中学生コースの未達警告にも残り件数が出る', () => {
```

```javascript
      assert.ok(message.includes('😢😢 あと2件たりなかった… 😢😢'), message);
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`

Expected: FAIL。書き換えた警告文言のアサーションが軒並み落ちる（旧文言 `⚠️ 学習完了 3/5件 — …` のまま出力されるため）。

- [ ] **Step 3: 文言テーブルとオプションを実装する**

`src/notifier.js` の `MAX_LISTED_COURSES`（17行）の直後に文言テーブルを追加する。

```javascript
// 学習件数がしきい値に届かないときに出す警告文言。
// 夜通知(today)は当日中に挽回できるため励まし、朝通知(past)は前日確定の結果報告なので過去形にする。
// 残り件数だけを出すため、コース別の単位ラベル(学習/講座)は使わない。
const MISSION_WARNING_STYLES = {
  today: remaining => `🚨🚨 あと${remaining}件! がんばろう! 🚨🚨`,
  past: remaining => `😢😢 あと${remaining}件たりなかった… 😢😢`
};
```

destructure に `missionWarningStyle = 'past'` を追加する（Task 1 で追加した `showStudyTime` の下）。

```javascript
    showStudyTime = true,
    streaks = null,
    missionWarningThreshold = null,
    missionWarningThresholds = null,
    missionWarningStyle = 'past'
  } = options;
```

378-383行の警告行を差し替える。

```javascript
    if (warnThreshold && user.dataReliable !== false && !(showNoStudyWarning && isNoStudy)) {
      const completedCount = countStudyItems(user);
      if (completedCount < warnThreshold) {
        const formatWarning = MISSION_WARNING_STYLES[missionWarningStyle] || MISSION_WARNING_STYLES.past;
        message += `${formatWarning(warnThreshold - completedCount)}\n`;
      }
    }
```

JSDoc に次の行を足す（Task 1 で足した `showStudyTime` の下）。

```javascript
 * @param {'today'|'past'} [options.missionWarningStyle='past'] - 未達警告の文言(夜通知は 'today')
```

- [ ] **Step 4: 朝通知に `missionWarningStyle: 'past'` を渡す**

`src/morning-index.js:174-177` の `formatDetailedMessage()` 呼び出しにオプションを1つ足す。

```javascript
    const message = formatDetailedMessage(crawlResult.data, null, {
      dateLabel: `昨日(${targetDates.withPadding})`,
      showNoStudyWarning: true,
      streaks,
      missionWarningStyle: 'past',
      missionWarningThresholds: {
        elementary: STREAK_REQUIREMENTS.elementaryMissions,
        juniorHigh: getJuniorHighRequirement(targetDates.dateString)
      }
    });
```

- [ ] **Step 5: テストと lint を実行して通ることを確認する**

Run: `npm test`
Expected: `tests/notifier.test.js` は全件 PASS。`tests/index.test.js` はこの時点では PASS（夜通知はまだ旧仕様のまま）。

Run: `npm run lint`
Expected: エラーなし（`unitLabel` は学習件数行でまだ使われているため未使用にはならない）

- [ ] **Step 6: コミットする**

```bash
git add src/notifier.js src/morning-index.js tests/notifier.test.js
git commit -m "feat: 未達警告の文言を目立たせ夜と朝で出し分ける"
```

---

### Task 3: 夜通知からストリーク行・勉強時間行を外す

**Files:**
- Modify: `src/index.js:13`（require）, `src/index.js:245-274`（ストリーク読み込みブロック）, `src/index.js:297-303`（`formatDetailedMessage` 呼び出し）
- Test: `tests/index.test.js:695-732`

**Interfaces:**
- Consumes: Task 1 の `options.showStudyTime`、Task 2 の `options.missionWarningStyle`
- Produces: 夜通知は `streak_data.json` を読まない。LINE送信可否の `hasUnqualifiedUser` は `isStudied()` と `getRequirementForCourse()` だけで算出する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/index.test.js` の695-732行にある2つの `it` を、次の3つに丸ごと差し替える。

```javascript
    it('夜通知はストリークデータを読まない(loadStreakDataが失敗しても成功する)', async () => {
      setupMocks({
        loadStreakData: async () => ({ success: false, error: 'ストリークデータ読み込み失敗' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 0, 'ストリーク読み込み失敗に影響されないこと');

      const saveStreakCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveStreakCalls.length, 0, '夜通知は保存しないこと');

      const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
      assert.strictEqual(pushCalls.length, 1, '通知は送信されること');
    });

    it('formatDetailedMessageにstreaksを渡さない(ストリーク行を出さない)', async () => {
      let capturedOptions;
      setupMocks({
        formatDetailedMessage: (currentData, missionChangesResult, options) => {
          capturedOptions = options;
          return 'テスト詳細メッセージ';
        }
      });

      await mainModule.main();

      assert.ok(capturedOptions, 'formatDetailedMessageが呼ばれること');
      assert.strictEqual(capturedOptions.streaks, undefined, 'streaksオプションが渡されないこと');
    });

    it('formatDetailedMessageに夜通知用の表示オプションを渡す', async () => {
      let capturedOptions;
      setupMocks({
        formatDetailedMessage: (currentData, missionChangesResult, options) => {
          capturedOptions = options;
          return 'テスト詳細メッセージ';
        }
      });

      await mainModule.main();

      assert.strictEqual(capturedOptions.showStudyTime, false, '勉強時間を出さないこと');
      assert.strictEqual(capturedOptions.missionWarningStyle, 'today', '当日向けの警告文言を使うこと');
      assert.deepStrictEqual(
        capturedOptions.missionWarningThresholds,
        { elementary: 4, juniorHigh: 3 },
        'コース別しきい値は従来どおり渡すこと'
      );
    });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`

Expected: FAIL。`exitCode` が 1 になる（ストリーク読み込み失敗が errors に積まれる）、`capturedOptions.streaks` が `undefined` でない、`showStudyTime` が `undefined` の3件が落ちる。

- [ ] **Step 3: `src/index.js` からストリーク読み込みを削除する**

13行の require から、使わなくなる3つを外す。`isStudied` と `getRequirementForCourse` は `hasUnqualifiedUser` の算出に必要なので残す。

```javascript
const { isStudied, getRequirementForCourse } = require('./streak');
```

245-274行のブロックを次に差し替える。ストリーク状態の読み込みをやめ、当日の達成判定だけを残す。

```javascript
    // 6.5 当日のストリーク要件の達成判定
    // 夜通知はストリーク・おたすけ・ボーナスを表示しない(翌朝の確定通知がカバーする)ため
    // streak_data.json は読まない。LINEに送るかどうかの判定にだけ達成状況を使う。
    const todayDateString = getTargetDates(0).dateString;
    let hasUnqualifiedUser = false;
    currentData.forEach(user => {
      const threshold = getRequirementForCourse(user.course, todayDateString);
      if (!isStudied(user, { minCompletedMissions: threshold })) {
        hasUnqualifiedUser = true;
      }
    });
```

- [ ] **Step 4: `formatDetailedMessage` の呼び出しを更新する**

297-303行を差し替える。`streaks` を外し、夜通知用の表示オプションを渡す。

```javascript
    // 詳細メッセージをフォーマット（ミッション変化情報・コース別しきい値未達警告を含む）
    // ストリーク行と勉強時間は翌朝の確定通知でカバーするため夜は出さない
    const message = formatDetailedMessage(currentData, missionChangesResult, {
      showStudyTime: false,
      missionWarningStyle: 'today',
      missionWarningThresholds: {
        elementary: getRequirementForCourse('elementary', todayDateString),
        juniorHigh: getRequirementForCourse('juniorHigh', todayDateString)
      }
    });
```

- [ ] **Step 5: テストと lint を実行して通ることを確認する**

Run: `npm test`
Expected: 全件 PASS

Run: `npm run lint`
Expected: エラーなし（`loadStreakData` / `formatStreakInfo` / `createInitialState` の未使用 import が残っていれば落ちる）

- [ ] **Step 6: コミットする**

```bash
git add src/index.js tests/index.test.js
git commit -m "feat: 夜通知からストリーク行と勉強時間行を削除する"
```

---

### Task 4: ドキュメント更新とドライラン確認

**Files:**
- Modify: `CLAUDE.md:22`（日次通知の説明）, `CLAUDE.md:45`（ストリーク機能の説明）, `CLAUDE.md:47`付近（警告行の説明）

**Interfaces:**
- Consumes: Task 1〜3 の実装結果

- [ ] **Step 1: `CLAUDE.md:22` の日次通知の説明を更新する**

現在の記述:

```markdown
1. **日次通知** (`src/index.js`): 毎日 JST 20:00 に実行。両コース(小学生・中学生)の当日分を速報通知。ストリークは確定値＋当日暫定+1を表示するのみで確定・保存しない。**LINE送信数節約のため、当日のストリーク要件未達のユーザーが1人でもいる日だけLINEに送信**（全員達成日はLINEに送らず、断り行を付けてDiscordのみに記録する）
```

次に差し替える。

```markdown
1. **日次通知** (`src/index.js`): 毎日 JST 20:00 に実行。両コース(小学生・中学生)の当日分を速報通知。ストリーク・おたすけ・ボーナス・勉強時間は表示せず(翌朝の確定通知がカバーする)、`streak_data.json` も読まない。**LINE送信数節約のため、当日のストリーク要件未達のユーザーが1人でもいる日だけLINEに送信**（全員達成日はLINEに送らず、断り行を付けてDiscordのみに記録する）
```

- [ ] **Step 2: `CLAUDE.md:45` のストリーク機能の説明を更新する**

現在の記述の末尾「夜通知は速報で、確定値＋当日暫定+1を表示するのみ。」を次に差し替える。

```markdown
夜通知は速報で、ストリーク値を一切表示しない(当日の要件達成判定だけをLINE送信可否に使う)。
```

- [ ] **Step 3: `CLAUDE.md:47`付近の警告行の説明を更新する**

現在の記述:

```markdown
- 夜・朝通知とも完了数未達のユーザーに警告行（`missionWarningThresholds`、コース別に小学生=学習表記/中学生=講座表記）を表示する。`dataReliable: false` のユーザーと、朝通知で完全未学習（「昨日は学習していません」表示）の日には出さない
```

次に差し替える。

```markdown
- 夜・朝通知とも完了数未達のユーザーに警告行を表示する。しきい値は `missionWarningThresholds`、文言は `missionWarningStyle`（夜=`today`「🚨🚨 あと◯件! がんばろう! 🚨🚨」/ 朝=`past`「😢😢 あと◯件たりなかった… 😢😢」）で切り替える。残り件数だけを出すためコース別の表記差はない。`dataReliable: false` のユーザーと、朝通知で完全未学習（「昨日は学習していません」表示）の日には出さない
```

- [ ] **Step 4: 夜通知のドライランを実行して文面を確認する**

Run: `DRY_RUN=true node -r dotenv/config src/index.js`

Expected: プレビューにストリーク行（`🔥 連続学習`）と勉強時間行（`⏱️ 勉強時間`）が含まれない。未達のユーザーがいれば `🚨🚨 あと◯件! がんばろう! 🚨🚨` が出る。

- [ ] **Step 5: 朝通知のドライランを実行して文面を確認する**

Run: `DRY_RUN=true node -r dotenv/config src/morning-index.js`

Expected: ストリーク行と勉強時間行が従来どおり出る。未達のユーザーがいれば `😢😢 あと◯件たりなかった… 😢😢` が出る。

- [ ] **Step 6: 全テストと全検証を実行する**

Run: `npm test && npm run lint && npm run validate:all`
Expected: すべて PASS

- [ ] **Step 7: コミットする**

```bash
git add CLAUDE.md
git commit -m "docs: 夜通知の簡素化と警告文言の変更を反映する"
```
