# 学習免除日（おやすみ）機能 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** どうしても勉強できない日を「免除日」として登録でき、その日は未学習でもストリークをリセットせずおたすけも消費しない仕組みを作る。免除は未来日付にも過去日付にも登録でき、過去日付は確定済みの判定を巻き戻して修復する。

**Architecture:** 各ユーザーに「判定対象日 → 学習が成立したか」の履歴と免除日リストを持たせ、`streak` / `grace` を履歴のリプレイから導出する。`confirmDay` に免除の分岐を1つ足し、その上に純粋関数 `replayStreak()` を置く。日次の確定も遡及修復も同じリプレイを通るため、計算経路は1つしかない。ボーナスは支給済みの現金であるためリプレイ対象外。

**Tech Stack:** Node.js >= 24 (CommonJS), Node.js built-in test runner (`node --test`), oxlint, GitHub Actions (workflow_dispatch + actions/cache)

**Spec:** `docs/superpowers/specs/2026-08-17-study-exemption-design.md`

## Global Constraints

- 免除日に**学習していれば通常どおり**加算・マイルストーン・ボーナスが動く。免除は未学習の日だけを守る盾
- `bonus` はリプレイで再計算しない。その日のイベントが `bonus` のときだけ +1 する現行挙動を維持する
- `history` には**実際に確定判定した日だけ**を入れる。`dataReliable: false` でスキップした日は入れない（「未判定の空白日は中立扱い」を保つため）
- 履歴の保持期間は **90日**。溢れた分は `replayBase` に畳み込む
- 純粋関数は入力を破壊しない（`streak.js` の既存方針）。I/O関数は `{success, error?}` を返す
- `npm run lint` は oxlint の `--deny-warnings` で走るため、未使用の変数・import が1つでも残るとエラーになる
- 単一テストファイルの実行にはオプション2つが必須: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
- コメント・テスト名・コミットメッセージ・Markdown はすべて日本語
- `src/index.js` に新しい require を足す場合は `tests/index.test.js` の `MODULE_PATHS` とモック登録の追加が必須（CLAUDE.md のテスト方針）

## File Structure

| ファイル | 役割 |
|---|---|
| `src/streak.js`（変更） | 免除分岐・リプレイ・プルーニング・永続化 v1.4・`exempt` の表示文言。リプレイは `confirmDay` と不可分なため同一ファイルに置く（別ファイルにすると `replayStreak` → `confirmDay` の循環 require になる） |
| `src/notifier.js`（変更） | 免除ユーザーの警告抑止と「おやすみ」行 |
| `src/index.js`（変更） | 夜: 当日免除の判定、LINE送信判定からの除外 |
| `src/morning-index.js`（変更） | 朝: `exempt` イベントのユーザーを notifier へ渡す |
| `scripts/set-exempt-dates.js`（新規） | 免除日の登録・取り消し。検証をすべてここに集約 |
| `scripts/show-streak-data.js`（変更） | 免除日と直近履歴の表示 |
| `.github/workflows/exempt-days.yml`（新規） | workflow_dispatch → キャッシュ復元 → スクリプト → キャッシュ保存 |
| `.claude/skills/smilezemi-exempt-day/SKILL.md`（新規） | 運用スキル |
| `CLAUDE.md`（変更） | 免除機能と、夜通知が `streak_data.json` を読むようになる旨 |

---

### Task 1: 免除分岐とリプレイの土台（純粋関数）

**Files:**
- Modify: `src/streak.js`（`confirmDay` の分岐追加、`shiftDate` / `sortedHistoryDates` / `replayStreak` / `pruneHistory` の新規追加、exports）
- Test: `tests/streak.test.js`

**Interfaces:**
- Produces: `confirmDay(state, dateString, studied, options = {})` — `options.exempt` が真かつ未学習なら `event: 'exempt'` で状態据え置き
- Produces: `replayStreak(replayBase, history, exemptDates) → {streak, grace, lastConfirmedDate, events}` — `events` は 日付 → イベント名
- Produces: `pruneHistory(state, retentionDays = HISTORY_RETENTION_DAYS) → state` — 90日より古い履歴を `replayBase` に畳み込む
- Produces: `shiftDate(dateString, days) → string` — `YYYY-MM-DD` を日数だけずらす（Task 3 の期間展開でも使う）
- Produces: `HISTORY_RETENTION_DAYS = 90`
- Unchanged: `confirmDay` の第1〜3引数、既存の全イベント名（`milestone` / `bonus` / `grace_used` / `reset` / `none`）

- [ ] **Step 1: 免除分岐のテストを書く**

`tests/streak.test.js` の `describe('confirmDay')` 系のブロックの後ろに追加する:

```javascript
describe('confirmDay() - 免除日', () => {
  it('免除日に未学習なら streak も grace も据え置きで event は exempt', () => {
    const state = { streak: 12, grace: 2, bonus: 5, lastConfirmedDate: '2026-08-15' };
    const { state: next, event } = confirmDay(state, '2026-08-16', false, { exempt: true });
    assert.strictEqual(event, 'exempt');
    assert.strictEqual(next.streak, 12, 'streak は減らない');
    assert.strictEqual(next.grace, 2, 'おたすけは消費されない');
    assert.strictEqual(next.bonus, 5, 'ボーナスは据え置き');
    assert.strictEqual(next.lastConfirmedDate, '2026-08-16', '日付だけ進む');
  });

  it('免除日でも学習していれば通常どおり +1 する', () => {
    const state = { streak: 12, grace: 2, bonus: 0, lastConfirmedDate: '2026-08-15' };
    const { state: next, event } = confirmDay(state, '2026-08-16', true, { exempt: true });
    assert.strictEqual(next.streak, 13, '学習を優先して加算する');
    assert.strictEqual(event, 'none');
  });

  it('免除日でも学習してマイルストーンに達すればおたすけ+1', () => {
    const state = { streak: 9, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-15' };
    const { state: next, event } = confirmDay(state, '2026-08-16', true, { exempt: true });
    assert.strictEqual(next.streak, 10);
    assert.strictEqual(next.grace, 2);
    assert.strictEqual(event, 'milestone');
  });

  it('streak 0 の免除日も日付だけ進む', () => {
    const state = { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null };
    const { state: next, event } = confirmDay(state, '2026-08-16', false, { exempt: true });
    assert.strictEqual(event, 'exempt');
    assert.strictEqual(next.streak, 0);
    assert.strictEqual(next.grace, 1);
  });

  it('options 省略時は従来どおり動く(未学習でリセット)', () => {
    const state = { streak: 5, grace: 0, bonus: 0, lastConfirmedDate: '2026-08-15' };
    const { event } = confirmDay(state, '2026-08-16', false);
    assert.strictEqual(event, 'reset');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: FAIL。`confirmDay` が第4引数を無視するため、免除日の未学習テストが `event: 'reset'` / `'grace_used'` になり `'exempt'` と一致しない

- [ ] **Step 3: confirmDay に免除分岐を実装する**

`src/streak.js` の `confirmDay` のシグネチャを変える:

```javascript
function confirmDay(state, dateString, studied, options = {}) {
```

JSDoc に1行足す:

```javascript
 * @param {object} [options]
 * @param {boolean} [options.exempt=false] - 免除日なら未学習でも罰しない
```

`if (studied) { ... }` のブロックが閉じた直後、`// 守るべき記録がないうちは...` のコメントで始まる `if (state.streak === 0)` より**前**に次を挿入する:

```javascript
  // 免除日は未学習でも罰しない: streak も grace も据え置き、日付だけ進める。
  // studied の経路は先に return しているため、ここに届くのは未学習の日だけ
  if (options.exempt) {
    return {
      state: { streak: state.streak, grace: state.grace, bonus, lastConfirmedDate: dateString },
      event: 'exempt'
    };
  }
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: PASS

- [ ] **Step 5: リプレイとプルーニングのテストを書く**

`tests/streak.test.js` の末尾に追加する。import の分割代入に `replayStreak`, `pruneHistory`, `shiftDate`, `HISTORY_RETENTION_DAYS` を足すこと:

```javascript
describe('shiftDate()', () => {
  it('日数を足し引きできる(月またぎ)', () => {
    assert.strictEqual(shiftDate('2026-08-01', -1), '2026-07-31');
    assert.strictEqual(shiftDate('2026-08-31', 1), '2026-09-01');
    assert.strictEqual(shiftDate('2026-08-17', 0), '2026-08-17');
  });
});

describe('replayStreak()', () => {
  const base = { streak: 0, grace: 1, date: null };

  it('免除日がなければ1日ずつ確定したのと同じ値になる', () => {
    const history = { '2026-08-01': true, '2026-08-02': true, '2026-08-03': false };
    const replayed = replayStreak(base, history, []);

    // 同じ入力を confirmDay に順に通した結果と突き合わせる
    let state = { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null };
    ['2026-08-01', '2026-08-02', '2026-08-03'].forEach(date => {
      state = confirmDay(state, date, history[date]).state;
    });

    assert.strictEqual(replayed.streak, state.streak);
    assert.strictEqual(replayed.grace, state.grace);
    assert.strictEqual(replayed.lastConfirmedDate, '2026-08-03');
  });

  it('途中日を免除するとおたすけ消費が巻き戻る', () => {
    const history = { '2026-08-01': true, '2026-08-02': false, '2026-08-03': true };

    const withoutExempt = replayStreak(base, history, []);
    assert.strictEqual(withoutExempt.grace, 0, '免除なしではおたすけを1消費する');
    assert.strictEqual(withoutExempt.streak, 2);

    const withExempt = replayStreak(base, history, ['2026-08-02']);
    assert.strictEqual(withExempt.grace, 1, '免除するとおたすけが戻る');
    assert.strictEqual(withExempt.streak, 2, 'streak は維持される');
    assert.strictEqual(withExempt.events['2026-08-02'], 'exempt');
  });

  it('リセットされた日を免除すると連続日数が復活する', () => {
    const noGrace = { streak: 4, grace: 0, date: '2026-07-31' };
    const history = { '2026-08-01': false, '2026-08-02': true };

    const withoutExempt = replayStreak(noGrace, history, []);
    assert.strictEqual(withoutExempt.streak, 1, '免除なしではリセット後に1日目から');

    const withExempt = replayStreak(noGrace, history, ['2026-08-01']);
    assert.strictEqual(withExempt.streak, 5, '免除すると4日目の続きになる');
  });

  it('免除日に学習していれば加算される', () => {
    const history = { '2026-08-01': true };
    const replayed = replayStreak(base, history, ['2026-08-01']);
    assert.strictEqual(replayed.streak, 1);
    assert.strictEqual(replayed.events['2026-08-01'], 'none');
  });

  it('壊れたエントリは無視する', () => {
    const history = { '2026-08-01': true, 'あした': true, '2026-08-02': 'yes' };
    const replayed = replayStreak(base, history, []);
    assert.strictEqual(replayed.streak, 1, '正常な1件だけが反映される');
    assert.strictEqual(replayed.lastConfirmedDate, '2026-08-01');
  });

  it('replayBase が欠けていても初期状態から復元する', () => {
    const replayed = replayStreak(undefined, { '2026-08-01': true }, []);
    assert.strictEqual(replayed.streak, 1);
  });

  it('履歴が空なら replayBase の値をそのまま返す', () => {
    const replayed = replayStreak({ streak: 7, grace: 2, date: '2026-07-31' }, {}, []);
    assert.strictEqual(replayed.streak, 7);
    assert.strictEqual(replayed.grace, 2);
    assert.strictEqual(replayed.lastConfirmedDate, '2026-07-31');
  });
});

describe('pruneHistory()', () => {
  it('保持期間内なら何も畳み込まない', () => {
    const state = {
      streak: 2, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-02',
      exemptDates: [], history: { '2026-08-01': true, '2026-08-02': true },
      replayBase: { streak: 0, grace: 1, date: null }
    };
    const pruned = pruneHistory(state, 90);
    assert.deepStrictEqual(pruned.history, state.history);
  });

  it('保持期間より古い日は replayBase に畳み込まれる', () => {
    const state = {
      streak: 2, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-10',
      exemptDates: [], history: { '2026-08-01': true, '2026-08-10': true },
      replayBase: { streak: 0, grace: 1, date: null }
    };
    const pruned = pruneHistory(state, 5);

    assert.deepStrictEqual(Object.keys(pruned.history), ['2026-08-10'], '古い日が history から消える');
    assert.strictEqual(pruned.replayBase.streak, 1, '畳み込んだ日の分が replayBase に入る');
    assert.strictEqual(pruned.replayBase.date, '2026-08-01');
    assert.strictEqual(state.history['2026-08-01'], true, '入力を破壊しない');
  });

  it('畳み込む日の免除は replayBase に反映され、その免除日は取り除かれる', () => {
    const state = {
      streak: 3, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-10',
      exemptDates: ['2026-08-01', '2026-08-10'],
      history: { '2026-08-01': false, '2026-08-10': false },
      replayBase: { streak: 3, grace: 1, date: '2026-07-31' }
    };
    const pruned = pruneHistory(state, 5);

    assert.strictEqual(pruned.replayBase.grace, 1, '免除日なのでおたすけは消費されない');
    assert.strictEqual(pruned.replayBase.streak, 3, 'streak も据え置き');
    assert.deepStrictEqual(pruned.exemptDates, ['2026-08-10'], '畳み込み済みの免除日は消える');
  });

  it('リプレイの結果は畳み込みの前後で変わらない', () => {
    const state = {
      streak: 0, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-10',
      exemptDates: ['2026-08-02'],
      history: { '2026-08-01': true, '2026-08-02': false, '2026-08-10': true },
      replayBase: { streak: 0, grace: 1, date: null }
    };
    const before = replayStreak(state.replayBase, state.history, state.exemptDates);
    const pruned = pruneHistory(state, 3);
    const after = replayStreak(pruned.replayBase, pruned.history, pruned.exemptDates);

    assert.strictEqual(after.streak, before.streak);
    assert.strictEqual(after.grace, before.grace);
    assert.strictEqual(after.lastConfirmedDate, before.lastConfirmedDate);
  });
});
```

- [ ] **Step 6: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: FAIL。`replayStreak is not a function` 等（未実装のため）

- [ ] **Step 7: リプレイとプルーニングを実装する**

`src/streak.js` の定数定義（`MILESTONE_INTERVAL` の下）に足す:

```javascript
const HISTORY_RETENTION_DAYS = 90; // 学習履歴の保持日数。これより古い日は replayBase に畳み込む
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
```

`confirmDay` の後ろに次の3つの関数を追加する:

```javascript
/**
 * YYYY-MM-DD を日数だけずらす(純粋関数)
 * UTC深夜として解釈するため実行環境のタイムゾーンに依存しない
 *
 * @param {string} dateString - YYYY-MM-DD
 * @param {number} days - ずらす日数(負値で過去へ)
 * @returns {string} YYYY-MM-DD
 */
function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 学習履歴のキーを検証して日付昇順に返す(壊れたエントリは無視してログに残す)
 * 履歴の不備を理由に streak を失わせないための防御
 *
 * @private
 * @param {Object<string, boolean>} history
 * @returns {string[]}
 */
function sortedHistoryDates(history) {
  if (!history || typeof history !== 'object') {
    return [];
  }

  return Object.keys(history)
    .filter(date => {
      if (!DATE_PATTERN.test(date)) {
        console.warn(`⚠️ 学習履歴の不正な日付キーを無視します: ${date}`);
        return false;
      }
      if (typeof history[date] !== 'boolean') {
        console.warn(`⚠️ 学習履歴の不正な値を無視します: ${date}=${history[date]}`);
        return false;
      }
      return true;
    })
    .sort();
}

/**
 * 学習履歴を日付順に confirmDay へ通してストリーク状態を導出する(純粋関数)
 *
 * bonus はどの分岐の条件にも影響しない(confirmDay は読み書きするだけ)ため
 * リプレイでは扱わない。ボーナス残高は呼び出し側が当日のイベントで加算する。
 *
 * @param {{streak: number, grace: number, date: string|null}} replayBase - history より前の状態
 * @param {Object<string, boolean>} history - 判定対象日 → その日に学習が成立したか
 * @param {string[]} [exemptDates] - 免除日
 * @returns {{streak: number, grace: number, lastConfirmedDate: string|null, events: Object<string, string>}}
 */
function replayStreak(replayBase, history, exemptDates = []) {
  const base = replayBase || {};
  const exempt = new Set(exemptDates);
  const events = {};

  let state = {
    streak: base.streak ?? 0,
    grace: base.grace ?? GRACE_INITIAL,
    bonus: 0, // リプレイでは使わないダミー値
    lastConfirmedDate: base.date ?? null
  };

  sortedHistoryDates(history).forEach(date => {
    const result = confirmDay(state, date, history[date], { exempt: exempt.has(date) });
    state = result.state;
    events[date] = result.event;
  });

  return {
    streak: state.streak,
    grace: state.grace,
    lastConfirmedDate: state.lastConfirmedDate,
    events
  };
}

/**
 * 保持期間より古い学習履歴を replayBase に畳み込む(純粋関数、入力は変更しない)
 *
 * 畳み込みの際も免除日を参照するため、免除の効果はチェックポイントに正しく残る。
 * 畳み込み済みの免除日は効果が replayBase に入っているため取り除く。
 *
 * @param {object} state - ユーザーのストリーク状態
 * @param {number} [retentionDays=HISTORY_RETENTION_DAYS]
 * @returns {object} 新しい状態
 */
function pruneHistory(state, retentionDays = HISTORY_RETENTION_DAYS) {
  const dates = sortedHistoryDates(state.history);
  if (dates.length === 0) {
    return state;
  }

  const cutoff = shiftDate(dates[dates.length - 1], -retentionDays);
  const foldDates = dates.filter(date => date < cutoff);
  if (foldDates.length === 0) {
    return state;
  }

  const exemptDates = state.exemptDates || [];
  const exempt = new Set(exemptDates);

  let base = {
    streak: state.replayBase?.streak ?? 0,
    grace: state.replayBase?.grace ?? GRACE_INITIAL,
    bonus: 0,
    lastConfirmedDate: state.replayBase?.date ?? null
  };
  foldDates.forEach(date => {
    base = confirmDay(base, date, state.history[date], { exempt: exempt.has(date) }).state;
  });

  const history = {};
  dates.filter(date => date >= cutoff).forEach(date => {
    history[date] = state.history[date];
  });

  const folded = new Set(foldDates);
  return {
    ...state,
    history,
    exemptDates: exemptDates.filter(date => !folded.has(date)),
    replayBase: { streak: base.streak, grace: base.grace, date: base.lastConfirmedDate }
  };
}
```

`module.exports` に `shiftDate`, `replayStreak`, `pruneHistory`, `HISTORY_RETENTION_DAYS` を足す。

- [ ] **Step 8: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: PASS

- [ ] **Step 9: 全テストと lint を実行する**

Run: `npm test`
Expected: PASS（既存の `confirmDay` テストは第4引数を渡さないため影響を受けない）

Run: `npm run lint`
Expected: 警告・エラーなし

- [ ] **Step 10: コミットする**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: 免除日の分岐と学習履歴のリプレイを追加する"
```

---

### Task 2: 永続化 v1.4 と日次確定のリプレイ化

**Files:**
- Modify: `src/streak.js`（`createInitialState`、`loadStreakData` の移行、`saveStreakData` のバージョン、`confirmDayWithHistory` 新規、`updateStreaks` の差し替え、`formatStreakInfo` の `exempt` 文言、ファイル冒頭のスキーマコメント、exports）
- Test: `tests/streak.test.js`

**Interfaces:**
- Consumes: Task 1 の `replayStreak(replayBase, history, exemptDates)` / `pruneHistory(state)` / `confirmDay(state, dateString, studied, options)`
- Produces: `confirmDayWithHistory(state, dateString, studied) → {state, event}` — 履歴に追記してリプレイし、プルーニング済みの状態を返す
- Produces: `createInitialState()` の戻り値に `exemptDates: []` / `history: {}` / `replayBase: {streak: 0, grace: GRACE_INITIAL, date: null}` が加わる
- Produces: `streak_data.json` のバージョンが `'1.4'` になる
- Unchanged: `updateStreaks(streakUsers, users, dateString, options)` と `updateStreaksByCourse(streakUsers, users, dateString)` の引数と戻り値の形

- [ ] **Step 1: 永続化と日次確定のテストを書く**

`tests/streak.test.js` に追加する:

```javascript
describe('createInitialState() - 免除日フィールド', () => {
  it('免除日・履歴・チェックポイントが初期化される', () => {
    const state = createInitialState();
    assert.deepStrictEqual(state.exemptDates, []);
    assert.deepStrictEqual(state.history, {});
    assert.strictEqual(state.replayBase.date, null);
    assert.strictEqual(state.replayBase.streak, 0);
  });
});

describe('confirmDayWithHistory()', () => {
  it('履歴に追記してリプレイ結果を返す', () => {
    const state = createInitialState();
    const { state: next, event } = confirmDayWithHistory(state, '2026-08-01', true);
    assert.strictEqual(next.streak, 1);
    assert.strictEqual(next.history['2026-08-01'], true);
    assert.strictEqual(next.lastConfirmedDate, '2026-08-01');
    assert.strictEqual(event, 'none');
  });

  it('同じ日を2回確定しても値が動かない(冪等)', () => {
    const first = confirmDayWithHistory(createInitialState(), '2026-08-01', true).state;
    const second = confirmDayWithHistory(first, '2026-08-01', true);
    assert.strictEqual(second.state.streak, 1, '二重加算されない');
    assert.strictEqual(second.event, 'none');
  });

  it('免除日は未学習でも記録が守られる', () => {
    let state = confirmDayWithHistory(createInitialState(), '2026-08-01', true).state;
    state = { ...state, exemptDates: ['2026-08-02'] };
    const { state: next, event } = confirmDayWithHistory(state, '2026-08-02', false);
    assert.strictEqual(event, 'exempt');
    assert.strictEqual(next.streak, 1, 'streak は据え置き');
    assert.strictEqual(next.grace, GRACE_INITIAL, 'おたすけも据え置き');
  });

  it('イベントが bonus の日だけボーナスが増える', () => {
    // おたすけ満タンで学習するとボーナス+1
    const state = {
      ...createInitialState(),
      grace: 3,
      replayBase: { streak: 0, grace: 3, date: null }
    };
    const { state: next, event } = confirmDayWithHistory(state, '2026-08-01', true);
    assert.strictEqual(event, 'bonus');
    assert.strictEqual(next.bonus, 1);
  });

  it('入力の状態を破壊しない', () => {
    const state = createInitialState();
    confirmDayWithHistory(state, '2026-08-01', true);
    assert.deepStrictEqual(state.history, {}, '入力の history は空のまま');
  });
});

describe('updateStreaks() - 遡及免除の反映', () => {
  it('確定済みの日を後から免除するとリプレイで修復される', () => {
    const users = [{ userName: 'たろう', studyItemCount: 0, missions: [] }];

    // 1日目は学習、2日目は未学習でおたすけを消費
    let streakUsers = updateStreaks(
      {}, [{ userName: 'たろう', studyItemCount: 4, missions: [] }], '2026-08-01',
      { minCompletedMissions: 4 }
    ).streakUsers;
    streakUsers = updateStreaks(streakUsers, users, '2026-08-02', { minCompletedMissions: 4 }).streakUsers;
    assert.strictEqual(streakUsers['たろう'].grace, GRACE_INITIAL - 1, 'おたすけが1減っている');

    // 2日目を免除に指定してリプレイすると戻る
    const repaired = { ...streakUsers['たろう'], exemptDates: ['2026-08-02'] };
    const replayed = replayStreak(repaired.replayBase, repaired.history, repaired.exemptDates);
    assert.strictEqual(replayed.grace, GRACE_INITIAL, 'おたすけが復活する');
    assert.strictEqual(replayed.streak, 1, 'streak は維持される');
  });

  it('dataReliable: false の未学習日は履歴に入らない', () => {
    const users = [{ userName: 'たろう', studyItemCount: 0, missions: [], dataReliable: false }];
    const { streakUsers } = updateStreaks({}, users, '2026-08-01', { minCompletedMissions: 4 });
    assert.deepStrictEqual(streakUsers['たろう'].history, {}, '確定していない日は記録しない');
  });
});

describe('formatStreakInfo() - 免除日', () => {
  it('exempt イベントの行を出す', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 2, bonus: 0 },
      event: 'exempt'
    });
    assert.ok(text.includes('😌 免除日のため記録はそのままです'), text);
  });
});
```

`describe('loadStreakData')` 系のブロックに、移行のテストを追加する:

```javascript
  it('v1.3のデータを読むと免除日フィールドが補われる', async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STREAK_FILE, JSON.stringify({
      version: '1.3',
      timestamp: '2026-08-16T00:00:00.000Z',
      users: { 'たろう': { streak: 7, grace: 2, bonus: 3, lastConfirmedDate: '2026-08-16' } }
    }), 'utf-8');

    const result = await loadStreakData();
    assert.strictEqual(result.success, true);
    const state = result.data['たろう'];
    assert.deepStrictEqual(state.exemptDates, []);
    assert.deepStrictEqual(state.history, {});
    assert.strictEqual(state.replayBase.streak, 7, '現在値がチェックポイントになる');
    assert.strictEqual(state.replayBase.grace, 2);
    assert.strictEqual(state.replayBase.date, '2026-08-16');
  });

  it('v1.4のデータではおたすけを再チャージしない', async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STREAK_FILE, JSON.stringify({
      version: '1.4',
      timestamp: '2026-08-16T00:00:00.000Z',
      users: {
        'たろう': {
          streak: 7, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-16',
          exemptDates: [], history: {}, replayBase: { streak: 7, grace: 1, date: '2026-08-16' }
        }
      }
    }), 'utf-8');

    const result = await loadStreakData();
    assert.strictEqual(result.data['たろう'].grace, 1, '既に1.4なら移行は走らない');
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: FAIL。`confirmDayWithHistory is not a function`、`createInitialState` に `exemptDates` が無い、v1.4 が未知バージョン扱いで読み込み失敗、など

- [ ] **Step 3: createInitialState と永続化を実装する**

`createInitialState()` を差し替える:

```javascript
function createInitialState() {
  return {
    streak: 0,
    grace: GRACE_INITIAL,
    bonus: 0,
    lastConfirmedDate: null,
    exemptDates: [],
    history: {},
    replayBase: { streak: 0, grace: GRACE_INITIAL, date: null }
  };
}
```

`loadStreakData()` の許可バージョン一覧を差し替える:

```javascript
    if (!['1.0', '1.1', '1.2', '1.3', '1.4'].includes(version)) {
```

既存のおたすけチャージ移行の条件を差し替える。**`version !== '1.3'` のままだと 1.4 のデータを読むたびにおたすけが満タンに再チャージされてしまう**ため、必ず修正する:

```javascript
    // 〜1.2 → 1.3 移行: 全ユーザーのおたすけを満タン(3)にする一度きりのチャージ。
    // (v1.2の初回チャージは小学生ユーザーがファイル未登録の時点で発火したため再適用。
    //  旧1.0→1.1移行もこの移行に包含される)
    // 1.3以降のデータには適用しない(再チャージしてしまうため)
    if (!['1.3', '1.4'].includes(version)) {
      Object.values(users).forEach(state => {
        state.grace = GRACE_MAX;
      });
    }
```

その直後に v1.4 移行を追加する:

```javascript
    // 〜1.3 → 1.4 移行: 免除日機能のフィールドを補う。
    // history は空から始まるため、移行より前の日は遡及免除できない(設計どおりの割り切り)
    if (version !== '1.4') {
      Object.values(users).forEach(state => {
        state.exemptDates = state.exemptDates || [];
        state.history = state.history || {};
        state.replayBase = state.replayBase || {
          streak: state.streak ?? 0,
          grace: state.grace ?? GRACE_INITIAL,
          date: state.lastConfirmedDate ?? null
        };
      });
    }
```

`saveStreakData()` の `saveObject` のバージョンを `'1.4'` にする:

```javascript
    const saveObject = {
      version: '1.4',
      timestamp: new Date().toISOString(),
      users: streakUsers
    };
```

ファイル冒頭のスキーマコメント（`データ構造 (data/streak_data.json)` のブロック）を実態に合わせて更新する:

```javascript
 * データ構造 (data/streak_data.json):
 * {
 *   version: "1.4",  // 1.3未満は全ユーザーのおたすけを3にする移行、1.4未満は免除日フィールドの補完を適用
 *   timestamp: "ISO 8601",
 *   users: {
 *     "ユーザー名": {                    // クローラーの表示名。コース選択画面を経由した場合のみ "名前 (コース名)" になる
 *       streak: number,                 // 確定済み連続学習日数(リプレイの導出値)
 *       grace: number,                  // おたすけ残数 (0〜3、リプレイの導出値)
 *       bonus: number,                  // ボーナスポイント (月次清算で0にリセット。リプレイ対象外)
 *       course: string|undefined,       // 'elementary' | 'juniorHigh'。月次清算の単価判定に使う。未設定は elementary 扱い
 *       lastConfirmedDate: string|null, // 最後に確定判定した日 (YYYY-MM-DD, JST)
 *       exemptDates: string[],          // 免除日 (YYYY-MM-DD)。未来・過去を問わない
 *       history: {                      // 判定対象日 → その日に学習が成立したか。保持は90日
 *         "YYYY-MM-DD": boolean
 *       },
 *       replayBase: {                   // history より前をまとめたチェックポイント
 *         streak: number,
 *         grace: number,
 *         date: string|null             // このチェックポイントが確定済みとしている最後の日
 *       }
 *     }
 *   }
 * }
```

- [ ] **Step 4: 日次確定をリプレイ方式に切り替える**

`replayStreak` の後ろに `confirmDayWithHistory` を追加する:

```javascript
/**
 * 学習履歴に1日分を追記してリプレイし、新しい状態とその日のイベントを返す(純粋関数)
 *
 * 既に履歴にある日は何もしない(同日再実行の冪等性。旧 lastConfirmedDate ガードの役割)。
 * bonus はリプレイ対象外のため、その日のイベントが bonus のときだけここで加算する。
 *
 * @param {object} state - ユーザーのストリーク状態
 * @param {string} dateString - 判定対象日 (YYYY-MM-DD)
 * @param {boolean} studied - 対象日に学習が成立したか
 * @returns {{state: object, event: string}}
 */
function confirmDayWithHistory(state, dateString, studied) {
  const history = state.history || {};
  if (Object.hasOwn(history, dateString)) {
    return { state, event: 'none' };
  }

  const nextHistory = { ...history, [dateString]: studied };
  const replayed = replayStreak(state.replayBase, nextHistory, state.exemptDates || []);
  const event = replayed.events[dateString] || 'none';

  const next = {
    ...state,
    streak: replayed.streak,
    grace: replayed.grace,
    bonus: (state.bonus ?? 0) + (event === 'bonus' ? 1 : 0),
    lastConfirmedDate: replayed.lastConfirmedDate,
    history: nextHistory
  };

  return { state: pruneHistory(next), event };
}
```

`updateStreaks()` の中の `confirmDay` 呼び出しを差し替える:

```javascript
    const { state: confirmed, event } = confirmDayWithHistory(current, dateString, studied);
```

同じ行の直前にあるコメント（`// confirmDay() は全分岐で状態を新規に組み立て直すため course が落ちる。`）はそのまま残す（`confirmDayWithHistory` も内部で `confirmDay` を通すため内容は有効）。

`formatStreakInfo()` のイベント分岐に `exempt` を足す。`reset` の分岐の後ろに置く:

```javascript
  } else if (event === 'exempt') {
    lines.push('😌 免除日のため記録はそのままです');
  }
```

`module.exports` に `confirmDayWithHistory` と `GRACE_INITIAL` を足す（`GRACE_INITIAL` はテストが前提値として参照する）。

`tests/streak.test.js` の import の分割代入にも `confirmDayWithHistory` と `GRACE_INITIAL` を足す。

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`

Expected: PASS

- [ ] **Step 6: 全テストと lint を実行する**

Run: `npm test`
Expected: PASS

Run: `npm run lint`
Expected: 警告・エラーなし

- [ ] **Step 7: コミットする**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: ストリークデータをv1.4にし日次確定をリプレイ方式にする"
```

---

### Task 3: 免除日の登録スクリプト

**Files:**
- Create: `scripts/set-exempt-dates.js`
- Create: `tests/set-exempt-dates.test.js`
- Modify: `scripts/show-streak-data.js`

**Interfaces:**
- Consumes: `src/streak.js` の `loadStreakData` / `saveStreakData` / `replayStreak` / `shiftDate`
- Produces: `scripts/set-exempt-dates.js` が `{ parseArgs, validateInput, expandDateRange, applyExemptChange }` をエクスポート（テスト用）。`main()` は `require.main === module` のときだけ実行する
- Produces: `expandDateRange(from, to) → string[]` — 開始日から終了日までの `YYYY-MM-DD` 配列
- Produces: `applyExemptChange(state, dates, action) → {state, added, removed, before, after}` — 免除日を増減してリプレイした新しい状態と、`{streak, grace}` の before / after

- [ ] **Step 1: スクリプトの純粋部分のテストを書く**

`tests/set-exempt-dates.test.js` を新規作成する:

```javascript
/**
 * 免除日登録スクリプトのテスト
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  validateInput,
  expandDateRange,
  applyExemptChange
} = require('../scripts/set-exempt-dates');
const { createInitialState, confirmDayWithHistory, GRACE_INITIAL } = require('../src/streak');

describe('validateInput()', () => {
  it('user と action と from が揃っていれば通る', () => {
    const input = validateInput({ user: 'たろう', from: '2026-08-20', action: 'add' });
    assert.strictEqual(input.user, 'たろう');
    assert.strictEqual(input.to, '2026-08-20', 'to 省略時は from と同じ日');
    assert.strictEqual(input.all, false);
  });

  it('--all を指定すると全員対象になる', () => {
    const input = validateInput({ all: true, from: '2026-08-20', action: 'add' });
    assert.strictEqual(input.all, true);
    assert.strictEqual(input.user, null);
  });

  it('user と all の同時指定は拒否する', () => {
    assert.throws(
      () => validateInput({ user: 'たろう', all: true, from: '2026-08-20', action: 'add' }),
      /どちらか一方/
    );
  });

  it('user も all も無い場合は拒否する', () => {
    assert.throws(() => validateInput({ from: '2026-08-20', action: 'add' }), /どちらか一方/);
  });

  it('日付形式が違えば拒否する', () => {
    assert.throws(
      () => validateInput({ user: 'たろう', from: '2026/08/20', action: 'add' }),
      /YYYY-MM-DD/
    );
  });

  it('from > to は拒否する', () => {
    assert.throws(
      () => validateInput({ user: 'たろう', from: '2026-08-22', to: '2026-08-20', action: 'add' }),
      /開始日/
    );
  });

  it('31日を超える期間は拒否する', () => {
    assert.throws(
      () => validateInput({ user: 'たろう', from: '2026-01-01', to: '2026-03-01', action: 'add' }),
      /31日/
    );
  });

  it('未知の action は拒否する', () => {
    assert.throws(
      () => validateInput({ user: 'たろう', from: '2026-08-20', action: 'delete' }),
      /add/
    );
  });
});

describe('expandDateRange()', () => {
  it('開始日から終了日までを列挙する', () => {
    assert.deepStrictEqual(
      expandDateRange('2026-08-30', '2026-09-01'),
      ['2026-08-30', '2026-08-31', '2026-09-01']
    );
  });

  it('単日なら1件', () => {
    assert.deepStrictEqual(expandDateRange('2026-08-20', '2026-08-20'), ['2026-08-20']);
  });
});

describe('applyExemptChange()', () => {
  function studiedThenAbsent() {
    // 8/1 学習 → 8/2 未学習(おたすけを1消費)
    let state = confirmDayWithHistory(createInitialState(), '2026-08-01', true).state;
    return confirmDayWithHistory(state, '2026-08-02', false).state;
  }

  it('過去日を免除するとおたすけが戻る', () => {
    const state = studiedThenAbsent();
    assert.strictEqual(state.grace, GRACE_INITIAL - 1, '前提: おたすけが1減っている');

    const result = applyExemptChange(state, ['2026-08-02'], 'add');
    assert.deepStrictEqual(result.added, ['2026-08-02']);
    assert.strictEqual(result.before.grace, GRACE_INITIAL - 1);
    assert.strictEqual(result.after.grace, GRACE_INITIAL, 'リプレイでおたすけが戻る');
    assert.strictEqual(result.state.streak, 1);
  });

  it('取り消すと罰が再適用される', () => {
    const exempted = applyExemptChange(studiedThenAbsent(), ['2026-08-02'], 'add').state;
    const removed = applyExemptChange(exempted, ['2026-08-02'], 'remove');
    assert.deepStrictEqual(removed.removed, ['2026-08-02']);
    assert.strictEqual(removed.after.grace, GRACE_INITIAL - 1, 'おたすけ消費が戻る');
  });

  it('登録済みの日を再度 add しても変化しない', () => {
    const exempted = applyExemptChange(studiedThenAbsent(), ['2026-08-02'], 'add').state;
    const again = applyExemptChange(exempted, ['2026-08-02'], 'add');
    assert.deepStrictEqual(again.added, [], '追加分は0件');
    assert.strictEqual(again.after.grace, again.before.grace);
  });

  it('未登録の日を remove してもエラーにしない', () => {
    const result = applyExemptChange(studiedThenAbsent(), ['2026-08-09'], 'remove');
    assert.deepStrictEqual(result.removed, []);
  });

  it('未来日を追加してもリプレイ結果は変わらない', () => {
    const state = studiedThenAbsent();
    const result = applyExemptChange(state, ['2026-12-31'], 'add');
    assert.deepStrictEqual(result.added, ['2026-12-31']);
    assert.strictEqual(result.after.streak, result.before.streak, '未来日は現在値に影響しない');
    assert.ok(result.state.exemptDates.includes('2026-12-31'));
  });

  it('入力の状態を破壊しない', () => {
    const state = studiedThenAbsent();
    applyExemptChange(state, ['2026-08-02'], 'add');
    assert.deepStrictEqual(state.exemptDates, [], '入力の exemptDates は空のまま');
  });
});
```

（`GRACE_INITIAL` と `confirmDayWithHistory` は Task 2 で既に `src/streak.js` からエクスポート済み。追加の変更は不要）

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/set-exempt-dates.test.js`

Expected: FAIL。`Cannot find module '../scripts/set-exempt-dates'`

- [ ] **Step 3: スクリプトを実装する**

`scripts/set-exempt-dates.js` を新規作成する:

```javascript
#!/usr/bin/env node
/**
 * 学習免除日(おやすみ)を登録・取り消しする運用スクリプト。
 *
 * 免除日は「未学習でもストリークをリセットせず、おたすけも消費しない日」。
 * 未来日付(旅行の予定)にも過去日付(体調不良に翌日以降に気づいた)にも登録できる。
 * 過去日付を登録すると、その日の確定判定を学習履歴のリプレイで巻き戻して修復する。
 *
 * 誤操作を防ぐため、検証はすべてここに集約する:
 *   - --user と --all はどちらか一方が必須(--user は既存キーのみ)
 *   - 日付は YYYY-MM-DD 形式。--to 省略時は --from と同じ日
 *   - 開始日 <= 終了日。一度に指定できるのは31日まで
 *   - 過去日付が学習履歴の範囲外(replayBase より前)なら修復できないため中断する
 *
 * 形式・バージョン(1.4)の整合は src/streak.js の load/save を再利用して担保する。
 *
 * 使い方:
 *   node scripts/set-exempt-dates.js --user "たろう" --from 2026-08-20 --to 2026-08-22 --action add
 *   node scripts/set-exempt-dates.js --all --from 2026-08-20 --action remove [--dry-run]
 */

const { loadStreakData, saveStreakData, replayStreak, shiftDate } = require('../src/streak');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31; // 打ち間違いで大量の免除日を作らないための上限
const ACTIONS = ['add', 'remove'];

/**
 * `--key value` 形式の引数を素朴にパースする(値なしフラグは true)。
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * 入力を検証し、正常なら {user, all, from, to, action, dryRun} を返す。
 * 不正なら message 付きで例外を投げる(呼び出し側で終了コード1にする)。
 */
function validateInput(args) {
  const all = args.all === true;
  const user = typeof args.user === 'string' && args.user.trim() !== '' ? args.user : null;
  const dryRun = args['dry-run'] === true;

  if ((user && all) || (!user && !all)) {
    throw new Error('--user と --all はどちらか一方を指定してください');
  }

  const { from, action } = args;
  const to = args.to === undefined ? from : args.to;

  if (typeof from !== 'string' || !DATE_PATTERN.test(from)) {
    throw new Error(`--from は YYYY-MM-DD 形式で指定してください(指定値: ${from})`);
  }
  if (typeof to !== 'string' || !DATE_PATTERN.test(to)) {
    throw new Error(`--to は YYYY-MM-DD 形式で指定してください(指定値: ${to})`);
  }
  if (from > to) {
    throw new Error(`開始日は終了日以前にしてください(--from ${from} / --to ${to})`);
  }
  if (expandDateRange(from, to).length > MAX_RANGE_DAYS) {
    throw new Error(`一度に指定できるのは${MAX_RANGE_DAYS}日までです(--from ${from} / --to ${to})`);
  }
  if (!ACTIONS.includes(action)) {
    throw new Error(`--action は ${ACTIONS.join(' / ')} のいずれかを指定してください(指定値: ${action})`);
  }

  return { user, all, from, to, action, dryRun };
}

/**
 * 開始日から終了日までの日付を昇順で列挙する(純粋関数)
 *
 * @param {string} from - YYYY-MM-DD
 * @param {string} to - YYYY-MM-DD
 * @returns {string[]}
 */
function expandDateRange(from, to) {
  const dates = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    cursor = shiftDate(cursor, 1);
  }
  return dates;
}

/**
 * 免除日を増減してリプレイした新しい状態を返す(純粋関数、入力は変更しない)
 *
 * @param {object} state - ユーザーのストリーク状態
 * @param {string[]} dates - 対象日
 * @param {'add'|'remove'} action
 * @returns {{state: object, added: string[], removed: string[], before: {streak: number, grace: number}, after: {streak: number, grace: number}}}
 */
function applyExemptChange(state, dates, action) {
  const current = state.exemptDates || [];
  const currentSet = new Set(current);
  const targetSet = new Set(dates);

  const added = action === 'add' ? dates.filter(date => !currentSet.has(date)) : [];
  const removed = action === 'remove' ? current.filter(date => targetSet.has(date)) : [];

  const exemptDates = action === 'add'
    ? [...current, ...added].sort()
    : current.filter(date => !targetSet.has(date));

  const replayed = replayStreak(state.replayBase, state.history, exemptDates);

  return {
    state: {
      ...state,
      exemptDates,
      streak: replayed.streak,
      grace: replayed.grace,
      lastConfirmedDate: replayed.lastConfirmedDate
    },
    added,
    removed,
    before: { streak: state.streak, grace: state.grace },
    after: { streak: replayed.streak, grace: replayed.grace }
  };
}

/**
 * 対象日が学習履歴で修復できる範囲かを検証する。
 * 未来日付や、まだ確定していない日は履歴に無いのが当然なので、
 * チェックポイント(replayBase.date)以前の日だけを対象にする。
 *
 * @param {object} state
 * @param {string[]} dates
 * @returns {string[]} 修復できない日の配列
 */
function findUnrepairableDates(state, dates) {
  const baseDate = state.replayBase?.date;
  if (!baseDate) return [];
  return dates.filter(date => date <= baseDate);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let input;
  try {
    input = validateInput(args);
  } catch (error) {
    console.error(`[set-exempt-dates] 入力エラー: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { user, all, from, to, action, dryRun } = input;
  const dates = expandDateRange(from, to);

  const loadResult = await loadStreakData();
  if (!loadResult.success) {
    console.error(`[set-exempt-dates] 読み込みエラー: ${loadResult.error}`);
    process.exitCode = 1;
    return;
  }
  const users = loadResult.data;

  const targets = all ? Object.keys(users) : [user];

  if (targets.length === 0) {
    console.error('[set-exempt-dates] 登録済みユーザーは0件です(キャッシュ未復元またはデータ未生成の可能性)');
    process.exitCode = 1;
    return;
  }

  if (!all && !Object.prototype.hasOwnProperty.call(users, user)) {
    console.error(`[set-exempt-dates] 対象ユーザーが見つかりません: "${user}"`);
    console.error('[set-exempt-dates] 登録済みユーザー:');
    Object.keys(users).forEach(key => console.error(`  - "${key}"`));
    process.exitCode = 1;
    return;
  }

  console.log(`[set-exempt-dates] 対象: ${all ? '全員' : `"${user}"`}  期間: ${from}〜${to} (${dates.length}日)  操作: ${action}`);

  // 修復できない過去日が1人でもいれば、部分適用を避けるため何も変更せず中断する
  if (action === 'add') {
    const blocked = targets
      .map(key => ({ key, dates: findUnrepairableDates(users[key], dates) }))
      .filter(entry => entry.dates.length > 0);

    if (blocked.length > 0) {
      blocked.forEach(entry => {
        console.error(`[set-exempt-dates] "${entry.key}" は学習履歴の範囲外のため修復できません: ${entry.dates.join(', ')}`);
      });
      console.error('[set-exempt-dates] 履歴に残っていない古い日です。smilezemi-set-streak / smilezemi-set-grace スキルで手動調整してください');
      process.exitCode = 1;
      return;
    }
  }

  targets.forEach(key => {
    const result = applyExemptChange(users[key], dates, action);
    users[key] = result.state;

    const changed = action === 'add' ? result.added : result.removed;
    console.log(`[set-exempt-dates] "${key}": ${action === 'add' ? '追加' : '取り消し'} ${changed.length}件${changed.length > 0 ? ` (${changed.join(', ')})` : ''}`);
    console.log(`[set-exempt-dates]   変更前: streak=${result.before.streak} grace=${result.before.grace}`);
    console.log(`[set-exempt-dates]   変更後: streak=${result.after.streak} grace=${result.after.grace}`);
    console.log(`[set-exempt-dates]   免除日: ${result.state.exemptDates.length > 0 ? result.state.exemptDates.join(', ') : '(なし)'}`);
  });

  if (dryRun) {
    console.log('[set-exempt-dates] DRY_RUN のため保存しません');
    return;
  }

  const saveResult = await saveStreakData(users);
  if (!saveResult.success) {
    console.error(`[set-exempt-dates] 保存エラー: ${saveResult.error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[set-exempt-dates] 保存しました');
}

// テストから純粋関数を読み込めるよう、直接実行されたときだけ main を走らせる
if (require.main === module) {
  main();
}

module.exports = { parseArgs, validateInput, expandDateRange, applyExemptChange, findUnrepairableDates };
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/set-exempt-dates.test.js`

Expected: PASS

- [ ] **Step 5: show-streak-data.js に免除日と履歴を表示する**

`scripts/show-streak-data.js` の `keys.forEach` のブロックを差し替える:

```javascript
  keys.forEach(key => {
    const s = users[key];
    console.log(
      `  - "${key}": streak=${s.streak} grace=${s.grace} bonus=${s.bonus ?? 0} course=${s.course ?? '(未設定)'} lastConfirmedDate=${s.lastConfirmedDate ?? 'null'}`
    );

    const exemptDates = s.exemptDates ?? [];
    console.log(`      免除日: ${exemptDates.length > 0 ? exemptDates.join(', ') : '(なし)'}`);

    // 直近7日ぶんの履歴。免除日の登録可否(履歴の範囲内か)を判断するために出す
    const recent = Object.keys(s.history ?? {}).sort().slice(-7);
    const summary = recent.map(date => `${date}=${s.history[date] ? '学習' : '未学習'}`).join(' ');
    console.log(`      直近の履歴: ${recent.length > 0 ? summary : '(なし)'}`);
  });
```

冒頭の JSDoc の「使い方」より前の説明文に1行足す:

```javascript
 * 免除日(おやすみ)の登録前に、対象日が学習履歴に残っているかを確認するためにも使う。
```

- [ ] **Step 6: 全テストと lint を実行する**

Run: `npm test`
Expected: PASS

Run: `npm run lint`
Expected: 警告・エラーなし（`scripts/` は lint 対象外だが、`src/` の変更が無いことの確認として実行する）

- [ ] **Step 7: コミットする**

```bash
git add scripts/set-exempt-dates.js scripts/show-streak-data.js tests/set-exempt-dates.test.js src/streak.js
git commit -m "feat: 免除日の登録スクリプトを追加する"
```

---

### Task 4: 運用ワークフローとスキル

**Files:**
- Create: `.github/workflows/exempt-days.yml`
- Create: `.claude/skills/smilezemi-exempt-day/SKILL.md`

**Interfaces:**
- Consumes: Task 3 の `scripts/set-exempt-dates.js`（`--user` / `--all` / `--from` / `--to` / `--action` / `--dry-run`）
- Produces: `exempt-days.yml`（`workflow_dispatch` の入力 `user` / `from` / `to` / `action` / `dry_run`）

- [ ] **Step 1: ワークフローを作成する**

`.github/workflows/exempt-days.yml` を新規作成する:

```yaml
name: 学習免除日の登録・取り消し

# 免除日(おやすみ)を登録・取り消しする。免除日は未学習でもストリークをリセットせず
# おたすけも消費しない。未来日付にも過去日付にも登録でき、過去日付は学習履歴の
# リプレイで確定済みの判定を巻き戻して修復する。
# キャッシュを復元 → scripts/set-exempt-dates.js で更新 → 新しい run_id キーで保存。
#
# 検証(日付形式・期間の上限・履歴の範囲)はスクリプト側に集約している。
# 注意: スケジュール実行と同時刻に走らせるとキャッシュ保存が後勝ちで競合しうるため、
#       通知ワークフローが動いていない時間帯に実行すること。

on:
  workflow_dispatch:
    inputs:
      user:
        description: 'ユーザーキー(完全一致)。全員に適用するなら __all__ を指定。show-streak-dataで正確なキーを確認'
        required: true
        type: string
      from:
        description: 開始日 (YYYY-MM-DD)
        required: true
        type: string
      to:
        description: 終了日 (YYYY-MM-DD)。省略すると開始日と同じ日(単日)。一度に31日まで
        required: false
        type: string
      action:
        description: 免除日を登録するか取り消すか
        required: true
        type: choice
        options:
          - add
          - remove
      dry_run:
        description: true にすると変更内容を表示するだけで保存しない
        required: false
        type: boolean
        default: false

jobs:
  exempt:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      actions: read # キャッシュ整合性チェック(gh api)に必要

    steps:
      - name: リポジトリをチェックアウト
        uses: actions/checkout@v4

      - name: 前回データを復元
        id: restore-data
        uses: actions/cache/restore@v4
        with:
          path: data
          key: smilezemi-data-${{ github.run_id }}
          restore-keys: |
            smilezemi-data-

      # 既存エントリがあるのに復元できなかった場合はキャッシュ異常の可能性が高い。
      # 空データに変更を書いて保存すると履歴が実質消失するため中断する
      - name: キャッシュ復元の整合性を検証
        if: steps.restore-data.outputs.cache-matched-key == ''
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          count=$(gh api "repos/${GITHUB_REPOSITORY}/actions/caches?key=smilezemi-data-" --jq '.total_count')
          if [ "$count" -gt 0 ]; then
            echo "::error::既存のキャッシュエントリ(${count}件)があるのに復元できませんでした。データ保護のためジョブを中断します。"
            exit 1
          fi
          echo "キャッシュエントリなし(初回実行またはエビクション後)"

      - name: Node.jsをセットアップ
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      # 入力はシェルへ直接展開せず env 経由で渡す(インジェクション防止)
      - name: 免除日を更新
        env:
          USER_KEY: ${{ inputs.user }}
          FROM_DATE: ${{ inputs.from }}
          TO_DATE: ${{ inputs.to }}
          ACTION: ${{ inputs.action }}
          DRY_RUN: ${{ inputs.dry_run }}
        run: |
          TO_FLAG=""
          if [ -n "${TO_DATE}" ]; then
            TO_FLAG="--to ${TO_DATE}"
          fi

          DRY_FLAG=""
          if [ "${DRY_RUN}" = "true" ]; then
            DRY_FLAG="--dry-run"
          fi

          # ユーザーキーは引用符付きで直接渡す(変数に組み立てると空白入りのキーで壊れるため)
          if [ "${USER_KEY}" = "__all__" ]; then
            node scripts/set-exempt-dates.js --all --from "${FROM_DATE}" ${TO_FLAG} --action "${ACTION}" ${DRY_FLAG}
          else
            node scripts/set-exempt-dates.js --user "${USER_KEY}" --from "${FROM_DATE}" ${TO_FLAG} --action "${ACTION}" ${DRY_FLAG}
          fi

      # 変更が成功し、かつ dry_run でない場合のみ新しいキャッシュとして保存する
      - name: 変更後データを保存
        if: ${{ success() && !inputs.dry_run }}
        uses: actions/cache/save@v4
        with:
          path: data
          key: smilezemi-data-${{ github.run_id }}
```

- [ ] **Step 2: ワークフローの構文を確認する**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/exempt-days.yml','utf-8');if(!s.includes('workflow_dispatch'))throw new Error('workflow_dispatch がない');console.log('OK: ' + s.split('\n').length + '行');"`

Expected: `OK: <行数>` が出力される

Run: `npm run validate:all`
Expected: 既存の検証がすべて通る

- [ ] **Step 3: 運用スキルを作成する**

`.claude/skills/smilezemi-exempt-day/SKILL.md` を新規作成する:

```markdown
---
name: smilezemi-exempt-day
description: スマイルゼミ通知システムの「学習免除日(おやすみ)」を登録・取り消しするときに使う。旅行・体調不良・行事などで勉強できない日をストリークの対象外にしたい、その日はおたすけを使わずに記録を守りたい、免除の登録を取り消したいといった依頼で必ずこのスキルを使うこと。未来日付の事前登録にも、既に確定してしまった過去日付の修復にも使える。おたすけ(grace)そのものの増減は smilezemi-set-grace、連続日数(streak)の直接変更は smilezemi-set-streak という別スキルなので、値を直接いじる依頼ではそちらを使う。変更は本番(GitHub Actions キャッシュ)に反映される。
---

# 学習免除日(おやすみ)の登録・取り消し

勉強できない日を「免除日」として登録する。免除日は**未学習でもストリークをリセットせず、おたすけ(grace)も消費しない**。免除日に学習していれば通常どおり加算されるので、登録しておいて損はない。

このスキルは `exempt-days.yml` ワークフローだけを使う。streak / grace / bonus の値を直接書き換えたい依頼には使わない（それぞれ専用スキルがある）。

## 前提

- 実データは GitHub Actions のキャッシュ（`smilezemi-data-*`）にのみ存在し、ローカルには無い。
  そのため確認も変更もすべて `gh` 経由のワークフロー実行で行う。
- 変更は次回のスケジュール通知（夜 20:00 / 朝 7:00）で自動的に反映される。
- 通知ワークフローが動いている時間帯に実行するとキャッシュ保存が後勝ちで競合しうる。
  スケジュールとぶつからない時間帯に実行すること。
- `gh` CLI がこのリポジトリに対して認証済みであること。

## 免除日の制約

- 日付は `YYYY-MM-DD` 形式。`to` を省略すると単日になる。
- 一度に指定できる期間は **31日** まで。
- **過去日付は学習履歴が残っている範囲（直近90日、かつ機能導入後）でのみ修復できる。**
  範囲外の日はスクリプトが中断するので、その場合は `smilezemi-set-streak` /
  `smilezemi-set-grace` スキルで手動調整する。
- 未来日付には制限がない（旅行の予定などを事前に登録できる）。

## 手順

### 1. 対象と期間を確定する

ユーザーに「どの子（全員か）」「いつからいつまで」「登録か取り消しか」を確認する。
家族旅行なら全員、体調不良なら1人であることが多い。

### 2. 現在値と正確なユーザーキーを確認する

ユーザーキーは完全一致が必要で、形式は環境依存（例: `"やまだたろうさん"`）。
推測せず、必ず読み取り専用ワークフローで実際のキーを確認してコピーする:

```bash
gh workflow run show-streak-data.yml
# 起動直後は run が一覧に出ないことがあるため、現れるまで数秒待って取得する
RUN_ID=$(gh run list --workflow=show-streak-data.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep show-streak-data
```

出力の `"<キー>"` から正確なキーを、`免除日:` から既存の登録を、`直近の履歴:` から
過去日付が修復できる範囲かを読み取る。

### 3. まず dry-run で変更内容を確認する（事故防止）

いきなり保存せず、`dry_run=true` で「変更前→変更後」を確認し、ユーザーに提示して合意を得る:

```bash
gh workflow run exempt-days.yml \
  -f user="<手順2で確認した正確なキー、または __all__>" \
  -f from=<YYYY-MM-DD> \
  -f to=<YYYY-MM-DD> \
  -f action=add \
  -f dry_run=true
RUN_ID=$(gh run list --workflow=exempt-days.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep set-exempt-dates
```

過去日付の場合は「変更後」の `streak` / `grace` が増えているはずで、これが修復された証拠になる。

### 4. 本番反映する

dry-run の内容で問題なければ、`dry_run` を付けずに（または `false` で）実行して保存する:

```bash
gh workflow run exempt-days.yml \
  -f user="<正確なキー、または __all__>" \
  -f from=<YYYY-MM-DD> \
  -f to=<YYYY-MM-DD> \
  -f action=add
RUN_ID=$(gh run list --workflow=exempt-days.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep set-exempt-dates
```

取り消しは `-f action=remove` を渡す。取り消すとその日の罰が再適用される点をユーザーに伝えること。

### 5. 結果を報告する

ログの「追加 N件」「変更前: streak=X grace=Y」「変更後: streak=X grace=Y」「保存しました」を確認し、
ユーザーに報告する。実際の通知メッセージには次回のスケジュール実行で反映される旨も伝える。

## 失敗時の対応

- 「対象ユーザーが見つかりません」→ 手順2に戻り、候補一覧から正確なキーをコピーし直す。
- 「学習履歴の範囲外のため修復できません」→ 古すぎる日。`smilezemi-set-streak` /
  `smilezemi-set-grace` スキルで手動調整する。
- 「一度に指定できるのは31日までです」→ 期間を分けて複数回実行する。
- 整合性チェックで中断（既存キャッシュあるのに復元失敗）→ キャッシュサービス異常の可能性。
  時間を置いて再実行する。空データを保存させないための安全機構なので、無理に回避しない。
```

- [ ] **Step 4: 全テストと lint を実行する**

Run: `npm test`
Expected: PASS

Run: `npm run validate:all`
Expected: 通る

- [ ] **Step 5: コミットする**

```bash
git add .github/workflows/exempt-days.yml .claude/skills/smilezemi-exempt-day/SKILL.md
git commit -m "feat: 免除日のワークフローと運用スキルを追加する"
```

---

### Task 5: 通知への反映

**Files:**
- Modify: `src/notifier.js`（`formatDetailedMessage` のオプションと警告ブロック）
- Modify: `src/index.js`（夜: ストリークデータ読み込み、当日免除の判定、LINE送信判定からの除外）
- Modify: `src/morning-index.js`（朝: `exempt` イベントのユーザーを渡す）
- Test: `tests/notifier.test.js`, `tests/index.test.js`

**Interfaces:**
- Consumes: Task 2 の `loadStreakData()`（`exemptDates` 付きの状態を返す）と `updateStreaksByCourse` の `results`（`event: 'exempt'` を含む）
- Produces: `formatDetailedMessage(userData, missionChanges, options)` に `options.exemptUserNames`（`string[]`、既定 `null`）と `options.showExemptNotice`（`boolean`、既定 `false`）が加わる
- Produces: `EXEMPT_NOTICE = '🏝️ 今日はおやすみ（免除日）'`（`src/notifier.js` の定数）

- [ ] **Step 1: notifier のテストを書く**

`tests/notifier.test.js` に追加する:

```javascript
describe('formatDetailedMessage() - 免除日', () => {
  const user = { userName: 'たろう', studyItemCount: 0, missionCount: 0, missions: [], date: '2026-08-17' };

  it('免除ユーザーには未達警告を出さない', () => {
    const message = formatDetailedMessage([user], null, {
      missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
      missionWarningStyle: 'today',
      exemptUserNames: ['たろう']
    });
    assert.ok(!message.includes('あと'), `未達警告が出ている: ${message}`);
  });

  it('showExemptNotice が true ならおやすみ行を出す', () => {
    const message = formatDetailedMessage([user], null, {
      missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
      missionWarningStyle: 'today',
      exemptUserNames: ['たろう'],
      showExemptNotice: true
    });
    assert.ok(message.includes('🏝️ 今日はおやすみ（免除日）'), message);
  });

  it('showExemptNotice を省略するとおやすみ行は出ない(朝通知はストリーク行で伝える)', () => {
    const message = formatDetailedMessage([user], null, {
      missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
      exemptUserNames: ['たろう']
    });
    assert.ok(!message.includes('🏝️'), message);
  });

  it('免除ユーザー以外には従来どおり警告を出す', () => {
    const others = [user, { ...user, userName: 'はなこ' }];
    const message = formatDetailedMessage(others, null, {
      missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
      missionWarningStyle: 'today',
      exemptUserNames: ['たろう']
    });
    assert.ok(message.includes('あと4件'), `はなこの警告が出ていない: ${message}`);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`

Expected: FAIL。`exemptUserNames` が未実装のため、免除ユーザーにも警告が出て1本目と2本目が落ちる

- [ ] **Step 3: notifier を実装する**

`src/notifier.js` の `MISSION_WARNING_STYLES` の定義の近くに定数を足す:

```javascript
// 免除日(おやすみ)の告知行。夜通知だけが出す(朝はストリーク行が伝えるため)
const EXEMPT_NOTICE = '🏝️ 今日はおやすみ（免除日）';
```

`formatDetailedMessage` の分割代入に2つ足す:

```javascript
    missionWarningStyle = 'past',
    exemptUserNames = null,
    showExemptNotice = false
```

JSDoc に2行足す:

```javascript
 * @param {string[]} [options.exemptUserNames=null] - 免除日のユーザー名。未達警告を出さない
 * @param {boolean} [options.showExemptNotice=false] - 免除ユーザーに「おやすみ」行を出すか(夜通知は true)
```

未達警告のブロック（`const warnThreshold = ...` から始まる部分）を差し替える:

```javascript
    // 完了数未達の警告。コース別しきい値(missionWarningThresholds)を優先し、
    // なければ単一の missionWarningThreshold を使う(後方互換)。
    // 免除日(おやすみ)のユーザーには警告を出さない。
    const warnThreshold = missionWarningThresholds
      ? (isJuniorHigh ? missionWarningThresholds.juniorHigh : missionWarningThresholds.elementary)
      : missionWarningThreshold;

    const isExempt = Array.isArray(exemptUserNames) && exemptUserNames.includes(user.userName);

    if (isExempt) {
      if (showExemptNotice) {
        message += `${EXEMPT_NOTICE}\n`;
      }
    } else if (warnThreshold && user.dataReliable !== false && !(showNoStudyWarning && isNoStudy)) {
      const completedCount = countStudyItems(user);
      if (completedCount < warnThreshold) {
        const formatWarning = Object.hasOwn(MISSION_WARNING_STYLES, missionWarningStyle)
          ? MISSION_WARNING_STYLES[missionWarningStyle]
          : MISSION_WARNING_STYLES.past;
        message += `${formatWarning(warnThreshold - completedCount)}\n`;
      }
    }
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`

Expected: PASS

- [ ] **Step 5: 夜通知のテストを書く**

まず `tests/index.test.js` の crawler モックに `getTargetDates` を戻す。`getUserList` の行の末尾にカンマを足し、その下に追加する（前のブランチで `src/index.js` が使わなくなったため削除された行を、本タスクで再び使うので復活させる）:

```javascript
        getUserList: overrides.getUserList || (async () => ({ success: true, users: [{ name: '太郎', index: 0 }] })),
        getTargetDates: overrides.getTargetDates || (() => ({ dateString: '2025-12-24', withPadding: '2025-12-24' }))
```

streak モジュールのモックには `loadStreakData` が既にあるので追加は不要。テストからは `overrides.loadStreakData` で差し替える。

`describe('main() - メイン実行フロー', ...)` の中に、既存の「全員達成の日はDiscordのみ」テストと同じ形でテストを追加する（このファイルは `setupMocks(overrides)` でモックを差し替え、`mainModule.main()` を呼び、`callLog` を検証するパターン）:

```javascript
    it('正常系: 免除日のユーザーは未達に数えずDiscordのみに送る', async () => {
      setupMocks({
        isStudied: () => false, // 全員がしきい値未達
        loadStreakData: async () => ({
          success: true,
          data: { '太郎': { exemptDates: ['2025-12-24'] } } // getTargetDates モックと同じ日
        })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 0,
        '免除日のユーザーしかいない日はLINE経路を使わないこと'
      );
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToDiscordOnly').length, 1,
        'Discordには記録として送ること'
      );
    });

    it('正常系: 免除日でないユーザーが未達なら従来どおりLINEに送る', async () => {
      setupMocks({
        isStudied: () => false,
        loadStreakData: async () => ({
          success: true,
          data: { '太郎': { exemptDates: ['2025-12-01'] } } // 当日ではない免除日
        })
      });

      await mainModule.main();

      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 1,
        '免除日でない未達ユーザーがいればLINEに送ること'
      );
    });

    it('正常系: ストリークデータを読めなくても免除なしとして通知を続ける', async () => {
      setupMocks({
        isStudied: () => false,
        loadStreakData: async () => ({ success: false, error: '読み込み失敗' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true, '通知処理は止めないこと');
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 1,
        '免除なし扱いで従来どおり送ること'
      );
    });
```

- [ ] **Step 6: 夜通知を実装する**

`src/index.js` の crawler の import に `getTargetDates` を戻す:

```javascript
const { getAllUsersDetailedData, getAllUsersMissionCounts, getUserList, getTargetDates } = require('./crawler');
```

streak の import に `loadStreakData` を足す:

```javascript
const { isStudied, getRequirementForCourse, loadStreakData } = require('./streak');
```

「6.5 当日のストリーク要件の達成判定」のブロックを差し替える:

```javascript
    // 6.5 当日のストリーク要件の達成判定
    // 夜通知はストリーク・おたすけ・ボーナスを表示しない(翌朝の確定通知がカバーする)ため
    // ストリーク値そのものは使わない。免除日(おやすみ)の判定にだけデータを読む。
    const todayDateString = getTargetDates(0).dateString;

    const streakLoadResult = await loadStreakData();
    if (!streakLoadResult.success) {
      // 免除日が分からなくても通知は続ける(免除なし扱い)。子供に見える情報を止めないため
      console.warn('⚠️ ストリークデータを読めなかったため免除日なしとして続行します:', streakLoadResult.error);
    }
    const streakUsers = streakLoadResult.success ? streakLoadResult.data : {};

    const exemptUserNames = currentData
      .filter(user => (streakUsers[user.userName]?.exemptDates ?? []).includes(todayDateString))
      .map(user => user.userName);

    if (exemptUserNames.length > 0) {
      console.log(`🏝️ 免除日のユーザー: ${exemptUserNames.join(', ')}`);
    }

    let hasUnqualifiedUser = false;
    currentData.forEach(user => {
      // 免除日のユーザーは未達に数えない(免除日のためにLINEを消費しない)
      if (exemptUserNames.includes(user.userName)) {
        return;
      }
      const threshold = getRequirementForCourse(user.course);
      if (!isStudied(user, { minCompletedMissions: threshold })) {
        hasUnqualifiedUser = true;
      }
    });
```

`formatDetailedMessage` の呼び出しにオプションを2つ足す:

```javascript
    const message = formatDetailedMessage(currentData, missionChangesResult, {
      showStudyTime: false,
      missionWarningStyle: 'today',
      missionWarningThresholds: {
        elementary: getRequirementForCourse('elementary'),
        juniorHigh: getRequirementForCourse('juniorHigh')
      },
      exemptUserNames,
      showExemptNotice: true
    });
```

- [ ] **Step 7: 朝通知を実装する**

`src/morning-index.js` の `streaks` を組み立てているブロックの直後に追加する:

```javascript
    // 免除日のユーザーには未達警告を出さない(ストリーク行が「記録はそのまま」と伝える)
    const exemptUserNames = results
      .filter(result => result.event === 'exempt')
      .map(result => result.userName);
```

`formatDetailedMessage` の呼び出しにオプションを1つ足す:

```javascript
    const message = formatDetailedMessage(crawlResult.data, null, {
      dateLabel: `昨日(${targetDates.withPadding})`,
      showNoStudyWarning: true,
      streaks,
      missionWarningStyle: 'past',
      missionWarningThresholds: {
        elementary: STREAK_REQUIREMENTS.elementaryMissions,
        juniorHigh: STREAK_REQUIREMENTS.juniorHighCourses
      },
      exemptUserNames
    });
```

- [ ] **Step 8: 全テストと lint を実行する**

Run: `npm test`
Expected: PASS

Run: `npm run lint`
Expected: 警告・エラーなし

- [ ] **Step 9: 夜通知のドライランで文面を目視する**

Run: `DRY_RUN=true node -r dotenv/config src/index.js`

Expected: 実クロールが走る。`.env` が無い、または認証情報が無い環境では実行できないので、その場合はスキップして次のステップへ進み、報告にその旨を書くこと。実行できた場合は、免除日を登録していないため「おやすみ」行が出ないことだけ確認する。

- [ ] **Step 10: コミットする**

```bash
git add src/notifier.js src/index.js src/morning-index.js tests/notifier.test.js tests/index.test.js
git commit -m "feat: 免除日を通知に反映する"
```

---

### Task 6: ドキュメントの追随

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1〜5 の成果すべて
- Produces: なし（ドキュメントのみ）

- [ ] **Step 1: ストリーク機能の説明に免除日を足す**

`CLAUDE.md` の「### ストリーク（連続学習日数）機能」の箇条書きに、`- 未学習日はおたすけを自動消費してストリーク維持（+1しない）。尽きたらストリーク・おたすけとも0にリセット` の**直後**に次の項目を挿入する:

```markdown
- **免除日（おやすみ）**: `exemptDates` に登録した日は未学習でもストリークをリセットせず、おたすけも消費しない（イベント `exempt`）。免除日に学習していれば通常どおり加算される。`streak`・`grace` は各ユーザーの学習履歴（`history`: 判定対象日→学習が成立したか、保持90日）を `replayStreak()` でリプレイして導出するため、**過去日付を後から免除に指定すると確定済みの判定が巻き戻って修復される**。`bonus` はリプレイ対象外（支給済みの現金のため）。履歴より古い日（90日超・機能導入前）は修復できず、その場合は streak/grace の手動変更スキルを使う。詳細: `docs/superpowers/specs/2026-08-17-study-exemption-design.md`
```

- [ ] **Step 2: 夜通知が streak_data.json を読むようになった点を直す**

同じ「ストリーク（連続学習日数）機能」節の冒頭の段落から、夜通知がストリークデータを読まない旨の記述を直す。変更前:

```markdown
**ストリーク確定は朝通知が両コースまとめて前日分で行う(唯一の確定点)。夜通知は速報で、ストリーク値を一切表示しない(当日の要件達成判定だけをLINE送信可否に使う)。**
```

変更後:

```markdown
**ストリーク確定は朝通知が両コースまとめて前日分で行う(唯一の確定点)。夜通知は速報で、ストリーク値を一切表示しない(当日の要件達成判定だけをLINE送信可否に使う)。夜通知も `streak_data.json` は読むが、免除日(`exemptDates`)を見るためだけで、確定も表示もしない。**
```

「Three Entry Points」の1番（日次通知）の説明にも同じ趣旨が書かれているので、`streak_data.json` も読まない` の部分を `streak_data.json` は免除日の判定にだけ読む` に直す。

- [ ] **Step 3: 運用スキルの一覧に追加する**

「### ストリーク値の手動変更 (運用スキル)」の節の末尾に1文足す:

```markdown
免除日（おやすみ）の登録・取り消しは別系統で、`exempt-days.yml` (workflow_dispatch) → `scripts/set-exempt-dates.js` → `.claude/skills/smilezemi-exempt-day` が担当する。対象(1人/`__all__`)と期間(最大31日)を指定し、過去日付はリプレイで修復される。
```

- [ ] **Step 4: Project Structure のツリーを更新する**

`scripts/` の説明行に `set-exempt-dates.js` を足し、`.github/workflows/` のツリーに1行足す:

```text
├── exempt-days.yml           # 手動: 免除日(おやすみ)の登録・取り消し (workflow_dispatch)
```

- [ ] **Step 5: 古い記述が残っていないか確認する**

Run: `grep -n "streak_data.json. も読まない\|読まない" CLAUDE.md`
Expected: 夜通知がストリークデータを読まないと書いた箇所が残っていないこと

Run: `npm test`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add CLAUDE.md
git commit -m "docs: 学習免除日(おやすみ)機能をCLAUDE.mdに反映する"
```
