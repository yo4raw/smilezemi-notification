# 中学生コース朝7時通知 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中学生コースの学習実績を翌朝 JST 7:00 に前日分として LINE 通知し、既存の JST 20:00 通知を小学生コースのみに変更する。

**Architecture:** 既存 `crawler.js` / `notifier.js` に `courseFilter` / `dateOffset` / フォーマットオプションを追加してパラメータ化し、新エントリ `src/morning-index.js` と新ワークフロー `morning-crawler.yml` から再利用する(スペック: `docs/superpowers/specs/2026-07-10-morning-junior-high-notification-design.md`)。

**Tech Stack:** Node.js >= 24 (CommonJS), Playwright, node:test, GitHub Actions + Docker

## Global Constraints

- 作業ツリーに週間レポート関連の未コミット変更(`src/weekly-report-crawler.js`, `tests/weekly-report-crawler.test.js`, `.serena/project.yml`)が存在する。**コミットには本計画で触るファイルのみを `git add <path>` で明示指定**し、これらを混入させない
- 日付計算は JST 明示(GitHub Actions コンテナは UTC。朝 7:00 JST = 前日 22:00 UTC)
- テストは `node --test tests/` で実行(`npm test`)
- 既存関数のシグネチャ変更は末尾へのオプション引数追加のみ(後方互換維持)
- Markdown・コメント・ログは日本語

---

### Task 1: JST基準の日付計算関数 `getTargetDates`

**Files:**
- Modify: `src/crawler.js:571-585`(`getTodayDate` を置き換え)、`src/crawler.js:1562-1574`(exports)
- Test: `tests/crawler.test.js`(末尾に describe 追加)

**Interfaces:**
- Produces: `getTargetDates(dateOffset = 0)` → `{ withPadding: 'MM/DD', withoutPadding: 'M/D', dateString: 'YYYY-MM-DD' }`(JST基準、exports に追加)

- [ ] **Step 1: 失敗するテストを書く**

`tests/crawler.test.js` の最上位 describe 内の末尾に追加:

```js
  describe('getTargetDates', () => {
    it('UTC 22:00 (JST 翌日7:00) のとき dateOffset=0 で JST の今日を返す', () => {
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-09T22:00:00Z').getTime() });
      try {
        const dates = crawler.getTargetDates(0);
        assert.strictEqual(dates.withPadding, '07/10');
        assert.strictEqual(dates.withoutPadding, '7/10');
        assert.strictEqual(dates.dateString, '2026-07-10');
      } finally {
        mock.timers.reset();
      }
    });

    it('dateOffset=-1 で JST の昨日を返す', () => {
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-09T22:00:00Z').getTime() });
      try {
        const dates = crawler.getTargetDates(-1);
        assert.strictEqual(dates.withPadding, '07/09');
        assert.strictEqual(dates.dateString, '2026-07-09');
      } finally {
        mock.timers.reset();
      }
    });

    it('年跨ぎ: JST 1/1 に dateOffset=-1 で前年 12/31 を返す', () => {
      // UTC 2025-12-31T15:00:00Z = JST 2026-01-01T00:00:00
      mock.timers.enable({ apis: ['Date'], now: new Date('2025-12-31T15:00:00Z').getTime() });
      try {
        const dates = crawler.getTargetDates(-1);
        assert.strictEqual(dates.withPadding, '12/31');
        assert.strictEqual(dates.dateString, '2025-12-31');
      } finally {
        mock.timers.reset();
      }
    });
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/crawler.test.js`
Expected: FAIL(`crawler.getTargetDates is not a function`)

- [ ] **Step 3: 実装**

`src/crawler.js` の `getTodayDate()`(571-585行)を以下に置き換え:

```js
/**
 * 対象日の日付を取得(JST基準、MM/DD形式)
 * GitHub Actions コンテナは UTC のため、ローカル時刻ではなく JST を明示して計算する。
 * @param {number} dateOffset - 0=今日、-1=昨日
 * @returns {{withPadding: string, withoutPadding: string, dateString: string}}
 */
function getTargetDates(dateOffset = 0) {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const target = new Date(Date.now() + JST_OFFSET_MS + dateOffset * 24 * 60 * 60 * 1000);
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth() + 1;
  const day = target.getUTCDate();

  return {
    withPadding: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
    withoutPadding: `${month}/${day}`,
    dateString: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}
```

既存の `getTodayDate()` 呼び出し箇所(`grep -n "getTodayDate()" src/crawler.js` で全件確認)をすべて `getTargetDates(dateOffset)` に置き換える。この時点では各関数はまだ `dateOffset` を持たないため、暫定的に `getTargetDates(0)` とする(Task 3 で引数を貫通させる)。`module.exports` に `getTargetDates` を追加。

- [ ] **Step 4: テストがパスすることを確認**

Run: `node --test tests/crawler.test.js`
Expected: PASS(既存テスト含む全件)

- [ ] **Step 5: コミット**

```bash
git add src/crawler.js tests/crawler.test.js
git commit -m "feat: JST基準の日付計算関数 getTargetDates を追加"
```

---

### Task 2: コース選択判定の純粋関数

**Files:**
- Modify: `src/crawler.js`(`isJuniorHighSchool` の直後に追加)、exports
- Test: `tests/crawler.test.js`

**Interfaces:**
- Produces:
  - `resolveTargetCourses(courseSelection, courseFilter)` → `string[]`(`courseSelection` は `checkCourseSelection` の戻り値 `{hasJuniorHighSchool, hasElementarySchool}`、`courseFilter` は `'elementary' | 'juniorHigh' | null`)
  - `shouldProcessSingleCourseUser(pageUrl, courseFilter)` → `boolean`

- [ ] **Step 1: 失敗するテストを書く**

```js
  describe('resolveTargetCourses', () => {
    it('filterなし: 両コース持ちは中学生コースのみ(現行互換)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: true }, null),
        ['中学生コース']
      );
    });

    it('elementary: 小学生のみのユーザーは小学生コース', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: false, hasElementarySchool: true }, 'elementary'),
        ['小学生コース']
      );
    });

    it('elementary: 両コース持ちはスキップ(空配列)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: true }, 'elementary'),
        []
      );
    });

    it('elementary: 中学生のみはスキップ(空配列)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: false }, 'elementary'),
        []
      );
    });

    it('juniorHigh: 両コース持ちは中学生コース', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: true }, 'juniorHigh'),
        ['中学生コース']
      );
    });

    it('juniorHigh: 小学生のみはスキップ(空配列)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: false, hasElementarySchool: true }, 'juniorHigh'),
        []
      );
    });
  });

  describe('shouldProcessSingleCourseUser', () => {
    const juniorUrl = 'https://smile-zemi.jp/mimamoru-net/ui/study/c/timeline';
    const elementaryUrl = 'https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline';

    it('elementary filter: 中学生タイムラインのユーザーは対象外', () => {
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(juniorUrl, 'elementary'), false);
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(elementaryUrl, 'elementary'), true);
    });

    it('juniorHigh filter: 小学生タイムラインのユーザーは対象外', () => {
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(juniorUrl, 'juniorHigh'), true);
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(elementaryUrl, 'juniorHigh'), false);
    });

    it('filterなし: 常に対象', () => {
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(juniorUrl, null), true);
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(elementaryUrl, null), true);
    });
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/crawler.test.js`
Expected: FAIL(関数未定義)

- [ ] **Step 3: 実装**

`src/crawler.js` の `isJuniorHighSchool` の直後に追加し、`module.exports` にも追加:

```js
/**
 * コース選択画面での取得対象コースを決定する
 * @param {{hasJuniorHighSchool: boolean, hasElementarySchool: boolean}} courseSelection
 * @param {'elementary'|'juniorHigh'|null} courseFilter - null は現行互換(中学生優先)
 * @returns {string[]} 取得対象コース名の配列(対象なしは空配列 = スキップ)
 */
function resolveTargetCourses(courseSelection, courseFilter) {
  if (courseFilter === 'elementary') {
    // 中学生コースを持つユーザー(両コース持ち含む)は朝通知側の対象のためスキップ
    return !courseSelection.hasJuniorHighSchool && courseSelection.hasElementarySchool
      ? ['小学生コース']
      : [];
  }
  if (courseFilter === 'juniorHigh') {
    return courseSelection.hasJuniorHighSchool ? ['中学生コース'] : [];
  }
  // 現行互換: 両コース持ちは中学生コースのみ
  if (courseSelection.hasJuniorHighSchool) return ['中学生コース'];
  if (courseSelection.hasElementarySchool) return ['小学生コース'];
  return [];
}

/**
 * コース選択画面が出ない単一コースユーザーが取得対象かを判定する
 * @param {string} pageUrl - 現在のページURL(/study/c/ = 中学生コース)
 * @param {'elementary'|'juniorHigh'|null} courseFilter
 * @returns {boolean}
 */
function shouldProcessSingleCourseUser(pageUrl, courseFilter) {
  const isJuniorHigh = pageUrl.includes('/study/c/');
  if (courseFilter === 'elementary') return !isJuniorHigh;
  if (courseFilter === 'juniorHigh') return isJuniorHigh;
  return true;
}
```

- [ ] **Step 4: テストがパスすることを確認**

Run: `node --test tests/crawler.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/crawler.js tests/crawler.test.js
git commit -m "feat: コース選択判定の純粋関数を追加"
```

---

### Task 3: `dateOffset` の貫通と `courseFilter` の統合

**Files:**
- Modify: `src/crawler.js` — `findTodayDailyRootForJuniorHigh`, `getStudyTimeForJuniorHigh`, `getTodayMissionCountForJuniorHigh`, `getMissionDetailsForJuniorHigh`, `getTodayMissionCount`, `getStudyTime`, `getMissionDetails`, `getCourseData`, `getAllUsersDetailedData`

**Interfaces:**
- Consumes: Task 1 の `getTargetDates`、Task 2 の `resolveTargetCourses` / `shouldProcessSingleCourseUser`
- Produces: `getAllUsersDetailedData(page, options = {})` — `options = { courseFilter: 'elementary'|'juniorHigh'|null, dateOffset: 0|-1 }`。戻り値は従来同様だが、**対象ユーザー0件かつ失敗なしの場合 `{ success: true, data: [] }`** を返す

- [ ] **Step 1: シグネチャ変更(すべて末尾オプション引数、既定値で現行互換)**

```text
findTodayDailyRootForJuniorHigh(page, dateOffset = 0)
getStudyTimeForJuniorHigh(page, dateOffset = 0)
getTodayMissionCountForJuniorHigh(page, dateOffset = 0)
getMissionDetailsForJuniorHigh(page, dateOffset = 0)
getTodayMissionCount(page, courseName = null, dateOffset = 0)
getStudyTime(page, courseName = null, dateOffset = 0)
getMissionDetails(page, courseName = null, dateOffset = 0)
getCourseData(page, userName, courseName, dateString, dateOffset = 0)
```

各関数内の `getTargetDates(0)`(Task 1 の暫定)を `getTargetDates(dateOffset)` に変更し、委譲呼び出し(中学生版への分岐、`getCourseData` から各getterへ)に `dateOffset` を渡す。

- [ ] **Step 2: `getAllUsersDetailedData` の統合**

シグネチャを `getAllUsersDetailedData(page, options = {})` にし、先頭で分解:

```js
const { courseFilter = null, dateOffset = 0 } = options;
```

日付文字列の生成(現 1369-1370 行)を JST 基準に置き換え:

```js
const dateString = getTargetDates(dateOffset).dateString;
```

コース選択ありの分岐(現 1395-1401 行の courses 構築)を置き換え:

```js
const courses = resolveTargetCourses(courseSelectionResult, courseFilter);

if (courses.length === 0) {
  console.log(`  ℹ️ ${maskName(user.name)} は対象コースがないためスキップします`);
} else {
  for (const courseName of courses) {
    // ...既存のコース選択・getCourseData 呼び出し(dateOffset を追加)...
  }
}
```

コース選択なしの分岐(現 1437-1450 行)を置き換え:

```js
} else {
  if (!shouldProcessSingleCourseUser(page.url(), courseFilter)) {
    console.log(`  ℹ️ ${maskName(user.name)} は対象コースではないためスキップします`);
  } else {
    // ...既存の getCourseData 呼び出し(dateOffset を追加)...
  }
}
```

**注意**: スキップは `continue` ではなく if/else で表現し、ループ末尾の「小学生タイムラインへ戻す goto」(現 1456-1466 行)が必ず実行されるようにする。

末尾の戻り値判定(現 1469-1484 行)を置き換え:

```js
// データ0件でも失敗がなければ「対象ユーザーなし」として成功扱い
if (data.length > 0 || !hasPartialFailure) {
  return {
    success: true,
    data,
    partialFailure: hasPartialFailure,
    detailsAvailable
  };
}

return {
  success: false,
  error: '全てのユーザーのデータ取得に失敗しました。',
  detailsAvailable: false
};
```

- [ ] **Step 3: 既存テストで回帰確認**

Run: `npm test`
Expected: 全テスト PASS(既定値により現行動作が維持されるため)

- [ ] **Step 4: コミット**

```bash
git add src/crawler.js
git commit -m "feat: crawler に courseFilter と dateOffset オプションを追加"
```

---

### Task 4: 通知フォーマットの朝バリエーション

**Files:**
- Modify: `src/notifier.js:250-368`(`formatDetailedMessage`)
- Test: `tests/notifier.test.js`

**Interfaces:**
- Produces: `formatDetailedMessage(userData, missionChanges = null, options = {})` — `options = { dateLabel: string|null, showNoStudyWarning: boolean }`
  - `dateLabel: '昨日(07/09)'` → ヘッダが `📊 スマイルゼミ 昨日(07/09)の学習状況`
  - `showNoStudyWarning: true` かつ 勉強時間 0:00 かつ講座 0 件のユーザーに `⚠️ 昨日は学習していません` を表示(詳細セクションは出さない)

- [ ] **Step 1: 失敗するテストを書く**

`tests/notifier.test.js` に追加:

```js
  describe('formatDetailedMessage - 朝通知オプション', () => {
    const { formatDetailedMessage } = require('../src/notifier');

    it('dateLabel 指定でヘッダに日付ラベルが入る', () => {
      const userData = [{
        userName: '光志郎 (中学生コース)',
        missionCount: 1,
        date: '2026-07-09',
        studyTime: { hours: 1, minutes: 5 },
        totalScore: 80,
        missions: [{ name: '数学: 一次関数', score: 80, completed: true }]
      }];
      const message = formatDetailedMessage(userData, null, { dateLabel: '昨日(07/09)' });
      assert.ok(message.startsWith('📊 スマイルゼミ 昨日(07/09)の学習状況'));
      assert.ok(message.includes('⏱️ 勉強時間: 01:05'));
    });

    it('showNoStudyWarning: 未学習ユーザーに警告文言を表示し詳細セクションを出さない', () => {
      const userData = [{
        userName: '光志郎 (中学生コース)',
        missionCount: 0,
        date: '2026-07-09',
        studyTime: { hours: 0, minutes: 0 },
        totalScore: 0,
        missions: []
      }];
      const message = formatDetailedMessage(userData, null, {
        dateLabel: '昨日(07/09)',
        showNoStudyWarning: true
      });
      assert.ok(message.includes('⚠️ 昨日は学習していません'));
      assert.ok(!message.includes('学習詳細'));
    });

    it('showNoStudyWarning でも学習ありのユーザーには警告を出さない', () => {
      const userData = [{
        userName: '光志郎 (中学生コース)',
        missionCount: 1,
        date: '2026-07-09',
        studyTime: { hours: 0, minutes: 30 },
        totalScore: 90,
        missions: [{ name: '英語: 不定詞', score: 90, completed: true }]
      }];
      const message = formatDetailedMessage(userData, null, { showNoStudyWarning: true });
      assert.ok(!message.includes('⚠️ 昨日は学習していません'));
      assert.ok(message.includes('英語: 不定詞'));
    });

    it('データ0件のとき dateLabel 付きの文言を返す', () => {
      const message = formatDetailedMessage([], null, { dateLabel: '昨日(07/09)' });
      assert.ok(message.includes('昨日(07/09)のデータはありません。'));
    });

    it('オプション省略時は従来フォーマットのまま', () => {
      const message = formatDetailedMessage([], null);
      assert.ok(message.startsWith('📊 スマイルゼミ 学習状況'));
      assert.ok(message.includes('本日のデータはありません。'));
    });
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/notifier.test.js`
Expected: FAIL(ヘッダに日付ラベルが入らない等)

- [ ] **Step 3: 実装**

`formatDetailedMessage` を修正:

```js
function formatDetailedMessage(userData, missionChanges = null, options = {}) {
  const { dateLabel = null, showNoStudyWarning = false } = options;

  // ヘッダー
  let message = dateLabel
    ? `📊 スマイルゼミ ${dateLabel}の学習状況\n\n`
    : '📊 スマイルゼミ 学習状況\n\n';

  // データがない場合
  if (!userData || userData.length === 0) {
    message += dateLabel ? `${dateLabel}のデータはありません。` : '本日のデータはありません。';
    return message.trim();
  }
  // ...(以降は既存のまま)
```

各ユーザーのループ内、勉強時間の行の直後に未学習判定を追加し、詳細セクションを if/else if/else に再構成:

```js
    const missions = user.missions ?? [];
    const isNoStudy = hours === 0 && minutes === 0 && missions.length === 0;

    if (showNoStudyWarning && isNoStudy) {
      message += '⚠️ 昨日は学習していません\n';
    } else if (missions.length > 0) {
      // ...既存のミッション詳細表示...
    } else {
      message += `\n📋 ${detailLabel}なし\n`;
    }
```

(既存の `const missions = user.missions ?? [];` は上に移動するため重複定義しない)

- [ ] **Step 4: テストがパスすることを確認**

Run: `node --test tests/notifier.test.js`
Expected: PASS(既存テスト含む)

- [ ] **Step 5: コミット**

```bash
git add src/notifier.js tests/notifier.test.js
git commit -m "feat: 通知フォーマットに朝通知オプションを追加"
```

---

### Task 5: 20:00 実行を小学生コースのみに変更

**Files:**
- Modify: `src/index.js:121`(クロール呼び出し)、`src/index.js:191-200` 付近(0件スキップ)

**Interfaces:**
- Consumes: Task 3 の `getAllUsersDetailedData(page, { courseFilter })`

- [ ] **Step 1: 実装**

`src/index.js:121` を変更:

```js
    const crawlResult = await getAllUsersDetailedData(page, { courseFilter: 'elementary' });
```

`const currentData = crawlResult.data;`(現 191 行)の直後に追加:

```js
    // 対象ユーザーが0件(全員中学生コース等)の場合は通知せず正常終了
    if (currentData.length === 0) {
      console.log('ℹ️ 小学生コースの対象ユーザーがいないため、通知をスキップして終了します');
      return { success: true, exitCode: 0 };
    }
```

- [ ] **Step 2: 回帰確認**

Run: `npm test`
Expected: 全テスト PASS

- [ ] **Step 3: コミット**

```bash
git add src/index.js
git commit -m "feat: 20:00通知を小学生コースのみに変更"
```

---

### Task 6: 朝通知エントリポイント `src/morning-index.js`

**Files:**
- Create: `src/morning-index.js`
- Test: `tests/morning-index.test.js`

**Interfaces:**
- Consumes: `getAllUsersDetailedData(page, { courseFilter: 'juniorHigh', dateOffset: -1 })`、`getTargetDates(-1)`、`formatDetailedMessage(data, null, { dateLabel, showNoStudyWarning: true })`、`truncateToLimit`、`login`、`loadConfig`
- Produces: `main()` → `Promise<{success: boolean, exitCode: number, error?: string}>`(module.exports)

- [ ] **Step 1: 失敗するテストを書く**

`tests/morning-index.test.js` を新規作成:

```js
/**
 * 朝通知エントリポイントのテスト
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('朝通知エントリポイント (src/morning-index.js)', () => {
  it('main 関数をエクスポートしている', () => {
    const morningIndex = require('../src/morning-index');
    assert.strictEqual(typeof morningIndex.main, 'function');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/morning-index.test.js`
Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/morning-index.js` を新規作成(`weekly-report-index.js` と同構成):

```js
/**
 * 朝通知 - メイン実行フロー
 * 毎朝 JST 7:00 に中学生コースの前日学習実績を LINE に通知する。
 * 前日は確定データのため差分比較・mission_data.json への保存は行わない。
 */

const { chromium } = require('playwright');
const { loadConfig } = require('./config');
const { login } = require('./auth');
const { getAllUsersDetailedData, getTargetDates } = require('./crawler');
const { formatDetailedMessage, truncateToLimit } = require('./notifier');
const fs = require('fs').promises;
const path = require('path');

/**
 * メイン実行関数
 *
 * @returns {Promise<{success: boolean, exitCode: number, error?: string}>}
 */
async function main() {
  let browser;
  let context;
  let page;
  const errors = [];

  try {
    console.log('🚀 スマイルゼミ 朝通知(中学生コース・前日分) 開始');

    // 1. 環境変数の読み込みとバリデーション
    console.log('📋 設定を読み込んでいます...');
    let config;
    try {
      config = loadConfig();
      console.log('✅ 設定の読み込みが完了しました');
    } catch (error) {
      console.error('❌ 設定の読み込みに失敗しました:', error.message);
      return { success: false, exitCode: 1, error: error.message };
    }

    // 2. Playwrightブラウザの起動
    console.log('🌐 ブラウザを起動しています...');
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
      console.log('✅ ブラウザの起動が完了しました');
    } catch (error) {
      console.error('❌ ブラウザの起動に失敗しました:', error.message);
      return { success: false, exitCode: 1, error: `ブラウザ起動エラー: ${error.message}` };
    }

    // 3. 認証(ログイン)
    console.log('🔐 ログインしています...');
    const loginResult = await login(browser, {
      username: config.SMILEZEMI_USERNAME,
      password: config.SMILEZEMI_PASSWORD
    });

    if (!loginResult.success) {
      console.error('❌ ログインに失敗しました:', loginResult.error);
      return { success: false, exitCode: 1, error: loginResult.error };
    }

    page = loginResult.page;
    context = loginResult.context;
    console.log('✅ ログインが完了しました');

    // 4. 中学生コースの前日分データを取得
    const targetDates = getTargetDates(-1);
    console.log(`🔍 前日(${targetDates.withPadding})の中学生コースデータを取得しています...`);
    const crawlResult = await getAllUsersDetailedData(page, {
      courseFilter: 'juniorHigh',
      dateOffset: -1
    });

    if (!crawlResult.success) {
      console.error('❌ クローリングに失敗しました:', crawlResult.error);
      await saveErrorScreenshot(page, 'morning-crawling-failed');
      return { success: false, exitCode: 1, error: crawlResult.error };
    }

    if (crawlResult.partialFailure) {
      console.warn('⚠️ 一部のデータ取得に失敗しました');
    }

    // 対象ユーザーがいない場合は通知せず正常終了
    if (crawlResult.data.length === 0) {
      console.log('ℹ️ 中学生コースの対象ユーザーがいないため、通知をスキップして終了します');
      return { success: true, exitCode: 0 };
    }

    console.log(`✅ データの取得が完了しました(${crawlResult.data.length}件)`);

    // 5. メッセージフォーマット(前日は確定データのため差分比較なし)
    let message = formatDetailedMessage(crawlResult.data, null, {
      dateLabel: `昨日(${targetDates.withPadding})`,
      showNoStudyWarning: true
    });
    message = truncateToLimit(message);

    // ドライラン: DRY_RUN=true の場合はメッセージを表示して送信しない
    if (process.env.DRY_RUN === 'true') {
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(message);
      console.log('=== プレビュー終了 ===\n');
      console.log('ℹ️ ドライランモード: LINE通知はスキップしました');
      console.log('🎉 処理が正常に完了しました');
      return { success: true, exitCode: 0 };
    }

    // 6. LINE API 送信
    console.log('📤 LINE通知を送信しています...');
    const requestBody = {
      to: config.LINE_USER_ID,
      messages: [
        {
          type: 'text',
          text: message
        }
      ]
    };

    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ LINE通知の送信に失敗しました:', response.status, errorText);
        errors.push(`LINE API エラー: ${response.status}`);
      } else {
        console.log('✅ 朝通知のLINE送信が完了しました');
      }
    } catch (notifyError) {
      console.error('❌ LINE通知の送信に失敗しました:', notifyError.message);
      errors.push(notifyError.message);
    }

    // 7. 完了
    console.log('🎉 処理が正常に完了しました');

    return {
      success: errors.length === 0,
      exitCode: errors.length === 0 ? 0 : 1,
      errors: errors.length > 0 ? errors : undefined
    };

  } catch (error) {
    console.error('❌ 予期しないエラーが発生しました:', error);
    errors.push(error.message);

    if (page) {
      await saveErrorScreenshot(page, 'morning-unexpected-error');
    }

    return { success: false, exitCode: 1, error: error.message, errors };

  } finally {
    console.log('🧹 ブラウザを終了しています...');
    try {
      if (context) {
        await context.close();
      }
      if (browser) {
        await browser.close();
      }
      console.log('✅ ブラウザの終了が完了しました');
    } catch (error) {
      console.error('⚠️ ブラウザの終了に失敗しました:', error.message);
    }
  }
}

/**
 * エラー時のスクリーンショット保存
 * @private
 */
async function saveErrorScreenshot(page, errorType) {
  try {
    const screenshotsDir = path.join(__dirname, '../screenshots');
    await fs.mkdir(screenshotsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${errorType}-${timestamp}.png`;
    const filepath = path.join(screenshotsDir, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`📸 スクリーンショットを保存しました: ${filename}`);
  } catch (error) {
    console.error('⚠️ スクリーンショットの保存に失敗しました:', error.message);
  }
}

// CLIから直接実行された場合
if (require.main === module) {
  main()
    .then(result => {
      process.exit(result.exitCode);
    })
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = {
  main
};
```

- [ ] **Step 4: テストがパスすることを確認**

Run: `node --test tests/morning-index.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/morning-index.js tests/morning-index.test.js
git commit -m "feat: 朝通知エントリポイントを追加"
```

---

### Task 7: 朝通知ワークフロー

**Files:**
- Create: `.github/workflows/morning-crawler.yml`

**Interfaces:**
- Consumes: `src/morning-index.js`(docker compose 経由)

- [ ] **Step 1: 実装**

`.github/workflows/morning-crawler.yml` を新規作成:

```yaml
name: スマイルゼミ 朝通知(中学生コース・前日分)

on:
  # 毎日 UTC 17:47 (JST 2:47) に起動し、ワークフロー内で JST 7:00 まで待機してから実行する。
  # GitHub Actions の schedule は数時間遅延することがあるため(実測 1〜5.5時間)、
  # 前倒しで起動して目標時刻まで sleep する方式を採用(crawler.yml と同方式)。
  # 毎時0分は混雑のため遅延が最大化しやすく、意図的に避けている。
  schedule:
    - cron: '47 17 * * *'

  # 手動実行をサポート
  workflow_dispatch:

jobs:
  morning-notify:
    runs-on: ubuntu-latest
    # JST 7:00 までの最大待機 約253分 + ビルド/実行時間の余裕
    timeout-minutes: 300

    steps:
      # 1. リポジトリのチェックアウト
      - name: リポジトリをチェックアウト
        uses: actions/checkout@v4

      # 2. .envファイルを作成
      - name: .envファイルを作成
        run: |
          echo "SMILEZEMI_USERNAME=${{ secrets.SMILEZEMI_USERNAME }}" >> .env
          echo "SMILEZEMI_PASSWORD=${{ secrets.SMILEZEMI_PASSWORD }}" >> .env
          echo "LINE_CHANNEL_ACCESS_TOKEN=${{ secrets.LINE_CHANNEL_ACCESS_TOKEN }}" >> .env
          echo "LINE_USER_ID=${{ secrets.LINE_USER_ID }}" >> .env

      # 3. 環境変数の検証
      - name: 環境変数を検証
        run: |
          echo "環境変数の検証中..."
          if [ -z "${{ secrets.SMILEZEMI_USERNAME }}" ]; then
            echo "❌ SMILEZEMI_USERNAME が設定されていません"
            exit 1
          fi
          if [ -z "${{ secrets.SMILEZEMI_PASSWORD }}" ]; then
            echo "❌ SMILEZEMI_PASSWORD が設定されていません"
            exit 1
          fi
          if [ -z "${{ secrets.LINE_CHANNEL_ACCESS_TOKEN }}" ]; then
            echo "❌ LINE_CHANNEL_ACCESS_TOKEN が設定されていません"
            exit 1
          fi
          if [ -z "${{ secrets.LINE_USER_ID }}" ]; then
            echo "❌ LINE_USER_ID が設定されていません"
            exit 1
          fi
          echo "✅ 全ての環境変数が設定されています"

      # 4. Dockerイメージをビルド
      - name: Dockerイメージをビルド
        run: docker compose build

      # 5. JST 7:00 まで待機(スケジュール実行時のみ)
      #    cron 起動が遅延して既に 7:00 を過ぎている場合は即実行する
      #    (前日分を取得するため、多少遅れても通知内容は正しい)
      - name: JST 7:00まで待機
        if: github.event_name == 'schedule'
        run: |
          target=$(TZ=Asia/Tokyo date -d "today 07:00" +%s)
          now=$(date +%s)
          wait_sec=$(( target - now ))
          if [ "$wait_sec" -gt 0 ]; then
            echo "JST 7:00まで ${wait_sec} 秒待機します"
            sleep "$wait_sec"
          else
            echo "既にJST 7:00を過ぎているため即実行します"
          fi

      # 6. 朝通知を実行
      - name: 朝通知を実行
        run: docker compose run --rm crawler node src/morning-index.js

      # 7. スクリーンショットをアーティファクトとして保存(常に実行)
      - name: スクリーンショットを保存
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: morning-screenshots-${{ github.run_number }}
          path: screenshots/
          retention-days: 90
          if-no-files-found: ignore

      # 8. .envファイルを削除(セキュリティ対策)
      - name: .envファイルを削除
        if: always()
        run: rm -f .env
```

- [ ] **Step 2: YAML構文チェック**

Run: `node -e "const yaml=require('js-yaml')" 2>/dev/null || docker compose config >/dev/null 2>&1; ruby -ryaml -e "YAML.load_file('.github/workflows/morning-crawler.yml'); puts 'OK'" 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/morning-crawler.yml')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: コミット**

```bash
git add .github/workflows/morning-crawler.yml
git commit -m "feat: 朝通知ワークフローを追加"
```

---

### Task 8: ドキュメント更新と全体検証

**Files:**
- Modify: `CLAUDE.md`(Two Entry Points → Three、Project Structure、Workflows)

**Interfaces:**
- Consumes: Task 1〜7 の成果物

- [ ] **Step 1: CLAUDE.md 更新**

「Two Entry Points」セクションを「Three Entry Points」に変更し、以下の内容にする:

```markdown
### Three Entry Points

1. **日次通知** (`src/index.js`): 毎日 JST 20:00 に実行。小学生コースの勉強時間・ミッション詳細・点数を取得しLINE通知
2. **朝通知** (`src/morning-index.js`): 毎日 JST 7:00 に実行。中学生コースの前日分学習実績を取得しLINE通知(0件でも必ず通知)
3. **週間レポート** (`src/weekly-report-index.js`): 毎週月曜 JST 17:00 に実行。週間学習ガイダンスレポートを取得しLINE通知
```

Workflows セクションに追記:

```markdown
- `.github/workflows/morning-crawler.yml` → `docker compose run --rm crawler node src/morning-index.js`
```

Project Structure の `src/` に `morning-index.js`、`.github/workflows/` に `morning-crawler.yml`、`tests/` に `morning-index.test.js` を追記。

- [ ] **Step 2: 全テスト実行**

Run: `npm test`
Expected: 全テスト PASS

- [ ] **Step 3: DRY_RUN での動作確認(ローカルに .env がある場合)**

Run: `DRY_RUN=true node src/morning-index.js`
Expected: 実サイトにログインし、前日分の中学生コースデータを取得、通知メッセージのプレビューが表示され、LINE送信はスキップされる

- [ ] **Step 4: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: 朝通知エントリポイントをドキュメントに追記"
```

---

### Task 9: リリース

- [ ] **Step 1: ブランチを push し PR を作成**

```bash
git push -u origin feature/morning-junior-high-notification
gh pr create --title "feat: 中学生コースの朝7時通知(前日分)を追加" --body "..."
```

- [ ] **Step 2: PR をマージ**(ユーザー指示「リリースまでしてください」に基づく)

```bash
gh pr merge --squash --delete-branch=false
```

- [ ] **Step 3: マージ後、workflow_dispatch で morning-crawler.yml を手動実行して本番確認**

```bash
gh workflow run morning-crawler.yml
gh run watch
```
