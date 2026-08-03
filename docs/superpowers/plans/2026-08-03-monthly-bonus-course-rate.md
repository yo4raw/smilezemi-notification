# 月次ボーナス清算のコース別単価を修正する 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 月次ボーナス清算の単価判定を、表示名の文字列マッチから `streak_data.json` に保存した `course` フィールドに置き換え、中学生コースが正しく ¥50 で清算されるようにする。

**Architecture:** 朝通知の確定処理（`src/streak.js` の `updateStreaks()`）がクロール結果の `user.course` を状態へ保存し、`settleBonuses()` がそれを清算リストに載せる。`src/monthly-bonus-index.js` はコースで単価を決め、メッセージに単価を明示する。

**Tech Stack:** Node.js >= 24 / CommonJS / Node.js built-in test runner (`node --test`) / oxlint

## Global Constraints

- モジュールシステムは CommonJS（`require` / `module.exports`）。ESM は使わない
- コード内コメント・ログ・Markdown・コミットメッセージはすべて日本語で書く
- **`streak_data.json` の `version` は `'1.3'` のまま上げない。** `loadStreakData()` の移行判定が `if (version !== '1.3') { state.grace = GRACE_MAX }` とハードコードされているため（`src/streak.js:347-351`）、上げると既存 1.3 データにおたすけ満タン付与が誤って再発火する
- `course` の値は `'elementary'` または `'juniorHigh'`。未設定・未知の値はすべて `'elementary'` 扱い（既存の `user.course || 'elementary'` の慣例に揃える）
- 単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN`（`elementary: 30` / `juniorHigh: 50`）に集約する。この定数の定義位置と値は変更しない
- `src/streak.js` の純粋関数（`confirmDay` / `updateStreaks` / `updateStreaksByCourse` / `settleBonuses`）は入力オブジェクトを破壊しない性質を維持する
- **テストの fixture に `"名前 (コース名)"` 形式のユーザーキーを新たに増やさない。** 本番のキーは素の名前であり、この前提のズレが今回のバグを見逃した原因である
- 実在の子どもの名前を書かない。テスト・ドキュメントでは架空名（たろう / はなこ / じろう / やまだ）を使う
- テストコマンドは `npm test`（全件）。単一ファイルは `node --test --test-force-exit --experimental-test-isolation=none tests/<file>`（オプション2つは必須）
- lint は `npm run lint`（`--deny-warnings` で警告もエラー扱い）
- 作業ブランチは `fix/monthly-bonus-course-rate`（作成済み、設計書コミット `ca6cdca` を含む）

---

### Task 1: ストリーク状態に `course` を保存する

**Files:**
- Modify: `src/streak.js`
- Test: `tests/streak.test.js`

**Interfaces:**
- Consumes: なし（本計画の最初のタスク）
- Produces:
  - `updateStreaks(streakUsers, users, dateString, options)` — 各ユーザー状態に `course` を保存するようになる（引数・戻り値の形は不変）
  - `settleBonuses(streakUsers)` — settlements の要素が `{ userName: string, bonus: number, course: string|undefined }` になる。Task 2 が使う

**重要な前提（実装前に必ず読むこと）:**

`confirmDay()` は全分岐で状態オブジェクトを新規に組み立て直しており、`...state` を展開していません。したがって `confirmDay()` に `course` 入りの状態を渡しても、返ってくる状態から `course` は消えます。`confirmDay()` は連続日数の遷移だけを担う関数で、コースはそれと直交するメタデータなので、**`confirmDay()` は変更せず、その後段で `course` を付け直します**。

同じ理由で、`user.course` が undefined のときに既存の `course` を失わないよう、`current.course` をフォールバックに使います。

- [ ] **Step 1: 失敗するテストを書く**

`tests/streak.test.js` の `describe('settleBonuses', ...)` ブロックの**閉じ括弧の直後**に、次の describe を追加する:

```js
describe('updateStreaks - コース種別の保存', () => {
  const studiedElementaryUser = {
    userName: 'はなこ',
    course: 'elementary',
    studyTime: { hours: 1, minutes: 0 },
    missionCount: 4,
    missions: []
  };

  it('確定したユーザーの状態に course を保存する', () => {
    const { streakUsers } = updateStreaks({}, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(streakUsers['はなこ'].course, 'elementary');
    assert.strictEqual(streakUsers['はなこ'].streak, 1, 'ストリークの確定は従来どおり行われること');
  });

  it('中学生コースの course も保存する', () => {
    const juniorHighUser = {
      userName: 'たろう',
      course: 'juniorHigh',
      studyTime: { hours: 1, minutes: 0 },
      missionCount: 3,
      missions: []
    };
    const { streakUsers } = updateStreaks({}, [juniorHighUser], '2026-07-12', { minCompletedMissions: 3 });

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh');
  });

  it('results に載る状態にも course が含まれる', () => {
    const { results } = updateStreaks({}, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(results[0].state.course, 'elementary');
  });

  it('dataReliable:false で確定をスキップする場合も course は保存する', () => {
    const initial = {
      'たろう': { streak: 5, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-11' }
    };
    const unreliableNotStudiedUser = {
      userName: 'たろう',
      course: 'juniorHigh',
      studyTime: { hours: 0, minutes: 0 },
      missions: [],
      dataReliable: false
    };
    const { streakUsers, results } = updateStreaks(initial, [unreliableNotStudiedUser], '2026-07-12');

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh', 'コースは学習判定と無関係に分かるため保存すること');
    assert.strictEqual(streakUsers['たろう'].streak, 5, 'ストリークは変わらないこと');
    assert.strictEqual(streakUsers['たろう'].grace, 1, 'おたすけは変わらないこと');
    assert.strictEqual(streakUsers['たろう'].bonus, 0, 'ボーナスは変わらないこと');
    assert.strictEqual(streakUsers['たろう'].lastConfirmedDate, '2026-07-11', '確定日は進めないこと');
    assert.strictEqual(results[0].event, 'none');
  });

  it('user.course が未指定なら既存の course を保持する', () => {
    const initial = {
      'たろう': { streak: 5, grace: 1, bonus: 0, course: 'juniorHigh', lastConfirmedDate: '2026-07-11' }
    };
    const noCourseUser = {
      userName: 'たろう',
      studyTime: { hours: 1, minutes: 0 },
      missionCount: 4,
      missions: []
    };
    const { streakUsers } = updateStreaks(initial, [noCourseUser], '2026-07-12');

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh', '未指定で既存値を消さないこと');
    assert.strictEqual(streakUsers['たろう'].streak, 6, '確定は従来どおり行われること');
  });

  it('入力のマップを変更しない(純粋関数)', () => {
    const initial = {
      'はなこ': { streak: 3, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-11' }
    };
    updateStreaks(initial, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(initial['はなこ'].course, undefined, '入力側に course が生えないこと');
    assert.strictEqual(initial['はなこ'].streak, 3);
  });

  it('同日再実行でも course は保存される(冪等な確定スキップ経路)', () => {
    const initial = {
      'はなこ': { streak: 3, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' }
    };
    const { streakUsers } = updateStreaks(initial, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(streakUsers['はなこ'].course, 'elementary');
    assert.strictEqual(streakUsers['はなこ'].streak, 3, '同日再実行でストリークは進まないこと');
  });
});

describe('settleBonuses - コース種別の引き継ぎ', () => {
  it('settlements に course を載せる', () => {
    const users = {
      'たろう': { streak: 20, grace: 3, bonus: 3, course: 'juniorHigh', lastConfirmedDate: '2026-07-31' },
      'はなこ': { streak: 5, grace: 1, bonus: 2, course: 'elementary', lastConfirmedDate: '2026-07-31' }
    };
    const { settlements } = settleBonuses(users);

    assert.deepStrictEqual(
      settlements.map(s => [s.userName, s.bonus, s.course]).sort(),
      [
        ['たろう', 3, 'juniorHigh'],
        ['はなこ', 2, 'elementary']
      ].sort()
    );
  });

  it('course のないユーザーは course: undefined で返す', () => {
    const users = {
      'じろう': { streak: 1, grace: 1, bonus: 1, lastConfirmedDate: '2026-07-31' }
    };
    const { settlements } = settleBonuses(users);

    assert.strictEqual(settlements[0].course, undefined);
  });

  it('リセット後の状態でも course は残る', () => {
    const users = {
      'たろう': { streak: 20, grace: 3, bonus: 3, course: 'juniorHigh', lastConfirmedDate: '2026-07-31' }
    };
    const { streakUsers } = settleBonuses(users);

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh');
    assert.strictEqual(streakUsers['たろう'].bonus, 0);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js`
Expected: FAIL。「確定したユーザーの状態に course を保存する」で `undefined !== 'elementary'`

- [ ] **Step 3: `withCourse()` ヘルパを追加する**

`src/streak.js` の `updateStreaks()` 関数定義の**手前**に追加する:

```js
/**
 * 状態にコース種別を反映した新しい状態を返す(純粋関数)
 *
 * course は学習したかどうかと無関係にクロール結果から分かる情報なので、
 * 確定判定の成否によらず保存する。月次清算(src/monthly-bonus-index.js)が
 * ポイント単価を決めるために使う。course が未指定のときは状態をそのまま返す。
 *
 * @private
 * @param {object} state - ストリーク状態
 * @param {'elementary'|'juniorHigh'|undefined} course
 * @returns {object}
 */
function withCourse(state, course) {
  if (!course || state.course === course) {
    return state;
  }
  return { ...state, course };
}
```

- [ ] **Step 4: `updateStreaks()` の本体を差し替える**

`src/streak.js` の `updateStreaks()` 内、`users.forEach(user => { ... });` のコールバック本体をまるごと次に差し替える:

```js
  users.forEach(user => {
    const current = updated[user.userName] || createInitialState();
    const studied = isStudied(user, options);

    // confirmDay() は全分岐で状態を新規に組み立て直すため course が落ちる。
    // course は連続日数の遷移と直交するメタデータなので confirmDay には持ち込まず、
    // 遷移の後段でここで付け直す。user.course 未指定時は既存値を引き継ぐ。
    const course = user.course || current.course;

    // dataReliable: false かつ未学習判定の場合、クロール部分失敗によるデフォルト値(0/[])
    // が原因の偽陰性である可能性があるため確定をスキップする(空白日の中立処理に委ねる)。
    // 学習した証跡がある場合(studied === true)は信頼して通常通り確定する。
    // 確定はしないが course だけは保存する(学習判定と無関係に分かる情報のため)。
    if (user.dataReliable === false && !studied) {
      const skipped = withCourse(current, course);
      updated[user.userName] = skipped;
      results.push({ userName: user.userName, state: skipped, event: 'none' });
      return;
    }

    const { state: confirmed, event } = confirmDay(current, dateString, studied);
    const state = withCourse(confirmed, course);
    updated[user.userName] = state;
    results.push({ userName: user.userName, state, event });
  });
```

- [ ] **Step 5: `settleBonuses()` に course を載せる**

`src/streak.js` の `settleBonuses()` 内、`settlements.push({ userName, bonus: state.bonus ?? 0 });` の行を次に差し替える:

```js
    // course は月次清算がポイント単価を決めるために使う(未設定は呼び出し側で小学生扱い)
    settlements.push({ userName, bonus: state.bonus ?? 0, course: state.course });
```

- [ ] **Step 6: テストと lint を実行する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/streak.test.js && npm run lint`
Expected: PASS（新規10件を含む全件）。既存の `dataReliable:false` テスト（course を持たない fixture）と 1.3 移行テスト群も無変更で通ること

- [ ] **Step 7: 全テストを実行する**

Run: `npm test`
Expected: PASS（全ファイル）

- [ ] **Step 8: コミットする**

```bash
git add src/streak.js tests/streak.test.js
git commit -m "feat: ストリーク状態にコース種別を保存する"
```

---

### Task 2: 月次清算をコース基準の単価にする

**Files:**
- Modify: `src/monthly-bonus-index.js`
- Test: `tests/monthly-bonus-index.test.js`

**Interfaces:**
- Consumes: `settleBonuses(streakUsers)` の settlements 要素 `{ userName: string, bonus: number, course: string|undefined }`（Task 1）
- Produces: なし（エントリポイントの内部変更）

- [ ] **Step 1: 既存テストの前提を差し替える**

`tests/monthly-bonus-index.test.js` の `describe('formatMonthlyBonusMessage - 金額表示', ...)` ブロックを**まるごと**次に差し替える（`describe(` から対応する `});` まで）。ユーザー名を素の形式にし、コースを `course` フィールドで表現する:

```js
  describe('formatMonthlyBonusMessage - 金額表示', () => {
    it('小学生コースは1ポイント30円で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ', bonus: 2, course: 'elementary' }],
        '7月'
      );

      assert.match(message, /👤 はなこ: 2ポイント × ¥30 → ¥60/);
    });

    it('中学生コースは1ポイント50円で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう', bonus: 3, course: 'juniorHigh' }],
        '7月'
      );

      assert.match(message, /👤 たろう: 3ポイント × ¥50 → ¥150/);
    });

    it('0ポイントのユーザーも0円として表示する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'じろう', bonus: 0, course: 'elementary' }],
        '7月'
      );

      assert.match(message, /👤 じろう: 0ポイント × ¥30 → ¥0/);
    });

    it('合計行に全ユーザーの金額の合算を出す(コース混在)', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [
          { userName: 'たろう', bonus: 3, course: 'juniorHigh' },
          { userName: 'はなこ', bonus: 2, course: 'elementary' },
          { userName: 'じろう', bonus: 0, course: 'elementary' }
        ],
        '7月'
      );

      // 3×50 + 2×30 + 0×30 = 210
      assert.match(message, /合計: ¥210/);
    });

    it('4桁の金額は3桁区切りで表示する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう', bonus: 31, course: 'juniorHigh' }],
        '7月'
      );

      // 31×50 = 1550
      assert.match(message, /31ポイント × ¥50 → ¥1,550/);
      assert.match(message, /合計: ¥1,550/);
    });

    it('course が未設定のユーザーは小学生単価(¥30)で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ', bonus: 2 }],
        '7月'
      );

      assert.match(message, /👤 はなこ: 2ポイント × ¥30 → ¥60/);
    });

    it('未知の course 値も小学生単価(¥30)で換算する(支給を止めない)', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'やまだ', bonus: 2, course: 'highSchool' }],
        '7月'
      );

      assert.match(message, /👤 やまだ: 2ポイント × ¥30 → ¥60/);
    });

    it('表示名にコース名が含まれていても単価は course で決まる', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう (小学生コース)', bonus: 2, course: 'juniorHigh' }],
        '7月'
      );

      assert.match(message, /2ポイント × ¥50 → ¥100/, '名前の文字列マッチに戻っていないこと');
    });

    it('対象ユーザーが0人なら合計行を出さない', () => {
      const message = mainModule.formatMonthlyBonusMessage([], '7月');

      assert.match(message, /対象のユーザーがいませんでした。/);
      assert.doesNotMatch(message, /合計:/);
    });

    it('支給の案内文と月ラベルは従来どおり残る', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ', bonus: 2, course: 'elementary' }],
        '7月'
      );

      assert.match(message, /💰 ボーナスポイント清算\(7月分\)/);
      assert.match(message, /お小遣いとして支給してね!/);
    });
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: FAIL。「小学生コースは1ポイント30円で換算する」で `× ¥30` が本文にないため（現在の書式は `2ポイント → ¥60`）

- [ ] **Step 3: `toBonusRate()` を追加し `toBonusYen()` を差し替える**

`src/monthly-bonus-index.js` の `toBonusYen()` 関数定義（JSDoc コメントを含む）を、まるごと次に差し替える:

```js
/**
 * コースに対応するボーナスポイント単価(円/ポイント)を返す
 *
 * 未設定・未知の値は小学生コース扱いにする。streak_data.json の course は
 * 任意フィールドで、朝通知が初めて書き込むまでは欠落し得るため、
 * 支給が止まらない側に倒している。
 *
 * @param {'elementary'|'juniorHigh'|undefined} course - ストリーク状態のコース種別
 * @returns {number} 1ポイントあたりの金額(円)
 */
function toBonusRate(course) {
  return course === 'juniorHigh'
    ? BONUS_POINT_YEN.juniorHigh
    : BONUS_POINT_YEN.elementary;
}

/**
 * ボーナスポイントを金額(円)に換算する
 *
 * コース種別は streak_data.json に保存された course を使う。以前は表示名に
 * 「中学生コース」が含まれるかで判定していたが、コース選択画面を経由しない
 * ユーザーの表示名にはコース名が付かず、全員が小学生単価になっていた。
 * 設計: docs/superpowers/specs/2026-08-03-monthly-bonus-course-rate-design.md
 *
 * @param {'elementary'|'juniorHigh'|undefined} course - ストリーク状態のコース種別
 * @param {number} bonus - ボーナスポイント数
 * @returns {number} 金額(円)
 */
function toBonusYen(course, bonus) {
  return bonus * toBonusRate(course);
}
```

- [ ] **Step 4: メッセージ整形を単価付きに変える**

`src/monthly-bonus-index.js` の `formatMonthlyBonusMessage()` 内、`settlements.forEach(...)` のブロックをまるごと次に差し替える:

```js
  settlements.forEach(settlement => {
    const rate = toBonusRate(settlement.course);
    const yen = toBonusYen(settlement.course, settlement.bonus);
    totalYen += yen;
    lines.push(`👤 ${settlement.userName}: ${settlement.bonus}ポイント × ¥${rate} → ¥${yen.toLocaleString('ja-JP')}`);
  });
```

あわせて `formatMonthlyBonusMessage()` の JSDoc の `@param` 行を次に差し替える:

```js
 * @param {Array<{userName: string, bonus: number, course?: string}>} settlements
```

同じ JSDoc の説明文にある「コース別単価で換算した金額」の一文はそのまま残す。

- [ ] **Step 5: テストと lint を実行する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js && npm run lint`
Expected: PASS（差し替えた10件を含む全件）

- [ ] **Step 6: 全テストを実行する**

Run: `npm test`
Expected: PASS（全ファイル）

- [ ] **Step 7: コミットする**

```bash
git add src/monthly-bonus-index.js tests/monthly-bonus-index.test.js
git commit -m "fix: 月次清算の単価判定を表示名からコース種別に切り替える"
```

---

### Task 3: 運用スクリプトとドキュメントを更新する

**Files:**
- Modify: `scripts/show-streak-data.js`
- Modify: `src/streak.js`（冒頭のデータ構造コメントのみ）
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1 で保存されるようになった `course` フィールド
- Produces: なし

- [ ] **Step 1: `show-streak-data.js` の出力に course を追加する**

`scripts/show-streak-data.js` の `console.log` 呼び出し（`keys.forEach` の中）を次に差し替える:

```js
    console.log(
      `  - "${key}": streak=${s.streak} grace=${s.grace} bonus=${s.bonus ?? 0} course=${s.course ?? '(未設定)'} lastConfirmedDate=${s.lastConfirmedDate ?? 'null'}`
    );
```

- [ ] **Step 2: `show-streak-data.js` のヘッダコメントを実態に合わせる**

同ファイル冒頭のブロックコメントにある次の一文:

```js
 * 手動変更(set-streak-field.js)の前に、正確なユーザーキー "名前 (コース名)" と
 * 現在の grace / streak / bonus を確認するために使う。データは書き換えない。
```

を次に差し替える:

```js
 * 手動変更(set-streak-field.js)の前に、正確なユーザーキーと現在の
 * grace / streak / bonus / course を確認するために使う。データは書き換えない。
 * ユーザーキーはクローラーの表示名で、コース選択画面を経由しないユーザーは
 * コース名が付かない素の名前になる(本番は全員この形式)。
```

- [ ] **Step 3: 動作を確認する**

Run: `node scripts/show-streak-data.js`
Expected: 正常終了。ローカルには `data/streak_data.json` がないため `[show-streak-data] 登録済みユーザーは0件です(...)` と出れば成功（本番データでの確認は Task 4 で行う）

- [ ] **Step 4: `src/streak.js` のデータ構造コメントを更新する**

`src/streak.js` 冒頭のブロックコメントのうち、`users:` 以下の記述を次に差し替える:

```js
 *   users: {
 *     "ユーザー名": {                    // クローラーの表示名。コース選択画面を経由した場合のみ "名前 (コース名)" になる
 *       streak: number,                 // 確定済み連続学習日数
 *       grace: number,                  // おたすけ残数 (0〜3)
 *       bonus: number,                  // ボーナスポイント (月次清算で0にリセット)
 *       course: string|undefined,       // 'elementary' | 'juniorHigh'。月次清算の単価判定に使う。未設定は elementary 扱い
 *       lastConfirmedDate: string|null  // 最後に確定判定した日 (YYYY-MM-DD, JST)
 *     }
 *   }
```

- [ ] **Step 5: `CLAUDE.md` の単価の説明に判定根拠を追記する**

`CLAUDE.md` のストリーク機能の節にある次の一文:

```text
単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN` に集約されており、変更時はここだけ書き換える。
```

を次に差し替える:

```text
単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN` に集約されており、変更時はここだけ書き換える。コースの判定は `streak_data.json` の `course` フィールド（朝通知の確定処理が保存する）で行い、未設定・未知の値は小学生コース扱いにする。詳細: `docs/superpowers/specs/2026-08-03-monthly-bonus-course-rate-design.md`
```

- [ ] **Step 6: `CLAUDE.md` の Testing Patterns に注意点を追記する**

`CLAUDE.md` の「## Testing Patterns」節の箇条書きの末尾に、次の1行を追加する:

```text
- `streak_data.json` のユーザーキーは**本番では素の名前**（コース選択画面を経由しないユーザーには表示名にコース名が付かない）。テストfixtureで `"名前 (コース名)"` 形式を前提にすると本番と乖離する。コース依存の判定は必ず `course` フィールドで書く
```

- [ ] **Step 7: 変更範囲を確認する**

Run: `git diff --stat`
Expected: `scripts/show-streak-data.js` / `src/streak.js` / `CLAUDE.md` の3ファイルのみ

- [ ] **Step 8: テストと lint を実行する**

Run: `npm test && npm run lint`
Expected: PASS（コメントとスクリプトのみの変更なので全件通ること）

- [ ] **Step 9: コミットする**

```bash
git add scripts/show-streak-data.js src/streak.js CLAUDE.md
git commit -m "docs: コース種別の保存と単価判定の根拠を反映する"
```

---

### Task 4: DRY_RUN で検証しマージする

**Files:**
- 変更なし（検証とマージのみ）

**Interfaces:**
- Consumes: Task 1〜3 完了後の実装
- Produces: なし

- [ ] **Step 1: 全テストと lint を実行する**

Run: `npm test && npm run lint && npm run validate:all`
Expected: すべて PASS

- [ ] **Step 2: 月次清算を DRY_RUN で実行する**

Run: `DRY_RUN=true node -r dotenv/config src/monthly-bonus-index.js`
Expected: 正常終了（終了コード0）。プレビューに `👤 <名前>: Nポイント × ¥30 → ¥M` の形式で単価付きの行が出ること。

ローカルには `data/streak_data.json` がないため対象0人になる可能性が高い。その場合は「対象のユーザーがいませんでした。」と出て正常終了すれば成功とし、書式の検証は Task 2 のユニットテストで済んでいるものとする。`.env` が未整備で実行できない場合は結果をユーザーに報告して判断を仰ぐ（`.env` を勝手に作らない）。

- [ ] **Step 3: マージする**

```bash
git checkout main
git merge --no-ff fix/monthly-bonus-course-rate -m "Merge branch 'fix/monthly-bonus-course-rate'"
git push origin main
```

- [ ] **Step 4: CI の結果を確認する**

Run: `gh run list --limit 3`
Expected: push で起動した `CI` ワークフローが `success` になること。失敗していれば `gh run view <id> --log-failed` で原因を調べて修正する

- [ ] **Step 5: 本番データへの反映予定をユーザーに伝える**

翌朝（JST 7:00）の朝通知が走った後に、読み取り専用ワークフロー `show-streak-data.yml` を実行すると全ユーザーに `course` が入っていることを確認できる旨を報告する。このタスクでは実行しない（朝通知の前に実行しても `course=(未設定)` としか出ないため）。

---

## セルフレビュー結果

- **仕様カバレッジ**: 設計書の「変更内容」1〜6 はそれぞれ Task 1（`src/streak.js` の course 保存と settleBonuses）、Task 2（`src/monthly-bonus-index.js` の単価とメッセージ書式）、Task 2 Step 1（メッセージ書式）、Task 3 Step 1-3（`show-streak-data.js`）、Task 1・2 のテスト、Task 3 Step 4-6（ドキュメント）が担当する。「検証」節は Task 4 が担当する。「エラー処理・エッジケース」の5項目は Task 1 Step 1（dataReliable:false・course 未指定の保持）、Task 2 Step 1（course 欠落・未知の course 値）でテスト化した。キャッシュ消失とデプロイ窓は挙動の説明であり実装対象ではない
- **`version` を上げない制約**: Global Constraints に明記し、Task 1 Step 6 で既存の 1.3 移行テスト群が無変更で通ることを確認する
- **プレースホルダ**: なし。全ステップに実際のコードまたは実行コマンドを記載した
- **型・名前の一貫性**: `withCourse(state, course)`（Task 1 で定義・使用、private）、`toBonusRate(course)` と `toBonusYen(course, bonus)`（Task 2 で定義・使用、いずれも非エクスポート）、settlements の要素型 `{ userName, bonus, course }`（Task 1 で定義 → Task 2 が消費）。`course` の値域は全タスクで `'elementary'` / `'juniorHigh'` / undefined に統一されている
- **`confirmDay()` の罠**: 全分岐で状態を組み立て直すため course が落ちる点を Task 1 の冒頭に「重要な前提」として明記し、Step 4 のコードで後段の付け直しとして解決している
