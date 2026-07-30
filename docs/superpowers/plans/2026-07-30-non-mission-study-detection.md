# ミッション以外の学習の検出 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 小学生コースのタイムラインから自主学習（ミッションバッジのない講座行）を検出し、ストリーク判定と通知に反映する。あわせて講座詳細の10件上限を撤廃して `totalScore` を正しくする。

**Architecture:** 小学生タイムラインの取得を、boundingBox のY座標計算ベースから `dailyTimeline__` 日ブロック単位の行DOMベースに置き換える。DOM抽出は `page.evaluate()` 1回で行データ配列を取り出し、集計は純粋関数 `summarizeStudyRows()` に分離してテスト可能にする。ストリーク判定・差分比較の入力を `missionCount` から `studyItemCount`（ミッション＋自主の合計）に切り替える。

**Tech Stack:** Node.js 24 / CommonJS / Playwright (Chromium headless) / Node.js built-in test runner

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-30-non-mission-study-detection-design.md`
- DOM構造リファレンス: `docs/DOM_STRUCTURE.md`
- モジュールシステムは CommonJS（`require` / `module.exports`）。ESM は使わない
- DOMセレクタは **すべて `[class*="..."]` の前方一致** にする。CSS Modules のハッシュはビルドで変わるため
- I/O関数は `{success: boolean, data?/error?}` を返す。純粋関数は値を直接返す
- グレースフルデグラデーション: サブ取得の「データなし」は `success: true` ＋ ゼロ値。例外時のみ `success: false`
- **ストリークのしきい値は変更しない**（小学生4件 / 中学生 平日3件・土日5件）
- 単一テストファイルの実行には2つのオプションが必須:
  `node --test --test-force-exit --experimental-test-isolation=none tests/xxx.test.js`
- 全テスト: `npm test` / lint: `npm run lint`
- Markdown・コメント・ログ・通知文言はすべて日本語
- 作業ブランチ `feat/non-mission-study-detection` で作業する（作成済み）

---

### Task 1: 行データの集計を行う純粋関数を追加する

DOMから抽出した行データ配列を、ユーザーデータのフィールドに集計する純粋関数を作る。
DOM抽出そのものは Task 2 で行う。ここでは集計ロジックだけを先に固める。

**Files:**
- Modify: `src/crawler.js`（`getTotalScore` の直後、`module.exports` に追加）
- Test: `tests/crawler.test.js`

**Interfaces:**
- Consumes: なし
- Produces: `summarizeStudyRows(rows)` → `{ studyItemCount: number, missionCount: number, missions: Array, totalScore: number }`
  - 入力 `rows` の各要素: `{ name?: string, isMission?: boolean, score?: number, correctAnswers?: number|null, questionCount?: number|null }`
  - 出力 `missions` の各要素: `{ name: string, score: number, completed: true, isMission: boolean, correctAnswers: number|null, questionCount: number|null }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/crawler.test.js` の `describe('getTotalScore() - 合計点数計算', ...)` ブロックの直後に追加する。

```js
  // ─── summarizeStudyRows テスト ───

  describe('summarizeStudyRows() - 行データの集計', () => {
    it('全てミッションの場合、studyItemCount と missionCount が一致する', () => {
      const rows = [
        { name: 'こそあど言葉', isMission: true, score: 93 },
        { name: '小数のひき算', isMission: true, score: 80 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.studyItemCount, 2);
      assert.strictEqual(result.missionCount, 2);
      assert.strictEqual(result.totalScore, 173);
      assert.strictEqual(result.missions.length, 2);
      assert.strictEqual(result.missions[0].isMission, true);
      assert.strictEqual(result.missions[0].completed, true);
    });

    it('ミッションと自主学習が混在する場合、missionCount はミッションのみを数える', () => {
      const rows = [
        { name: 'こそあど言葉', isMission: true, score: 93 },
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.studyItemCount, 2);
      assert.strictEqual(result.missionCount, 1);
      assert.strictEqual(result.missions[1].isMission, false);
    });

    it('全て自主学習の場合、missionCount は0になる', () => {
      const rows = [
        { name: 'ふしぎ探検 世界遺産', isMission: false },
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.studyItemCount, 2);
      assert.strictEqual(result.missionCount, 0);
    });

    it('空配列の場合、全て0と空配列を返す', () => {
      const result = crawler.summarizeStudyRows([]);

      assert.strictEqual(result.studyItemCount, 0);
      assert.strictEqual(result.missionCount, 0);
      assert.strictEqual(result.totalScore, 0);
      assert.deepStrictEqual(result.missions, []);
    });

    it('正答数タイプの行は score 0 で合計点に寄与しない', () => {
      const rows = [
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.totalScore, 0);
      assert.strictEqual(result.missions[0].score, 0);
      assert.strictEqual(result.missions[0].correctAnswers, 9);
      assert.strictEqual(result.missions[0].questionCount, 10);
    });

    it('点数タイプと正答数タイプが混在しても合計点は点数タイプのみ', () => {
      const rows = [
        { name: 'こそあど言葉', isMission: true, score: 93 },
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 },
        { name: '小数のひき算', isMission: true, score: 80 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.totalScore, 173);
      assert.strictEqual(result.missions[0].questionCount, null);
      assert.strictEqual(result.missions[1].score, 0);
    });

    it('名前が空の行はデフォルト名になる', () => {
      const result = crawler.summarizeStudyRows([{ name: '', isMission: true, score: 50 }]);

      assert.strictEqual(result.missions[0].name, 'ミッション');
    });

    it('rows が配列でない場合も0件として扱う', () => {
      const result = crawler.summarizeStudyRows(null);

      assert.strictEqual(result.studyItemCount, 0);
      assert.deepStrictEqual(result.missions, []);
    });
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/crawler.test.js`
Expected: FAIL（`crawler.summarizeStudyRows is not a function`）

- [ ] **Step 3: 最小限の実装を書く**

`src/crawler.js` の `getTotalScore` 関数定義の直後に追加する。

```js
/**
 * タイムラインから抽出した行データを集計する(純粋関数)
 *
 * 行データはDOM抽出の結果で、ミッション/自主学習の区別と学習結果を持つ。
 * これをユーザーデータの missions 配列と各カウントに変換する。
 *
 * @param {Array<{name?: string, isMission?: boolean, score?: number, correctAnswers?: number|null, questionCount?: number|null}>} rows
 * @returns {{studyItemCount: number, missionCount: number, missions: Array, totalScore: number}}
 */
function summarizeStudyRows(rows) {
  const source = Array.isArray(rows) ? rows : [];

  const missions = source.map(row => ({
    name: (row.name || '').trim() || selectors.missionDetails.missionName.defaultName,
    score: row.score ?? 0,
    // タイムラインに載っている = 実施済みのため常に完了扱い
    completed: true,
    isMission: row.isMission === true,
    correctAnswers: row.correctAnswers ?? null,
    questionCount: row.questionCount ?? null
  }));

  return {
    studyItemCount: missions.length,
    missionCount: missions.filter(mission => mission.isMission).length,
    missions,
    totalScore: getTotalScore(missions)
  };
}
```

`module.exports` に `summarizeStudyRows,` を追加する（`getTotalScore,` の直後）。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/crawler.test.js`
Expected: PASS（既存テストも全て通ること）

- [ ] **Step 5: lint を実行する**

Run: `npm run lint`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/crawler.js tests/crawler.test.js
git commit -m "feat: 行データを集計する純粋関数 summarizeStudyRows を追加する"
```

---

### Task 2: 小学生タイムラインの抽出を行DOMベースに置き換える

Y座標計算による日付切り分けをやめ、`dailyTimeline__` 日ブロック単位の抽出に置き換える。
`page.evaluate()` 1回で日ブロックを特定し、学習時間と全行データを取り出す。

**Files:**
- Modify: `src/config/selectors.js`（`missionDetails` の直後に `elementaryTimeline` を追加）
- Modify: `src/crawler.js`（`getTodayMissionCount` / `getStudyTime` / `getMissionDetails` の小学生分岐、`getCourseData`）
- Test: `tests/crawler.test.js`（既存のモックベーステストの調整のみ。DOM抽出は DRY_RUN 実機検証）

**Interfaces:**
- Consumes: `summarizeStudyRows(rows)`（Task 1）
- Produces:
  - `extractElementaryDay(page, dateOffset)` → `Promise<{found: boolean, minuteText: string, rows: Array}>`（private, exportしない）
  - `getCourseData()` の返す `data` に `studyItemCount: number` を追加

- [ ] **Step 1: セレクタ定義を追加する**

`src/config/selectors.js` の `missionDetails: { ... }` ブロックの直後（`juniorHighTimeline` の前）に追加する。

```js
  // 小学生コース タイムラインのセレクタ
  // DOM調査日: 2026-07-30 (docs/DOM_STRUCTURE.md 参照)
  // 日ブロックが構造として分離されているため、Y座標計算は不要
  // クラス名は CSS Modules のハッシュ付きのため、すべて前方一致で指定する
  elementaryTimeline: {
    dayBlock: '[class*="dailyTimeline__"]',       // 1日分のブロック
    dateLabel: '[class*="date__"]',               // 日ブロック内の日付 "07/30(木)"
    totalStudyTime: '[class*="totalStudyTime__"] [class*="minute__"]', // "15分"
    courseList: '[class*="courseList__"]',        // 学習行リスト
    accordion: '[class*="accordionRoot__"]',      // スターアプリ行(カウント対象外)
    missionBadge: '[class*="missionIcon__"]',     // ミッションバッジ
    courseTitle: '[class*="title__"]',            // 講座名
    scoreNumber: '[class*="scoreNumber__"]',      // 点数タイプ "93"
    correctAnswerCount: '[class*="correctAnswerCount__"]', // 正答数タイプ "9"
    questionCount: '[class*="questionCount__"]'   // 正答数タイプ "/10"
  },
```

- [ ] **Step 2: DOM抽出関数を追加する**

`src/crawler.js` の `getTodayMissionCount` 関数定義の**直前**に追加する。

```js
/**
 * 小学生コース: 対象日の日ブロックから学習時間と全行データを1回のevaluateで抽出する
 *
 * 日ブロック([class*="dailyTimeline__"])が構造として分離されているため、
 * 旧実装のような boundingBox のY座標計算は不要。
 * スターアプリのアコーディオン行は学習として扱わないため読み飛ばす。
 *
 * @private
 * @param {import('playwright').Page} page
 * @param {number} dateOffset - 0=今日、-1=昨日
 * @returns {Promise<{found: boolean, minuteText: string, rows: Array<{name: string, isMission: boolean, score: number, correctAnswers: number|null, questionCount: number|null}>}>}
 */
async function extractElementaryDay(page, dateOffset = 0) {
  const targetDates = getTargetDates(dateOffset);
  const { elementaryTimeline } = selectors;

  return page.evaluate(({ padded, unpadded, sel }) => {
    const parseIntOrNull = (text) => {
      const digits = (text || '').replace(/\D/g, '');
      return digits ? parseInt(digits, 10) : null;
    };

    const dayBlocks = Array.from(document.querySelectorAll(sel.dayBlock));

    for (const dayBlock of dayBlocks) {
      const dateEl = dayBlock.querySelector(sel.dateLabel);
      const dateText = (dateEl ? dateEl.textContent : '').trim();

      if (!dateText.includes(padded) && !dateText.includes(unpadded)) continue;

      const minuteEl = dayBlock.querySelector(sel.totalStudyTime);
      const minuteText = (minuteEl ? minuteEl.textContent : '').trim();

      const list = dayBlock.querySelector(sel.courseList);
      const rows = [];

      if (list) {
        for (const row of Array.from(list.children)) {
          // スターアプリ(アコーディオン行)は学習として扱わない
          if (row.querySelector(sel.accordion)) continue;

          const titleEl = row.querySelector(sel.courseTitle);
          const scoreEl = row.querySelector(sel.scoreNumber);
          const correctEl = row.querySelector(sel.correctAnswerCount);
          const questionEl = row.querySelector(sel.questionCount);

          rows.push({
            name: (titleEl ? titleEl.textContent : '').trim(),
            isMission: !!row.querySelector(sel.missionBadge),
            score: parseIntOrNull(scoreEl ? scoreEl.textContent : '') ?? 0,
            correctAnswers: parseIntOrNull(correctEl ? correctEl.textContent : ''),
            questionCount: parseIntOrNull(questionEl ? questionEl.textContent : '')
          });
        }
      }

      return { found: true, minuteText, rows };
    }

    return { found: false, minuteText: '', rows: [] };
  }, {
    padded: targetDates.withPadding,
    unpadded: targetDates.withoutPadding,
    sel: elementaryTimeline
  }).then(result => result ?? { found: false, minuteText: '', rows: [] });
}
```

末尾の `.then(...)` は、`page.evaluate` が値を返さないモック環境でも
「その日のデータなし」として安全に扱うためのガード。

- [ ] **Step 3: `getTodayMissionCount` の小学生分岐を置き換える**

`src/crawler.js` の `getTodayMissionCount` のうち、中学生分岐（`if (isJuniorHighSchool(...)) return getTodayMissionCountForJuniorHigh(...)`）は残し、
その後の `try { ... }` ブロック全体を以下で置き換える。

```js
  try {
    const todayDates = getTargetDates(dateOffset);
    const day = await extractElementaryDay(page, dateOffset);

    if (!day.found) {
      console.log(`  ℹ️ 今日(${todayDates.withPadding})のデータはまだありません（0件として扱います）`);
      return { success: true, count: 0 };
    }

    const summary = summarizeStudyRows(day.rows);

    console.log(`📊 今日(${todayDates.withPadding})の学習件数: ${summary.studyItemCount}件（ミッション${summary.missionCount}件）`);

    return {
      success: true,
      count: summary.studyItemCount,
      missionCount: summary.missionCount
    };
  } catch (error) {
    return {
      success: false,
      error: `ミッション数取得エラー: ${error.message}`,
      count: 0
    };
  }
```

- [ ] **Step 4: `getStudyTime` の小学生分岐を置き換える**

`src/crawler.js` の `getStudyTime` のうち、中学生分岐は残し、その後の `try { ... }` ブロック全体を以下で置き換える。

```js
  try {
    const todayDates = getTargetDates(dateOffset);
    const day = await extractElementaryDay(page, dateOffset);

    if (!day.found) {
      console.log(`  ℹ️ 今日(${todayDates.withPadding})のデータが見つかりません（勉強時間: 0時間0分）`);
      return { success: true, hours: 0, minutes: 0 };
    }

    // 左カラムの学習時間。スターアプリの時間は含まれない(サイト側の仕様)
    const parsed = parseStudyTime(day.minuteText);

    if (!parsed) {
      console.log(`  ℹ️ 勉強時間のパースに失敗: "${day.minuteText}"（0時間0分として扱います）`);
      return { success: true, hours: 0, minutes: 0 };
    }

    console.log(`📚 勉強時間: ${parsed.hours}時間${parsed.minutes}分`);

    return { success: true, hours: parsed.hours, minutes: parsed.minutes };
  } catch (error) {
    return {
      success: false,
      error: `勉強時間取得エラー: ${error.message}`,
      hours: 0,
      minutes: 0
    };
  }
```

- [ ] **Step 5: `getMissionDetails` の小学生分岐を置き換える**

`src/crawler.js` の `getMissionDetails` のうち、中学生分岐は残し、その後の `try { ... }` ブロック全体を以下で置き換える。
ここで旧実装の10件上限（`if (missions.length >= 10) break;`）も消える。

```js
  try {
    const todayDates = getTargetDates(dateOffset);
    const day = await extractElementaryDay(page, dateOffset);

    if (!day.found) {
      console.log(`  ℹ️ 今日(${todayDates.withPadding})のデータが見つかりません（空配列として扱います）`);
      return { success: true, missions: [] };
    }

    const summary = summarizeStudyRows(day.rows);

    console.log(`📋 今日(${todayDates.withPadding})の学習詳細: ${summary.missions.length}件（自主学習${summary.studyItemCount - summary.missionCount}件）`);

    return { success: true, missions: summary.missions };
  } catch (error) {
    return {
      success: false,
      error: `ミッション詳細取得エラー: ${error.message}`,
      missions: []
    };
  }
```

- [ ] **Step 6: `getCourseData` に `studyItemCount` を足す**

`src/crawler.js` の `getCourseData` 内、`const missionCount = missionCountResult.success ? missionCountResult.count : 0;` の直後に追加する。

```js
    // 学習件数(ミッション+自主)。ミッション数は内訳表示のために別に持つ。
    // 中学生コースはミッション概念がないため両者が一致する。
    const studyItemCount = missionCount;
    const missionOnlyCount = missionCountResult.missionCount ?? missionCount;
```

そして返却する `data` オブジェクトの `missionCount,` を以下2行に置き換える。

```js
        studyItemCount,
        missionCount: missionOnlyCount,
```

- [ ] **Step 7: 既存モックに日ブロックを差し込めるようにする**

`tests/crawler.test.js` の `createMockPage` 内、`evaluate: mock.fn(async () => {}),` を以下に置き換える。

```js
      evaluate: mock.fn(async () => config.elementaryDay ?? { found: false, minuteText: '', rows: [] }),
```

既存テストは `elementaryDay` を渡さないため `found: false` となり、
「今日のデータがない場合は0件」という現行の期待値がそのまま通る。

- [ ] **Step 8: 小学生タイムライン抽出のテストを追加する**

`tests/crawler.test.js` の `summarizeStudyRows` の describe ブロックの直後に追加する。

```js
  // ─── 小学生タイムライン抽出テスト ───

  describe('小学生コースのタイムライン抽出', () => {
    const elementaryDay = {
      found: true,
      minuteText: '15分',
      rows: [
        { name: 'こそあど言葉', isMission: true, score: 93, correctAnswers: null, questionCount: null },
        { name: '小数のひき算', isMission: true, score: 80, correctAnswers: null, questionCount: null },
        { name: '小数のたし算', isMission: true, score: 80, correctAnswers: null, questionCount: null },
        { name: '8級 同じ漢字の読み', isMission: true, score: 90, correctAnswers: null, questionCount: null },
        { name: '漢字のミニテスト', isMission: false, score: 0, correctAnswers: 9, questionCount: 10 }
      ]
    };

    it('getTodayMissionCount() は自主学習を含めた学習件数を返す', async () => {
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDay });

      const result = await crawler.getTodayMissionCount(page, '小学生コース', 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 5);
      assert.strictEqual(result.missionCount, 4);
    });

    it('getMissionDetails() は自主学習の行も isMission: false で返す', async () => {
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDay });

      const result = await crawler.getMissionDetails(page, '小学生コース', 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.missions.length, 5);
      assert.strictEqual(result.missions[4].isMission, false);
      assert.strictEqual(result.missions[4].correctAnswers, 9);
      assert.strictEqual(result.missions[4].questionCount, 10);
    });

    it('getStudyTime() は左カラムの分数をパースする', async () => {
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDay });

      const result = await crawler.getStudyTime(page, '小学生コース', 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hours, 0);
      assert.strictEqual(result.minutes, 15);
    });

    it('日ブロックが見つからない日は0件・0分を success で返す', async () => {
      const page = createMockPage({
        userNames: ['太郎さん'],
        elementaryDay: { found: false, minuteText: '', rows: [] }
      });

      const count = await crawler.getTodayMissionCount(page, '小学生コース', 0);
      const details = await crawler.getMissionDetails(page, '小学生コース', 0);
      const time = await crawler.getStudyTime(page, '小学生コース', 0);

      assert.strictEqual(count.success, true);
      assert.strictEqual(count.count, 0);
      assert.strictEqual(details.success, true);
      assert.deepStrictEqual(details.missions, []);
      assert.strictEqual(time.success, true);
      assert.strictEqual(time.minutes, 0);
    });

    it('スターアプリのぶんは行に含まれないため件数に入らない', async () => {
      // extractElementaryDay がアコーディオン行を読み飛ばした結果を模す
      const page = createMockPage({
        userNames: ['太郎さん'],
        elementaryDay: {
          found: true,
          minuteText: '15分',
          rows: [{ name: 'こそあど言葉', isMission: true, score: 93, correctAnswers: null, questionCount: null }]
        }
      });

      const result = await crawler.getTodayMissionCount(page, '小学生コース', 0);

      assert.strictEqual(result.count, 1);
    });
  });
```

- [ ] **Step 9: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/crawler.test.js`
Expected: PASS（既存テストも全て通ること）

- [ ] **Step 10: 全テストと lint を実行する**

Run: `npm test && npm run lint`
Expected: PASS / エラーなし

- [ ] **Step 11: コミット**

```bash
git add src/config/selectors.js src/crawler.js tests/crawler.test.js
git commit -m "feat: 小学生タイムラインの抽出を行DOMベースにし自主学習を検出する"
```

---

### Task 3: 中学生コースの講座詳細を summarizeStudyRows 経由にして10件上限を撤廃する

`getMissionDetailsForJuniorHigh` が独自に `missions` を組み立てて10件で打ち切っているのをやめ、
Task 1 の `summarizeStudyRows` に通す。これにより上限が自然に消え、`totalScore` が全件から
計算されるようになり、`isMission` / `correctAnswers` / `questionCount` のフィールドも
小学生コースと揃う。

**検証方法について:** 中学生コースのDOM走査（`dailyRoot__` → `subject__bWHro` → `course__KrAEA`）には
現状ユニットテストが存在せず、Playwright の Locator を手で組んだモックは実DOMと乖離して壊れやすい。
本タスクでは走査部分は Task 7 の DRY_RUN 実機検証で確認し、**集計と上限撤廃は
`summarizeStudyRows` に集約することで Task 1 のテストでカバーする**。

**Files:**
- Modify: `src/crawler.js`（`getMissionDetailsForJuniorHigh`、`getTodayMissionCountForJuniorHigh`）

**Interfaces:**
- Consumes: `summarizeStudyRows(rows)`（Task 1）
- Produces: `getTodayMissionCountForJuniorHigh()` の戻り値に `missionCount: number` を追加（`count` と同値）

- [ ] **Step 1: `getMissionDetailsForJuniorHigh` を summarizeStudyRows 経由にする**

`src/crawler.js` の `getMissionDetailsForJuniorHigh` 内、`const missions = [];` を以下に置き換える。

```js
    const rows = [];
```

次に、`missions.push({ ... })` とその後の打ち切りを含む以下のブロック

```js
        missions.push({
          name,
          score,
          completed: true
        });

        if (missions.length >= 10) break;
      }

      if (missions.length >= 10) break;
    }
```

を、以下に置き換える。

```js
        // 中学生コースにミッション概念はなく、載っている行は全て学習実績
        rows.push({
          name,
          score,
          isMission: true
        });
      }
    }
```

最後に、`console.log` と `return` を以下に置き換える。

```js
    const summary = summarizeStudyRows(rows);

    console.log(`📋 [中学生] 今日(${todayDates.withPadding})の講座詳細: ${summary.missions.length}件`);
    return { success: true, missions: summary.missions };
```

- [ ] **Step 2: `getTodayMissionCountForJuniorHigh` に `missionCount` を足す**

`src/crawler.js` の `getTodayMissionCountForJuniorHigh` 内、2箇所の `return` を置き換える。

データなしの分岐:

```js
      return { success: true, count: 0, missionCount: 0 };
```

正常系の分岐:

```js
    return { success: true, count, missionCount: count };
```

エラー分岐（`catch`）はそのままでよい（`count: 0` のみ返し、`missionCount` は
`getCourseData` 側で `?? missionCount` にフォールバックされる）。

- [ ] **Step 3: 全テストと lint を実行する**

Run: `npm test && npm run lint`
Expected: PASS / エラーなし

- [ ] **Step 4: コミット**

```bash
git add src/crawler.js
git commit -m "fix: 中学生コースの講座詳細10件上限を撤廃しtotalScoreを正しくする"
```

---

### Task 4: ストリーク判定の入力を学習件数に切り替える

`missionCount`（ミッションのみ）ではなく `studyItemCount`（ミッション＋自主）で達成判定する。
しきい値は変更しない。既存キャッシュとの後方互換のため `studyItemCount` がなければ `missionCount` を使う。

**Files:**
- Modify: `src/streak.js`（`countCompletedMissions` の直後に `countStudyItems` を追加、`isStudied` を変更、`module.exports`）
- Test: `tests/streak.test.js`

**Interfaces:**
- Consumes: なし
- Produces: `countStudyItems(user)` → `number`
  - `user.studyItemCount` が number ならそれを返す
  - なければ `countCompletedMissions(user)` にフォールバック

- [ ] **Step 1: 失敗するテストを書く**

`tests/streak.test.js` の末尾（最後の `describe` の後、ファイル末尾の閉じ括弧の前）に追加する。

```js
  // ─── countStudyItems テスト ───

  describe('countStudyItems() - 学習件数の算出', () => {
    it('studyItemCount があればそれを返す', () => {
      const user = { studyItemCount: 5, missionCount: 4 };

      assert.strictEqual(streak.countStudyItems(user), 5);
    });

    it('studyItemCount がなければ missionCount にフォールバックする', () => {
      const user = { missionCount: 4 };

      assert.strictEqual(streak.countStudyItems(user), 4);
    });

    it('どちらもなければ missions の completed 件数を使う', () => {
      const user = { missions: [{ completed: true }, { completed: true }, { completed: false }] };

      assert.strictEqual(streak.countStudyItems(user), 2);
    });

    it('studyItemCount が 0 でも missionCount にフォールバックしない', () => {
      const user = { studyItemCount: 0, missionCount: 4 };

      assert.strictEqual(streak.countStudyItems(user), 0);
    });
  });

  // ─── 自主学習を含めた達成判定テスト ───

  describe('isStudied() - 自主学習を含めた判定', () => {
    it('ミッション2件+自主2件の計4件でしきい値4を満たす', () => {
      const user = { studyItemCount: 4, missionCount: 2 };

      assert.strictEqual(streak.isStudied(user, { minCompletedMissions: 4 }), true);
    });

    it('ミッション3件のみ(自主0件)ではしきい値4を満たさない', () => {
      const user = { studyItemCount: 3, missionCount: 3 };

      assert.strictEqual(streak.isStudied(user, { minCompletedMissions: 4 }), false);
    });

    it('studyItemCount のない旧データは missionCount で判定する', () => {
      const user = { missionCount: 4 };

      assert.strictEqual(streak.isStudied(user, { minCompletedMissions: 4 }), true);
    });
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: FAIL（`streak.countStudyItems is not a function`）

- [ ] **Step 3: `countStudyItems` を実装する**

`src/streak.js` の `countCompletedMissions` 関数定義の直後に追加する。

```js
/**
 * その日の学習件数を数える(ミッション+自主学習)
 *
 * 小学生コースのタイムラインにはミッションバッジのない自主学習も並ぶ。
 * ストリークの達成判定はこの合計件数で行う。
 * studyItemCount を持たない旧データ(actions/cache に残る過去分)は
 * missionCount にフォールバックし、従来と同じ結果になるようにする。
 *
 * @param {{studyItemCount?: number, missionCount?: number, missions?: Array<{completed: boolean}>}} user
 * @returns {number}
 */
function countStudyItems(user) {
  if (typeof user.studyItemCount === 'number') {
    return user.studyItemCount;
  }
  return countCompletedMissions(user);
}
```

- [ ] **Step 4: `isStudied` を変更する**

`src/streak.js` の `isStudied` 内、`return countCompletedMissions(user) >= minCompletedMissions;` を以下に置き換える。

```js
    return countStudyItems(user) >= minCompletedMissions;
```

あわせて `isStudied` の JSDoc の説明文を更新する。

```js
/**
 * その日に学習したかを判定(notifier.js の未学習判定と同一基準)
 *
 * minCompletedMissions を1以上指定した場合(コース別のしきい値)は
 * 「学習件数(ミッション+自主学習) >= 指定値」のみで判定し、勉強時間は見ない。
 *
 * @param {{studyTime?: {hours: number, minutes: number}, studyItemCount?: number, missionCount?: number, missions?: Array}} user - v2.0形式のユーザーデータ
 * @param {object} [options]
 * @param {number} [options.minCompletedMissions=0] - ストリークに必要な学習件数
 * @returns {boolean}
 */
```

- [ ] **Step 5: `module.exports` に追加する**

`src/streak.js` の `module.exports` の `countCompletedMissions,` の直後に `countStudyItems,` を追加する。

- [ ] **Step 6: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: PASS（既存テストも全て通ること）

- [ ] **Step 7: 全テストと lint を実行する**

Run: `npm test && npm run lint`
Expected: PASS / エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: ストリーク判定を学習件数(ミッション+自主)ベースにする"
```

---

### Task 5: 差分比較を学習件数ベースにする

`compareData` が `missionCount` で比較していると、自主学習だけ増えた日に差分が出ない。
`studyItemCount` で比較する。

**Files:**
- Modify: `src/data.js`（`compareData`）
- Test: `tests/data.test.js`

**Interfaces:**
- Consumes: なし（`user.studyItemCount ?? user.missionCount` を内部で読むだけ）
- Produces: 変更なし（`compareData` のシグネチャと戻り値の形は同じ）

- [ ] **Step 1: 失敗するテストを書く**

`tests/data.test.js` の `compareData` の describe ブロック内に追加する。

```js
    it('studyItemCount の増加を検出する', () => {
      const previous = [{ userName: 'たろう', studyItemCount: 3, missionCount: 3 }];
      const current = [{ userName: 'たろう', studyItemCount: 5, missionCount: 3 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].type, 'increase');
      assert.strictEqual(result.changes[0].previousCount, 3);
      assert.strictEqual(result.changes[0].currentCount, 5);
      assert.strictEqual(result.changes[0].diff, 2);
    });

    it('自主学習だけ増えた日も差分として検出する', () => {
      const previous = [{ userName: 'たろう', studyItemCount: 4, missionCount: 4 }];
      const current = [{ userName: 'たろう', studyItemCount: 6, missionCount: 4 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].diff, 2);
    });

    it('studyItemCount のない旧データは missionCount で比較する', () => {
      const previous = [{ userName: 'たろう', missionCount: 2 }];
      const current = [{ userName: 'たろう', missionCount: 4 }];

      const result = data.compareData(previous, current);

      assert.strictEqual(result.changes.length, 1);
      assert.strictEqual(result.changes[0].diff, 2);
    });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/data.test.js`
Expected: FAIL（`studyItemCount` が無視され `missionCount` で比較されるため、1件目と2件目のテストが失敗する）

- [ ] **Step 3: 実装を変更する**

`src/data.js` の `compareData` 内で、比較値を取り出すヘルパーを関数の先頭に追加する。

```js
function compareData(previousData, currentData) {
  const changes = [];

  // 学習件数(ミッション+自主)で比較する。
  // studyItemCount を持たない旧データは missionCount にフォールバックする。
  const countOf = (user) =>
    typeof user.studyItemCount === 'number' ? user.studyItemCount : user.missionCount;
```

そして2箇所を置き換える。

```js
    previousMap.set(user.userName, countOf(user));
```

```js
    const currentCount = countOf(current);
```

- [ ] **Step 4: データ構造のJSDocを更新する**

`src/data.js` 冒頭のデータ構造コメント内、`*       missionCount: number,` の行を以下2行に置き換える。

```js
 *       studyItemCount: number,  // 学習件数(ミッション+自主学習)
 *       missionCount: number,    // うちミッションバッジ付きの件数
```

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/data.test.js`
Expected: PASS

- [ ] **Step 6: 全テストと lint を実行する**

Run: `npm test && npm run lint`
Expected: PASS / エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/data.js tests/data.test.js
git commit -m "feat: 差分比較を学習件数ベースにし自主学習の増加を検出する"
```

---

### Task 6: 通知に学習件数の内訳と自主学習の印を表示する

通知の各ユーザーブロックに学習件数行を足し、講座一覧で自主学習に `（自主）` を付ける。
正答数タイプの結果を `9/10` 形式で表示し、一覧は10件までで打ち切って `・ほか◯件` にまとめる。
未達警告の文言を「ミッション」から「学習」に変える（中学生は「講座」のまま）。

**Files:**
- Modify: `src/notifier.js`（`formatDetailedMessage`）
- Test: `tests/notifier.test.js`

**Interfaces:**
- Consumes: `countStudyItems(user)`（Task 4、`src/streak.js` から import）
- Produces: 変更なし（`formatDetailedMessage` のシグネチャは同じ）

- [ ] **Step 1: 失敗するテストを書く**

`tests/notifier.test.js` の `formatDetailedMessage` の describe ブロック内に追加する。

```js
    it('自主学習がある場合、学習件数行に内訳を表示する', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 5,
        missionCount: 4,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 343,
        missions: [
          { name: 'こそあど言葉', score: 93, completed: true, isMission: true },
          { name: '漢字のミニテスト', score: 0, completed: true, isMission: false, correctAnswers: 9, questionCount: 10 }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('✅ 学習5件（ミッション4・自主1）'), message);
    });

    it('自主学習が0件の場合、内訳を出さない', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 4,
        missionCount: 4,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 343,
        missions: [{ name: 'こそあど言葉', score: 93, completed: true, isMission: true }]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('✅ 学習4件'), message);
      assert.ok(!message.includes('自主'), message);
    });

    it('自主学習の講座行に（自主）を付ける', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 2,
        missionCount: 1,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 93,
        missions: [
          { name: 'こそあど言葉', score: 93, completed: true, isMission: true },
          { name: 'ふしぎ探検 世界遺産', score: 0, completed: true, isMission: false }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・ふしぎ探検 世界遺産: 0点（自主）'), message);
      assert.ok(!message.includes('・こそあど言葉: 93点（自主）'), message);
    });

    it('正答数タイプの結果は 9/10 形式で表示する', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 1,
        missionCount: 0,
        studyTime: { hours: 0, minutes: 5 },
        totalScore: 0,
        missions: [
          { name: '漢字のミニテスト', score: 0, completed: true, isMission: false, correctAnswers: 9, questionCount: 10 }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・漢字のミニテスト: 9/10（自主）'), message);
    });

    it('講座が11件以上の場合、10件までで打ち切り「ほか◯件」を出す', () => {
      const missions = Array.from({ length: 13 }, (_, i) => ({
        name: `講座${i + 1}`, score: 50, completed: true, isMission: true
      }));
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 13,
        missionCount: 13,
        studyTime: { hours: 1, minutes: 0 },
        totalScore: 650,
        missions
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・講座10: 50点'), message);
      assert.ok(!message.includes('・講座11:'), message);
      assert.ok(message.includes('・ほか3件'), message);
    });

    it('講座がちょうど10件の場合、「ほか◯件」を出さない', () => {
      const missions = Array.from({ length: 10 }, (_, i) => ({
        name: `講座${i + 1}`, score: 50, completed: true, isMission: true
      }));
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 10,
        missionCount: 10,
        studyTime: { hours: 1, minutes: 0 },
        totalScore: 500,
        missions
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・講座10: 50点'), message);
      assert.ok(!message.includes('ほか'), message);
    });

    it('小学生コースの未達警告は「学習」表記になる', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 2,
        missionCount: 2,
        studyTime: { hours: 0, minutes: 10 },
        totalScore: 100,
        missions: [{ name: 'こそあど言葉', score: 100, completed: true, isMission: true }],
        dataReliable: true
      }];

      const message = notifier.formatDetailedMessage(userData, null, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });

      assert.ok(message.includes('⚠️ 学習完了 2/4件'), message);
      assert.ok(message.includes('4件完了しないと連続学習にカウントされないよ!'), message);
    });

    it('中学生コースの未達警告は「講座」表記のまま', () => {
      const userData = [{
        userName: 'じろう (中学生コース)',
        course: 'juniorHigh',
        studyItemCount: 1,
        missionCount: 1,
        studyTime: { hours: 0, minutes: 10 },
        totalScore: 75,
        missions: [{ name: '数学: 四則の混じった計算', score: 75, completed: true, isMission: true }],
        dataReliable: true
      }];

      const message = notifier.formatDetailedMessage(userData, null, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });

      assert.ok(message.includes('⚠️ 講座完了 1/3件'), message);
    });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: FAIL（学習件数行が存在せず、警告が「個」表記のまま）

- [ ] **Step 3: import と定数を追加する**

`src/notifier.js` のファイル冒頭、`countCompletedMissions` を import している行を探し、`countStudyItems` も import する。
既存が `const { countCompletedMissions } = require('./streak');` なら以下にする。

```js
const { countCompletedMissions, countStudyItems } = require('./streak');
```

`MAX_MESSAGE_LENGTH` の定義の直後に追加する。

```js
// 通知に並べる講座の最大件数。超過分は「ほか◯件」にまとめる。
// クローラー側では全件取得しており、合計点や学習件数は全件から計算される。
const MAX_LISTED_COURSES = 10;
```

- [ ] **Step 4: 学習件数行を追加する**

`src/notifier.js` の `formatDetailedMessage` 内、`const isNoStudy = ...` の行の直後に追加する。

```js
    // 学習件数(ミッション+自主)。自主学習があるときだけ内訳を出す
    const studyItemCount = countStudyItems(user);
    const missionOnlyCount = user.missionCount ?? studyItemCount;
    const selfStudyCount = Math.max(0, studyItemCount - missionOnlyCount);

    if (!(showNoStudyWarning && isNoStudy) && studyItemCount > 0) {
      message += selfStudyCount > 0
        ? `✅ 学習${studyItemCount}件（ミッション${missionOnlyCount}・自主${selfStudyCount}）\n`
        : `✅ 学習${studyItemCount}件\n`;
    }
```

- [ ] **Step 5: 未達警告の文言を変える**

`src/notifier.js` の `formatDetailedMessage` 内、警告ブロックを以下に置き換える。

```js
    if (warnThreshold && user.dataReliable !== false && !(showNoStudyWarning && isNoStudy)) {
      const completedCount = countStudyItems(user);
      if (completedCount < warnThreshold) {
        // 小学生コースはミッション以外の自主学習も件数に含めるため「学習」表記にする
        const unitLabel = isJuniorHigh ? '講座' : '学習';
        message += `⚠️ ${unitLabel}完了 ${completedCount}/${warnThreshold}件 — ${warnThreshold}件完了しないと連続学習にカウントされないよ!\n`;
      }
    }
```

- [ ] **Step 6: 講座一覧の表示を変える**

`src/notifier.js` の `formatDetailedMessage` 内、`missionGroups.forEach((group, missionName) => {` から
その `});` までのブロックを、以下に置き換える。

```js
      // 表示は先頭 MAX_LISTED_COURSES 件まで。超過分は「ほか◯件」にまとめる
      const groupEntries = Array.from(missionGroups.entries());
      const listedEntries = groupEntries.slice(0, MAX_LISTED_COURSES);
      const omittedCount = groupEntries.length - listedEntries.length;

      listedEntries.forEach(([missionName, group]) => {
        let scoreDisplay;
        let changeIcon = '';

        const lastEntry = group[group.length - 1];

        // 正答数タイプ(9/10 等)は点数ではないので、そのまま分数表記で出す
        if (lastEntry.questionCount != null) {
          scoreDisplay = `${lastEntry.correctAnswers ?? 0}/${lastEntry.questionCount}`;
        } else if (group.length === 1) {
          // 1回のみ実施
          const mission = group[0];

          if (userChangesMap) {
            const change = userChangesMap.get(mission.name);

            if (change) {
              if (change.type === 'score_change') {
                scoreDisplay = `${change.previousScore}→${change.currentScore}${scoreUnit}`;
                changeIcon = change.scoreChange > 0 ? ' 📈' : ' 📉';
              } else if (change.type === 'new_mission') {
                scoreDisplay = `${change.currentScore}${scoreUnit}（NEW）`;
                changeIcon = ' ✨';
              } else {
                scoreDisplay = `${change.currentScore}${scoreUnit}`;
              }
            } else {
              scoreDisplay = `${mission.score}${scoreUnit}`;
              if (!mission.completed) {
                changeIcon = ' ✨';
              }
            }
          } else {
            scoreDisplay = `${mission.score}${scoreUnit}`;
            if (!mission.completed) {
              changeIcon = ' ✨';
            }
          }
        } else {
          // 複数回実施（最初→最後の点数で表示）
          const firstMission = group[0];
          const lastMission = group[group.length - 1];

          if (firstMission.score !== lastMission.score) {
            scoreDisplay = `${firstMission.score}→${lastMission.score}${scoreUnit}`;
            changeIcon = lastMission.score > firstMission.score ? ' 📈' : ' 📉';
          } else {
            scoreDisplay = `${lastMission.score}${scoreUnit}`;
          }

          // NEWマーク判定（最後の実施が未完了）
          if (!lastMission.completed) {
            changeIcon += ' ✨';
          }
        }

        // 同名グループが全て自主学習のときだけ（自主）を付ける
        const selfStudyMark = group.every(mission => mission.isMission === false) ? '（自主）' : '';

        message += `  ・${missionName}: ${scoreDisplay}${selfStudyMark}${changeIcon}\n`;
      });

      if (omittedCount > 0) {
        message += `  ・ほか${omittedCount}件\n`;
      }
```

- [ ] **Step 7: 既存テストの警告文言アサーションを更新する**

`tests/notifier.test.js` の以下の行を、新しい文言に合わせて機械的に置き換える。
「個」→「件」、小学生の「ミッション完了」→「学習完了」。中学生の「講座完了」は表記そのままで単位だけ「件」にする。

| 行 | 変更前 | 変更後 |
| --- | --- | --- |
| 546 | `/⚠️ ミッション完了 3\/5個/` | `/⚠️ 学習完了 3\/5件/` |
| 554 | `/ミッション完了 \d+\/\d+個/` | `/学習完了 \d+\/\d+件/` |
| 560 | `/ミッション完了 \d+\/\d+個/` | `/学習完了 \d+\/\d+件/` |
| 567 | `/ミッション完了 \d+\/\d+個/` | `/学習完了 \d+\/\d+件/` |
| 570 | テスト名 `「講座完了」表記で警告する` | 変更不要 |
| 584 | `/⚠️ 講座完了 2\/4個/` | `/⚠️ 講座完了 2\/4件/` |
| 586 | `doesNotMatch(message, /ミッション完了/)` | `doesNotMatch(message, /学習完了/)` |
| 604 | `/講座完了 \d+\/\d+個/` | `/講座完了 \d+\/\d+件/` |
| 621 | `/⚠️ 講座完了 1\/4個/` | `/⚠️ 講座完了 1\/4件/` |
| 634 | `/⚠️ ミッション完了 3\/4個/` | `/⚠️ 学習完了 3\/4件/` |
| 646 | `/⚠️ 講座完了 2\/3個/` | `/⚠️ 講座完了 2\/3件/` |
| 663 | `/ミッション完了 3\/4個/` | `/学習完了 3\/4件/` |
| 664 | `/講座完了 2\/3個/` | `/講座完了 2\/3件/` |
| 676 | `/⚠️ 講座完了 2\/3個/` | `/⚠️ 講座完了 2\/3件/` |

634行と663行のテスト名に含まれる「ミッション表記」という語も「学習表記」に直す。

これらのテストのユーザーデータは `missionCount` のみを持ち `studyItemCount` を持たないが、
`countStudyItems` が `missionCount` にフォールバックするため件数の期待値は変わらない。

- [ ] **Step 8: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: PASS

- [ ] **Step 9: 全テストと lint を実行する**

Run: `npm test && npm run lint`
Expected: PASS / エラーなし。`tests/index.test.js` や `tests/morning-index.test.js` が
通知文言のアサーションで失敗する場合も、同じ規則（「個」→「件」、小学生は「学習完了」）で更新する。

- [ ] **Step 10: コミット**

```bash
git add src/notifier.js tests/notifier.test.js tests/index.test.js tests/morning-index.test.js
git commit -m "feat: 通知に学習件数の内訳と自主学習の印を表示する"
```

---

### Task 7: 実機検証とドキュメント更新

DRY_RUN で実サイトを叩き、抽出結果が実際の画面と一致することを確認してから、
CLAUDE.md と DOM構造リファレンスを更新する。

**Files:**
- Modify: `CLAUDE.md`（ストリーク機能の説明）
- Modify: `docs/DOM_STRUCTURE.md`（「現行実装との対応」表）

**Interfaces:**
- Consumes: Task 1〜6 の全実装
- Produces: なし

- [ ] **Step 1: 夜通知をドライラン実行する**

Run: `DRY_RUN=true node -r dotenv/config src/index.js`
Expected:
- 各ユーザーで `📊 今日(MM/DD)の学習件数: N件（ミッションM件）` が出る
- 小学生コースのユーザーで、ミッション数より学習件数が多い日があれば自主学習が検出できている
- 通知プレビューに `✅ 学習N件（ミッション...・自主...）` が出る
- エラーで落ちないこと

- [ ] **Step 2: 抽出結果を実画面と突き合わせる**

みまもるネットにブラウザでログインし、小学生コースのタイムラインで当日の行数を数える。
ドライランの `学習件数` と一致すること、スターアプリ行が件数に含まれていないことを確認する。
一致しない場合は `docs/DOM_STRUCTURE.md` の §2 を見直し、セレクタを調整する。

- [ ] **Step 3: 朝通知をドライラン実行する**

Run: `DRY_RUN=true node -r dotenv/config src/morning-index.js`
Expected: 前日分で同様に学習件数が出て、エラーなく完了すること

- [ ] **Step 4: CLAUDE.md を更新する**

「ストリーク（連続学習日数）機能」セクションの1つ目の箇条書きを以下に置き換える。

```markdown
- 学習判定は完了数のみで行う（勉強時間は見ない）: **小学生コースは学習4件以上、中学生コースは平日3件・土日5件以上の完了講座**が必須（判定対象日の曜日で決まる。祝日は曜日のみで判定）。小学生コースの「学習件数」にはミッションとして配信された講座に加え、**子どもが自主的に取り組んだ講座（ミッションバッジのない行）も含む**。スターアプリはゲーム性が強いため学習に含めない。閾値は `STREAK_REQUIREMENTS`（`src/streak.js`）に集約されており、変更時はここだけ書き換える。中学生の曜日別しきい値は `getJuniorHighRequirement(dateString)` で取得する。学習した日は `streak += 1`、連続10日ごとに「おたすけ」+1（上限3）。**おたすけ満タン(3)中は学習した日ごとに毎日「ボーナスポイント」+1**（満タン中はマイルストーン判定なし。`bonus`フィールド。リセットでも消えず、毎月1日の月次清算通知で0にリセットしてお小遣いとして支給）。月次清算通知ではコース別単価（小学生コース 1P=¥30 / 中学生コース 1P=¥50）で金額に換算し、各ユーザーの金額と全員分の合計を表示する。単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN` に集約されており、変更時はここだけ書き換える。**初期おたすけは1**（初回特典。`streak_data.json` v1.0→v1.1移行で既存ユーザーも最低1に引き上げ）。streak 0 のときは消費せず、リセット後は0から再スタート
```

同セクションの2つ目の箇条書き（警告行の説明）の「コース別に小学生=ミッション表記/中学生=講座表記」を
「コース別に小学生=学習表記/中学生=講座表記」に変える。

「DOM操作パターン」セクションの座標ベースフィルタリングの記述の直後に追加する。

```markdown
- 小学生コースのタイムラインは `[class*="dailyTimeline__"]` の日ブロック単位で構造分離されているため、日付の切り分けに座標計算は不要（中学生コースは `dailyRoot__`）。DOM構造の詳細は `docs/DOM_STRUCTURE.md` を参照する
```

- [ ] **Step 5: DOM構造リファレンスの対応表を更新する**

`docs/DOM_STRUCTURE.md` の §6「現行実装との対応」の表を以下に置き換える。

```markdown
| 現行コード | 本ドキュメントとの関係 |
| --- | --- |
| `src/config/selectors.js` の `elementaryTimeline` | §2 の構造に対応。すべて前方一致セレクタ |
| `src/config/selectors.js` の `juniorHighTimeline` | §3 の構造と一致（確認済み） |
| `src/crawler.js` の `extractElementaryDay()` | §2.1〜2.4。`dailyTimeline__` 単位で日を切り分け、行を分類する |
| `src/crawler.js` の `summarizeStudyRows()` | §2.3 のミッション/自主の分類を集計する純粋関数 |
| `src/streak.js` の `countStudyItems()` | 学習件数（ミッション＋自主）でストリークを判定する |
```

- [ ] **Step 6: 全テストと lint を実行する**

Run: `npm test && npm run lint`
Expected: PASS / エラーなし

- [ ] **Step 7: コミット**

```bash
git add CLAUDE.md docs/DOM_STRUCTURE.md
git commit -m "docs: 自主学習の検出に合わせてストリーク仕様とDOM対応表を更新する"
```

---

## 完了条件

- `npm test` が全て通る
- `npm run lint` がエラーなし
- `DRY_RUN=true node -r dotenv/config src/index.js` で自主学習が検出され、通知プレビューに内訳が出る
- `DRY_RUN=true node -r dotenv/config src/morning-index.js` がエラーなく完了する
- `CLAUDE.md` と `docs/DOM_STRUCTURE.md` が実装と一致している
