# 連続学習日数(ストリーク)通知機能 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 日次LINE通知にDuolingo方式の連続学習日数(ストリーク)と「おたすけ(猶予)」を表示する。

**Architecture:** 純粋関数中心の新モジュール `src/streak.js` がストリーク判定と表示文字列生成を担い、状態は `data/streak_data.json` に保存する。夜通知(`src/index.js`)は前日分を追加クロールして確定判定+当日分を暫定表示、朝通知(`src/morning-index.js`)は取得済みの前日分データでそのまま確定判定する。GitHub Actions 間の状態引き継ぎは actions/cache で `data/` ディレクトリごと永続化する。

**Tech Stack:** Node.js (CommonJS), Node.js built-in test runner (`node --test`), Playwright(既存クローラー再利用), GitHub Actions (actions/cache)

**Spec:** `docs/superpowers/specs/2026-07-13-streak-notification-design.md`

## Global Constraints

- モジュール形式は CommonJS (`require`/`module.exports`)。新規依存パッケージは追加しない
- テストは `npm test` (`node --test --test-force-exit --experimental-test-isolation=none tests/*.test.js`) で実行
- コード内コメント・ログメッセージ・テスト名はすべて日本語
- 既存の関数戻り値パターン `{success: boolean, data?/error?}` に従う
- 日付は JST 基準の `YYYY-MM-DD` 文字列(`getTargetDates()` の `dateString`)で扱う
- おたすけ上限は 3、マイルストーン間隔は 10 日
- `data/` は `.gitignore` 済み。`streak_data.json` もコミットしない

## ストリーク更新ルール(仕様の要約)

- 学習判定: 「勉強時間 0 かつ ミッション 0 件」= 未学習
- 学習した日: `streak += 1`。streak が 10 の倍数に到達し、かつ grace < 3 なら `grace += 1`(milestone)
- 未学習の日: `grace > 0` なら `grace -= 1` で streak 維持(+1しない、grace_used)。`grace === 0` なら streak/grace とも 0 にリセット(reset)
- 判定済み日付(`lastConfirmedDate` 以前)は再判定しない(冪等)
- 空白日(前回確定日と判定対象日の間の未判定日)は中立扱い: 何も変化させず、対象日のみ判定する

---

### Task 1: src/streak.js — 判定ロジック(confirmDay / isStudied)

**Files:**
- Create: `src/streak.js`
- Create: `tests/streak.test.js`

**Interfaces:**
- Consumes: なし(純粋関数のみ)
- Produces:
  - `createInitialState() → {streak: 0, grace: 0, lastConfirmedDate: null}`
  - `isStudied(user) → boolean` — user は v2.0 形式(`studyTime: {hours, minutes}`, `missions: []`)。フィールド欠落は未学習扱い
  - `confirmDay(state, dateString, studied) → {state, event}` — event は `'milestone' | 'grace_used' | 'reset' | 'none'`。純粋関数(引数を変更しない)

- [ ] **Step 1: 失敗するテストを書く**

`tests/streak.test.js` を新規作成:

```js
/**
 * ストリーク管理モジュールのテスト
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  createInitialState,
  isStudied,
  confirmDay
} = require('../src/streak');

describe('isStudied', () => {
  it('勉強時間もミッションもない場合は未学習', () => {
    assert.strictEqual(isStudied({ studyTime: { hours: 0, minutes: 0 }, missions: [] }), false);
  });

  it('勉強時間があれば学習済み', () => {
    assert.strictEqual(isStudied({ studyTime: { hours: 0, minutes: 5 }, missions: [] }), true);
  });

  it('ミッションがあれば学習済み', () => {
    assert.strictEqual(
      isStudied({ studyTime: { hours: 0, minutes: 0 }, missions: [{ name: '算数', score: 80, completed: true }] }),
      true
    );
  });

  it('studyTime / missions が欠けていても未学習として扱える', () => {
    assert.strictEqual(isStudied({}), false);
  });
});

describe('confirmDay', () => {
  it('学習した日はストリークが+1される', () => {
    const { state, event } = confirmDay(createInitialState(), '2026-07-12', true);
    assert.deepStrictEqual(state, { streak: 1, grace: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'none');
  });

  it('10日到達でおたすけ+1(milestone)', () => {
    const { state, event } = confirmDay(
      { streak: 9, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 10);
    assert.strictEqual(state.grace, 1);
    assert.strictEqual(event, 'milestone');
  });

  it('20日到達でもおたすけ+1', () => {
    const { state, event } = confirmDay(
      { streak: 19, grace: 1, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.grace, 2);
    assert.strictEqual(event, 'milestone');
  });

  it('おたすけは上限3を超えない(milestoneイベントも発生しない)', () => {
    const { state, event } = confirmDay(
      { streak: 39, grace: 3, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 40);
    assert.strictEqual(state.grace, 3);
    assert.strictEqual(event, 'none');
  });

  it('未学習でもおたすけがあれば消費してストリーク維持(+1されない)', () => {
    const { state, event } = confirmDay(
      { streak: 12, grace: 2, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.deepStrictEqual(state, { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'grace_used');
  });

  it('未学習でおたすけがなければストリークもおたすけも0にリセット', () => {
    const { state, event } = confirmDay(
      { streak: 12, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.deepStrictEqual(state, { streak: 0, grace: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'reset');
  });

  it('ストリーク0で未学習の場合はresetイベントを出さない', () => {
    const { state, event } = confirmDay(
      { streak: 0, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.strictEqual(state.streak, 0);
    assert.strictEqual(event, 'none');
  });

  it('判定済みの日付は再判定しない(冪等)', () => {
    const before = { streak: 5, grace: 1, lastConfirmedDate: '2026-07-12' };
    const { state, event } = confirmDay(before, '2026-07-12', true);
    assert.deepStrictEqual(state, before);
    assert.strictEqual(event, 'none');
  });

  it('過去の日付も再判定しない', () => {
    const before = { streak: 5, grace: 1, lastConfirmedDate: '2026-07-12' };
    const { state, event } = confirmDay(before, '2026-07-10', true);
    assert.deepStrictEqual(state, before);
    assert.strictEqual(event, 'none');
  });

  it('空白日(前回確定日から日が飛んでいる)は中立扱いで、対象日のみ判定される', () => {
    // 07-08 まで確定 → 07-09〜07-11 はCI障害等で未判定 → 07-12 を判定
    const { state } = confirmDay(
      { streak: 5, grace: 1, lastConfirmedDate: '2026-07-08' }, '2026-07-12', true
    );
    assert.deepStrictEqual(state, { streak: 6, grace: 1, lastConfirmedDate: '2026-07-12' });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: FAIL (`Cannot find module '../src/streak'`)

- [ ] **Step 3: 最小実装を書く**

`src/streak.js` を新規作成:

```js
/**
 * ストリーク(連続学習日数)管理モジュール
 *
 * データ構造 (data/streak_data.json):
 * {
 *   version: "1.0",
 *   timestamp: "ISO 8601",
 *   users: {
 *     "ユーザー名 (コース名)": {
 *       streak: number,                 // 確定済み連続学習日数
 *       grace: number,                  // おたすけ残数 (0〜3)
 *       lastConfirmedDate: string|null  // 最後に確定判定した日 (YYYY-MM-DD, JST)
 *     }
 *   }
 * }
 */

const GRACE_MAX = 3;
const MILESTONE_INTERVAL = 10;

/**
 * ストリーク状態の初期値を生成
 */
function createInitialState() {
  return { streak: 0, grace: 0, lastConfirmedDate: null };
}

/**
 * その日に学習したかを判定(notifier.js の未学習判定と同一基準)
 *
 * @param {{studyTime?: {hours: number, minutes: number}, missions?: Array}} user - v2.0形式のユーザーデータ
 * @returns {boolean}
 */
function isStudied(user) {
  const hours = user.studyTime?.hours ?? 0;
  const minutes = user.studyTime?.minutes ?? 0;
  const missions = user.missions ?? [];
  return !(hours === 0 && minutes === 0 && missions.length === 0);
}

/**
 * 1日分の確定判定(純粋関数)
 * - 判定済みの日付以前はスキップ(同日再実行の冪等性)
 * - 空白日(前回確定日との間の未判定日)は中立扱い: 対象日のみ判定する
 *
 * @param {{streak: number, grace: number, lastConfirmedDate: string|null}} state
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @param {boolean} studied - 対象日に学習したか
 * @returns {{state: object, event: 'milestone'|'grace_used'|'reset'|'none'}}
 */
function confirmDay(state, dateString, studied) {
  // YYYY-MM-DD 形式は辞書順比較 = 日付順比較
  if (state.lastConfirmedDate && dateString <= state.lastConfirmedDate) {
    return { state, event: 'none' };
  }

  if (studied) {
    const streak = state.streak + 1;
    const isMilestone = streak % MILESTONE_INTERVAL === 0 && state.grace < GRACE_MAX;
    return {
      state: {
        streak,
        grace: isMilestone ? state.grace + 1 : state.grace,
        lastConfirmedDate: dateString
      },
      event: isMilestone ? 'milestone' : 'none'
    };
  }

  if (state.grace > 0) {
    return {
      state: {
        streak: state.streak,
        grace: state.grace - 1,
        lastConfirmedDate: dateString
      },
      event: 'grace_used'
    };
  }

  return {
    state: { streak: 0, grace: 0, lastConfirmedDate: dateString },
    event: state.streak > 0 ? 'reset' : 'none'
  };
}

module.exports = {
  createInitialState,
  isStudied,
  confirmDay
};
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: PASS (全テスト成功)

- [ ] **Step 5: コミット**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: ストリーク判定ロジック(confirmDay/isStudied)を追加"
```

---

### Task 2: src/streak.js — データ永続化(loadStreakData / saveStreakData)

**Files:**
- Modify: `src/streak.js`
- Modify: `tests/streak.test.js`

**Interfaces:**
- Consumes: Task 1 の `src/streak.js`
- Produces:
  - `loadStreakData() → Promise<{success: boolean, data?: object, error?: string}>` — `data` は userName → state のマップ。ファイルなしは `{success: true, data: {}}`
  - `saveStreakData(streakUsers) → Promise<{success: boolean, error?: string}>` — `{version: '1.0', timestamp, users: streakUsers}` を `data/streak_data.json` に書き込む

- [ ] **Step 1: 失敗するテストを書く**

`tests/streak.test.js` の先頭の require 部分を以下に変更:

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');

const {
  createInitialState,
  isStudied,
  confirmDay,
  loadStreakData,
  saveStreakData
} = require('../src/streak');

const DATA_DIR = path.join(__dirname, '../data');
const STREAK_FILE = path.join(DATA_DIR, 'streak_data.json');
```

ファイル末尾に以下の describe ブロックを追加(`tests/data.test.js` と同じ実ファイルI/Oパターン):

```js
describe('loadStreakData / saveStreakData', () => {
  beforeEach(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.unlink(STREAK_FILE);
    } catch (e) {
      // ファイルなしは無視
    }
  });

  afterEach(async () => {
    try {
      await fs.unlink(STREAK_FILE);
    } catch (e) {
      // ファイルなしは無視
    }
  });

  it('ファイルが存在しない場合は空のマップを返す(初回実行)', async () => {
    const result = await loadStreakData();
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, {});
  });

  it('保存したデータを読み込める(ラウンドトリップ)', async () => {
    const users = {
      '光志郎 (中学生コース)': { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' }
    };
    const saveResult = await saveStreakData(users);
    assert.strictEqual(saveResult.success, true);

    const loadResult = await loadStreakData();
    assert.strictEqual(loadResult.success, true);
    assert.deepStrictEqual(loadResult.data, users);
  });

  it('保存ファイルに version と ISO 8601 timestamp が含まれる', async () => {
    await saveStreakData({});
    const content = JSON.parse(await fs.readFile(STREAK_FILE, 'utf-8'));
    assert.strictEqual(content.version, '1.0');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(content.timestamp));
  });

  it('不正なJSONの場合はエラーを返す', async () => {
    await fs.writeFile(STREAK_FILE, '{invalid json', 'utf-8');
    const result = await loadStreakData();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('JSONパースエラー'));
  });

  it('未知のバージョンはエラーを返す', async () => {
    await fs.writeFile(STREAK_FILE, JSON.stringify({ version: '9.9', users: {} }), 'utf-8');
    const result = await loadStreakData();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('未知のストリークデータバージョン'));
  });

  it('配列を渡すと保存エラーになる', async () => {
    const result = await saveStreakData([]);
    assert.strictEqual(result.success, false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: FAIL (`loadStreakData is not a function`)

- [ ] **Step 3: 実装を書く**

`src/streak.js` の冒頭(定数定義の前)に追加:

```js
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const STREAK_FILE = path.join(DATA_DIR, 'streak_data.json');
```

`confirmDay` の後に以下を追加(`src/data.js` の `loadPreviousData`/`saveData` と同じパターン):

```js
/**
 * ストリークデータを読み込む
 *
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function loadStreakData() {
  try {
    try {
      await fs.access(STREAK_FILE);
    } catch (error) {
      // ファイルが存在しない場合(初回実行時)は空のマップを返す
      return { success: true, data: {} };
    }

    const fileContent = await fs.readFile(STREAK_FILE, 'utf-8');
    const jsonData = JSON.parse(fileContent);

    const version = jsonData.version || '1.0';
    if (version !== '1.0') {
      return {
        success: false,
        error: `未知のストリークデータバージョン: ${version}`
      };
    }

    return { success: true, data: jsonData.users || {} };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { success: false, error: `JSONパースエラー: ${error.message}` };
    }
    return { success: false, error: `ストリークデータ読み込みエラー: ${error.message}` };
  }
}

/**
 * ストリークデータを保存する
 *
 * @param {object} streakUsers - userName → state のマップ
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveStreakData(streakUsers) {
  try {
    if (typeof streakUsers !== 'object' || streakUsers === null || Array.isArray(streakUsers)) {
      return {
        success: false,
        error: '不正なデータ形式: オブジェクトである必要があります'
      };
    }

    await fs.mkdir(DATA_DIR, { recursive: true });

    const saveObject = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      users: streakUsers
    };

    await fs.writeFile(STREAK_FILE, JSON.stringify(saveObject, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: `ストリークデータ保存エラー: ${error.message}` };
  }
}
```

`module.exports` を更新:

```js
module.exports = {
  createInitialState,
  isStudied,
  confirmDay,
  loadStreakData,
  saveStreakData
};
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: PASS (全テスト成功)

- [ ] **Step 5: コミット**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: ストリークデータの読み込み・保存を追加"
```

---

### Task 3: src/streak.js — 一括更新と表示生成(updateStreaks / formatStreakInfo)

**Files:**
- Modify: `src/streak.js`
- Modify: `tests/streak.test.js`

**Interfaces:**
- Consumes: Task 1 の `confirmDay` / `isStudied` / `createInitialState`
- Produces:
  - `updateStreaks(streakUsers, users, dateString) → {streakUsers: object, results: Array<{userName: string, state: object, event: string}>}` — 純粋関数。入力マップを変更しない
  - `formatStreakInfo(result, options?) → string` — `result` は results の要素。`options.todayStudied: boolean`(夜通知の暫定+1表示用)。改行区切りの表示行を返す

- [ ] **Step 1: 失敗するテストを書く**

`tests/streak.test.js` の require に `updateStreaks, formatStreakInfo` を追加し、ファイル末尾に以下を追加:

```js
describe('updateStreaks', () => {
  const studiedUser = {
    userName: '光志郎 (中学生コース)',
    studyTime: { hours: 0, minutes: 45 },
    missions: [{ name: '数学', score: 80, completed: true }]
  };
  const notStudiedUser = {
    userName: '祥吾 (小学生コース)',
    studyTime: { hours: 0, minutes: 0 },
    missions: []
  };

  it('複数ユーザーをそれぞれ独立に判定する', () => {
    const { streakUsers, results } = updateStreaks({}, [studiedUser, notStudiedUser], '2026-07-12');
    assert.strictEqual(streakUsers['光志郎 (中学生コース)'].streak, 1);
    assert.strictEqual(streakUsers['祥吾 (小学生コース)'].streak, 0);
    assert.strictEqual(results.length, 2);
  });

  it('既存の状態から更新される', () => {
    const initial = {
      '光志郎 (中学生コース)': { streak: 9, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    const { streakUsers, results } = updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.strictEqual(streakUsers['光志郎 (中学生コース)'].streak, 10);
    assert.strictEqual(results[0].event, 'milestone');
  });

  it('入力のマップを変更しない(純粋関数)', () => {
    const initial = {
      '光志郎 (中学生コース)': { streak: 5, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.strictEqual(initial['光志郎 (中学生コース)'].streak, 5);
  });

  it('クロール対象にいないユーザーの状態は変更されない', () => {
    const initial = {
      '別の子 (小学生コース)': { streak: 3, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    const { streakUsers } = updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.deepStrictEqual(
      streakUsers['別の子 (小学生コース)'],
      { streak: 3, grace: 0, lastConfirmedDate: '2026-07-11' }
    );
  });
});

describe('formatStreakInfo', () => {
  it('基本表示(ストリークとおたすけ)', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'none'
    });
    assert.strictEqual(text, '🔥 連続学習: 12日目  🛟 おたすけ: 1/3');
  });

  it('todayStudied で暫定+1表示(夜通知用)', () => {
    const text = formatStreakInfo(
      { state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' }, event: 'none' },
      { todayStudied: true }
    );
    assert.ok(text.includes('13日目'));
  });

  it('ストリーク0のときは「0日」表示', () => {
    const text = formatStreakInfo({
      state: { streak: 0, grace: 0, lastConfirmedDate: null },
      event: 'none'
    });
    assert.ok(text.includes('🔥 連続学習: 0日'));
  });

  it('milestoneイベントでお祝い行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 10, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'milestone'
    });
    assert.ok(text.includes('🎉 10日連続達成!おたすけ+1(残り1)'));
  });

  it('grace_usedイベントでおたすけ使用行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'grace_used'
    });
    assert.ok(text.includes('💤 昨日はおたすけを使って連続記録を守りました(残り1)'));
  });

  it('resetイベントでリセット行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 0, grace: 0, lastConfirmedDate: '2026-07-12' },
      event: 'reset'
    });
    assert.ok(text.includes('😢 連続記録がリセットされました'));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: FAIL (`updateStreaks is not a function`)

- [ ] **Step 3: 実装を書く**

`src/streak.js` の `confirmDay` の後(load/save の前)に追加:

```js
/**
 * 全ユーザー分の確定判定を適用(純粋関数、入力は変更しない)
 *
 * @param {object} streakUsers - userName → state のマップ
 * @param {Array} users - 判定対象日のクロール済みユーザーデータ(v2.0形式)
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @returns {{streakUsers: object, results: Array<{userName: string, state: object, event: string}>}}
 */
function updateStreaks(streakUsers, users, dateString) {
  const updated = { ...streakUsers };
  const results = [];

  users.forEach(user => {
    const current = updated[user.userName] || createInitialState();
    const { state, event } = confirmDay(current, dateString, isStudied(user));
    updated[user.userName] = state;
    results.push({ userName: user.userName, state, event });
  });

  return { streakUsers: updated, results };
}

/**
 * 通知メッセージ用のストリーク表示行を生成
 *
 * @param {{state: object, event: string}} result - updateStreaks の results 要素
 * @param {object} [options]
 * @param {boolean} [options.todayStudied] - 当日すでに学習済みなら暫定で+1表示(夜通知用)
 * @returns {string} 改行区切りの表示行
 */
function formatStreakInfo(result, options = {}) {
  const { state, event } = result;
  const displayStreak = state.streak + (options.todayStudied ? 1 : 0);
  const streakLabel = displayStreak > 0 ? `${displayStreak}日目` : '0日';

  const lines = [`🔥 連続学習: ${streakLabel}  🛟 おたすけ: ${state.grace}/${GRACE_MAX}`];

  if (event === 'milestone') {
    lines.push(`🎉 ${state.streak}日連続達成!おたすけ+1(残り${state.grace})`);
  } else if (event === 'grace_used') {
    lines.push(`💤 昨日はおたすけを使って連続記録を守りました(残り${state.grace})`);
  } else if (event === 'reset') {
    lines.push('😢 連続記録がリセットされました。今日からまた頑張ろう!');
  }

  return lines.join('\n');
}
```

`module.exports` を更新:

```js
module.exports = {
  createInitialState,
  isStudied,
  confirmDay,
  updateStreaks,
  formatStreakInfo,
  loadStreakData,
  saveStreakData
};
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: PASS (全テスト成功)

- [ ] **Step 5: コミット**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: ストリーク一括更新と通知用表示生成を追加"
```

---

### Task 4: src/notifier.js — formatDetailedMessage に streaks オプションを追加

**Files:**
- Modify: `src/notifier.js:250-256, 277-279`
- Modify: `tests/notifier.test.js`(末尾の describe の後に追加)

**Interfaces:**
- Consumes: なし(streak.js には依存しない。整形済み文字列を受け取るだけ)
- Produces: `formatDetailedMessage(userData, missionChanges, options)` の `options.streaks` — userName → 表示文字列(改行含む可)のプレーンオブジェクト。該当ユーザーの `👤` 行の直後に挿入される。省略時は従来と同一出力

- [ ] **Step 1: 失敗するテストを書く**

`tests/notifier.test.js` の `describe('formatDetailedMessage - 朝通知オプション', ...)` ブロックの閉じ括弧の後(ファイル末尾の `});` の直前)に追加:

```js
  describe('formatDetailedMessage - ストリーク表示', () => {
    const { formatDetailedMessage } = require('../src/notifier');

    const userData = [{
      userName: '光志郎 (中学生コース)',
      missionCount: 1,
      date: '2026-07-12',
      studyTime: { hours: 0, minutes: 45 },
      totalScore: 80,
      missions: [{ name: '数学: 一次関数', score: 80, completed: true }]
    }];

    it('streaks オプションでユーザー名の直後にストリーク行が入る', () => {
      const streaks = { '光志郎 (中学生コース)': '🔥 連続学習: 12日目  🛟 おたすけ: 1/3' };
      const message = formatDetailedMessage(userData, null, { streaks });
      const lines = message.split('\n');
      const nameIndex = lines.findIndex(line => line.startsWith('👤 光志郎'));
      assert.strictEqual(lines[nameIndex + 1], '🔥 連続学習: 12日目  🛟 おたすけ: 1/3');
    });

    it('複数行のストリーク情報(イベント行付き)も表示される', () => {
      const streaks = {
        '光志郎 (中学生コース)': '🔥 連続学習: 10日目  🛟 おたすけ: 1/3\n🎉 10日連続達成!おたすけ+1(残り1)'
      };
      const message = formatDetailedMessage(userData, null, { streaks });
      assert.ok(message.includes('🎉 10日連続達成!おたすけ+1(残り1)'));
    });

    it('streaks に含まれないユーザーにはストリーク行を出さない', () => {
      const streaks = { '別の子 (小学生コース)': '🔥 連続学習: 3日目  🛟 おたすけ: 0/3' };
      const message = formatDetailedMessage(userData, null, { streaks });
      assert.ok(!message.includes('連続学習'));
    });

    it('streaks オプション省略時は従来フォーマットのまま', () => {
      const message = formatDetailedMessage(userData, null, {});
      assert.ok(!message.includes('連続学習'));
      assert.ok(message.includes('👤 光志郎 (中学生コース)'));
    });
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: FAIL (ストリーク行が出力されないため `strictEqual` が失敗)

- [ ] **Step 3: 実装を書く**

`src/notifier.js:251` のオプション分割代入を変更:

```js
  const { dateLabel = null, showNoStudyWarning = false, streaks = null } = options;
```

`src/notifier.js:277-279` のユーザー名出力部分を変更:

```js
  // 各ユーザーのデータを追加
  userData.forEach((user, index) => {
    // ユーザー名
    message += `👤 ${user.userName}\n`;

    // ストリーク(連続学習日数)情報
    if (streaks && streaks[user.userName]) {
      message += `${streaks[user.userName]}\n`;
    }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: PASS (既存テスト含め全テスト成功)

- [ ] **Step 5: コミット**

```bash
git add src/notifier.js tests/notifier.test.js
git commit -m "feat: 通知メッセージにストリーク表示オプションを追加"
```

---

### Task 5: src/morning-index.js — 朝通知へのストリーク統合

**Files:**
- Modify: `src/morning-index.js:10-11, 98-105`

**Interfaces:**
- Consumes: Task 2-3 の `loadStreakData` / `saveStreakData` / `updateStreaks` / `formatStreakInfo`、Task 4 の `options.streaks`
- Produces: なし(エントリポイント)

**備考:** 朝通知は前日分(`dateOffset: -1`)の確定データを取得しているため、そのままストリークを確定判定する。既存の `tests/morning-index.test.js` はエクスポート確認のみの軽量パターンのため、このタスクの自動テストは全体テストの回帰確認とし、動作確認は DRY_RUN で行う。

- [ ] **Step 1: import を追加**

`src/morning-index.js:11` の後に追加:

```js
const { loadStreakData, saveStreakData, updateStreaks, formatStreakInfo } = require('./streak');
```

- [ ] **Step 2: ストリーク更新処理を追加**

`src/morning-index.js:98` の `console.log(\`✅ データの取得が完了しました（${crawlResult.data.length}件）\`);` の直後、`// 5. メッセージフォーマット` コメントの前に挿入:

```js
    // 4.5 ストリーク(連続学習日数)の確定判定
    // 前日分は確定データのため、そのままストリークを確定する
    let streaks = null;
    console.log('🔥 ストリークを更新しています...');
    const streakLoadResult = await loadStreakData();

    if (streakLoadResult.success) {
      const { streakUsers, results } = updateStreaks(
        streakLoadResult.data,
        crawlResult.data,
        targetDates.dateString
      );

      streaks = {};
      results.forEach(result => {
        streaks[result.userName] = formatStreakInfo(result);
      });

      // ドライラン時は状態を書き換えない(再実行で二重判定になるのを防ぐ)
      if (process.env.DRY_RUN === 'true') {
        console.log('ℹ️ ドライランモード: ストリークデータの保存はスキップしました');
      } else {
        const streakSaveResult = await saveStreakData(streakUsers);
        if (streakSaveResult.success) {
          console.log('✅ ストリークデータの保存が完了しました');
        } else {
          console.error('❌ ストリークデータの保存に失敗しました:', streakSaveResult.error);
          errors.push(streakSaveResult.error);
        }
      }
    } else {
      console.warn('⚠️ ストリークデータの読み込みに失敗したため、ストリーク表示をスキップします:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
    }
```

- [ ] **Step 3: メッセージフォーマットに streaks を渡す**

`src/morning-index.js:101-104` の `formatDetailedMessage` 呼び出しを変更:

```js
    let message = formatDetailedMessage(crawlResult.data, null, {
      dateLabel: `昨日(${targetDates.withPadding})`,
      showNoStudyWarning: true,
      streaks
    });
```

- [ ] **Step 4: 全テストが通ることを確認**

Run: `npm test`
Expected: PASS (全テストスイート成功。morning-index.test.js のエクスポート確認も通る)

- [ ] **Step 5: コミット**

```bash
git add src/morning-index.js
git commit -m "feat: 朝通知にストリーク確定判定と表示を統合"
```

---

### Task 6: src/index.js — 夜通知へのストリーク統合

**Files:**
- Modify: `src/index.js:9-11, 207-230`

**Interfaces:**
- Consumes: Task 1-3 の `loadStreakData` / `saveStreakData` / `updateStreaks` / `formatStreakInfo` / `isStudied` / `createInitialState`、既存の `getTargetDates(-1)` / `getAllUsersDetailedData(page, {courseFilter, dateOffset})`、Task 4 の `options.streaks`
- Produces: なし(エントリポイント)

**備考:** 夜通知は当日20:00時点のデータのため、前日分を追加クロールして確定判定する。当日分は「確定ストリーク+当日学習済みなら暫定+1」で表示。前日クロール失敗時は確定判定をスキップし前回の確定値を表示する(翌日以降は空白日として中立処理される)。フォールバック基本モード(v1.0形式)ではストリーク処理を行わない。

- [ ] **Step 1: import を追加**

`src/index.js:9-11` を変更:

```js
const { getAllUsersDetailedData, getAllUsersMissionCounts, getUserList, getTargetDates } = require('./crawler');
const { loadPreviousData, compareData, compareMissionDetails, saveData } = require('./data');
const { sendNotification, formatDetailedMessage, truncateToLimit } = require('./notifier');
const { loadStreakData, saveStreakData, updateStreaks, formatStreakInfo, isStudied, createInitialState } = require('./streak');
```

- [ ] **Step 2: ストリーク更新処理を追加**

`src/index.js:207` 付近、`if (!crawlResult.detailsAvailable) {...}` ブロックの閉じ括弧の直後、`// 7. データ比較（変更検出）` コメントの前に挿入:

```js
    // 6.5 ストリーク(連続学習日数)の更新
    // 20時時点の当日データでは確定できないため、前日分を追加クロールして確定判定する。
    // 当日分は「確定ストリーク+当日学習済みなら暫定+1」として表示に使う。
    let streaks = null;
    console.log('🔥 ストリークを更新しています...');
    const streakLoadResult = await loadStreakData();

    if (streakLoadResult.success) {
      let streakUsers = streakLoadResult.data;
      const resultMap = new Map();

      const yesterdayDates = getTargetDates(-1);
      console.log(`🔍 ストリーク確定のため前日(${yesterdayDates.withPadding})のデータを取得しています...`);
      const yesterdayCrawlResult = await getAllUsersDetailedData(page, {
        courseFilter: 'elementary',
        dateOffset: -1
      });

      if (yesterdayCrawlResult.success) {
        const updateResult = updateStreaks(
          streakUsers,
          yesterdayCrawlResult.data,
          yesterdayDates.dateString
        );
        streakUsers = updateResult.streakUsers;
        updateResult.results.forEach(result => resultMap.set(result.userName, result));

        const streakSaveResult = await saveStreakData(streakUsers);
        if (streakSaveResult.success) {
          console.log('✅ ストリークデータの保存が完了しました');
        } else {
          console.error('❌ ストリークデータの保存に失敗しました:', streakSaveResult.error);
          errors.push(streakSaveResult.error);
        }
      } else {
        // 前日分が取れない場合は確定判定をスキップし、前回の確定値をそのまま表示する
        // (未判定日は翌日以降に空白日として中立処理される)
        console.warn('⚠️ 前日分の取得に失敗したため、ストリークの確定判定をスキップします:', yesterdayCrawlResult.error);
      }

      // 通知用の表示情報を構築(当日すでに学習していれば暫定で+1表示)
      streaks = {};
      currentData.forEach(user => {
        const result = resultMap.get(user.userName) || {
          state: streakUsers[user.userName] || createInitialState(),
          event: 'none'
        };
        streaks[user.userName] = formatStreakInfo(result, { todayStudied: isStudied(user) });
      });
    } else {
      console.warn('⚠️ ストリークデータの読み込みに失敗したため、ストリーク表示をスキップします:', streakLoadResult.error);
      errors.push(streakLoadResult.error);
    }
```

- [ ] **Step 3: メッセージフォーマットに streaks を渡す**

`src/index.js:230` の `formatDetailedMessage` 呼び出しを変更:

```js
    let message = formatDetailedMessage(currentData, missionChangesResult, { streaks });
```

- [ ] **Step 4: 全テストが通ることを確認**

Run: `npm test`
Expected: PASS (全テストスイート成功)

- [ ] **Step 5: コミット**

```bash
git add src/index.js
git commit -m "feat: 夜通知にストリーク確定判定(前日分追加クロール)と暫定表示を統合"
```

---

### Task 7: GitHub Actions ワークフローに actions/cache を追加

**Files:**
- Modify: `.github/workflows/crawler.yml`(checkout直後と「クローラーを実行」直後)
- Modify: `.github/workflows/morning-crawler.yml`(checkout直後と「朝通知を実行」直後)

**Interfaces:**
- Consumes: なし
- Produces: `data/` ディレクトリ(`mission_data.json` + `streak_data.json`)が両ワークフロー間で `smilezemi-data-` キー系列の cache として引き継がれる

**備考:**
- restore-keys のプレフィックス一致で「最新のキャッシュ」が復元される。key は `github.run_id` 付きで毎回ユニークなため、save は常に新規エントリを作る
- 夜(20:00)→翌朝(7:00)→翌夜と、両ワークフローが同一キャッシュ系列を交互に更新する
- save は `if: always()` にする: 通知送信失敗などで exit code 1 でも、確定済みのストリークデータは失わない(同日再実行は `lastConfirmedDate` により冪等)
- `data/` は docker-compose の volume `./data:/app/data` でホスト側と共有済み(morning は `docker compose run` だが同じ service 定義なので同様)
- 副次効果: `mission_data.json` も引き継がれるため、これまでCI上で機能していなかった前日比較(📈📉表示)が有効になる

- [ ] **Step 1: crawler.yml に restore ステップを追加**

`.github/workflows/crawler.yml` の「リポジトリをチェックアウト」ステップの直後に挿入:

```yaml
      # 前回データ(ミッション・ストリーク)をキャッシュから復元
      - name: 前回データを復元
        uses: actions/cache/restore@v4
        with:
          path: data
          key: smilezemi-data-${{ github.run_id }}
          restore-keys: |
            smilezemi-data-
```

- [ ] **Step 2: crawler.yml に save ステップを追加**

「クローラーを実行」ステップの直後(「スクリーンショットを保存」の前)に挿入:

```yaml
      # データをキャッシュに保存(次回実行時に復元される)
      # 通知失敗などで exit code 1 でも確定済みストリークは保持したいため always()
      - name: データをキャッシュに保存
        if: always()
        uses: actions/cache/save@v4
        with:
          path: data
          key: smilezemi-data-${{ github.run_id }}
```

- [ ] **Step 3: morning-crawler.yml に同じ2ステップを追加**

`.github/workflows/morning-crawler.yml` の「リポジトリをチェックアウト」ステップの直後に挿入:

```yaml
      # 前回データ(ミッション・ストリーク)をキャッシュから復元
      - name: 前回データを復元
        uses: actions/cache/restore@v4
        with:
          path: data
          key: smilezemi-data-${{ github.run_id }}
          restore-keys: |
            smilezemi-data-
```

「朝通知を実行」ステップの直後(「スクリーンショットを保存」の前)に挿入:

```yaml
      # データをキャッシュに保存(次回実行時に復元される)
      # 通知失敗などで exit code 1 でも確定済みストリークは保持したいため always()
      - name: データをキャッシュに保存
        if: always()
        uses: actions/cache/save@v4
        with:
          path: data
          key: smilezemi-data-${{ github.run_id }}
```

- [ ] **Step 4: YAML の構文を検証**

Run: `node -e "const fs=require('fs'); ['.github/workflows/crawler.yml','.github/workflows/morning-crawler.yml'].forEach(f=>{ console.log(f, fs.readFileSync(f,'utf-8').includes('actions/cache/restore@v4') && fs.readFileSync(f,'utf-8').includes('actions/cache/save@v4') ? 'OK' : 'NG'); })"`
Expected: 両ファイルとも `OK`

さらに `docker compose config -q` 相当の YAML 検証として、GitHub にプッシュした際の workflow 構文エラーがないか目視確認(インデントは既存ステップと同じ6スペース)。

- [ ] **Step 5: コミット**

```bash
git add .github/workflows/crawler.yml .github/workflows/morning-crawler.yml
git commit -m "feat: ワークフロー間でdata/をactions/cacheで永続化"
```

---

## 全体検証

1. `npm test` — 全テストスイートが通ること
2. ローカル動作確認(要 `.env`): `DRY_RUN=true node src/morning-index.js` を実行し、通知プレビューに `🔥 連続学習:` 行が含まれ、`data/streak_data.json` が変更されないこと
3. ローカルで `node src/morning-index.js`(DRY_RUNなし)を1回実行後、`data/streak_data.json` が生成されること。続けて再実行し、ストリークが二重加算されないこと(`lastConfirmedDate` による冪等性)
4. ブランチをプッシュ後、`workflow_dispatch` で朝通知ワークフローを手動実行し、cache restore/save ステップのログを確認(初回は restore miss → save 成功、2回目は restore hit)
