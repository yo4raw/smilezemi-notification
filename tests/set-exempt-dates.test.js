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

  it('カレンダー上存在しない日付は拒否する', () => {
    assert.throws(
      () => validateInput({ user: 'たろう', from: '2026-09-31', action: 'add' }),
      /実在する日付/
    );
    assert.throws(
      () => validateInput({ user: 'たろう', from: '2026-02-30', action: 'add' }),
      /実在する日付/
    );
  });

  it('存在しない月も読めるメッセージで拒否する', () => {
    assert.throws(
      () => validateInput({ user: 'たろう', from: '2026-13-01', action: 'add' }),
      /実在する日付/
    );
  });

  it('うるう年の2月29日は受理する', () => {
    const input = validateInput({ user: 'たろう', from: '2028-02-29', action: 'add' });
    assert.strictEqual(input.from, '2028-02-29');
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
