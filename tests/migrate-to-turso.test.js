/**
 * Turso移行スクリプトのテスト
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  parseArgs,
  maskUserName,
  describeSchemaFailure,
  compareRoundTrip,
  formatUserSummaryLine
} = require('../scripts/migrate-to-turso');

describe('Turso移行スクリプト (scripts/migrate-to-turso.js)', () => {
  describe('parseArgs()', () => {
    it('--force をフラグとして解釈する', () => {
      assert.deepStrictEqual(parseArgs(['--force']), { force: true });
    });

    it('引数なしなら空オブジェクトを返す', () => {
      assert.deepStrictEqual(parseArgs([]), {});
    });
  });

  describe('maskUserName()', () => {
    it('末尾1文字だけ残して伏せる(ログに実名を出さない)', () => {
      assert.strictEqual(maskUserName('やまだたろう'), '*****う');
    });

    it('1文字の名前はそのまま返す', () => {
      assert.strictEqual(maskUserName('た'), 'た');
    });

    it('空文字列は空文字列を返す', () => {
      assert.strictEqual(maskUserName(''), '');
    });
  });

  describe('describeSchemaFailure() — C1: createSchema失敗時の危険度判定', () => {
    it('probe.state===uninitializedなら安全(dangerous:false)と判定する', () => {
      const result = describeSchemaFailure('タイムアウト', { success: true, state: 'uninitialized' });
      assert.strictEqual(result.dangerous, false);
      assert.match(result.message, /uninitialized/);
      assert.match(result.message, /安全な状態/);
    });

    it('probe.state===emptyなら危険(dangerous:true)と判定し翌朝の被害を警告する', () => {
      const result = describeSchemaFailure('トリガー作成エラー', { success: true, state: 'empty' });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /危険/);
      assert.match(result.message, /state=empty/);
      assert.match(result.message, /朝通知/);
    });

    it('probe.state===okなら危険と判定する(データが既にある状態でテーブル操作が一部失敗)', () => {
      const result = describeSchemaFailure('トリガー作成エラー', { success: true, state: 'ok' });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /state=ok/);
    });

    it('probe自体が失敗(接続不能)なら安全と断定できないため危険とみなす', () => {
      const result = describeSchemaFailure('スキーマエラー', { success: false, error: 'タイムアウト' });
      assert.strictEqual(result.dangerous, true);
      assert.match(result.message, /確認不能/);
      assert.match(result.message, /タイムアウト/);
    });
  });

  describe('compareRoundTrip() — C3: 書き込み内容と読み戻し内容の照合', () => {
    it('一致すればokになる', () => {
      const result = compareRoundTrip('streak_data', '{"a":1}', '{"a":1}');
      assert.strictEqual(result.ok, true);
      assert.match(result.message, /一致しました/);
    });

    it('不一致ならngになり文字数を明示する', () => {
      const result = compareRoundTrip('streak_data', '{"a":1}', '{"a":2,"b":3}');
      assert.strictEqual(result.ok, false);
      assert.match(result.message, /一致しません/);
      assert.match(result.message, /書込7文字/);
      assert.match(result.message, /読戻13文字/);
    });

    it('読み戻し値がnullなら読み戻せなかった扱いにする', () => {
      const result = compareRoundTrip('streak_data', '{"a":1}', null);
      assert.strictEqual(result.ok, false);
      assert.match(result.message, /読み戻せませんでした/);
    });
  });

  describe('formatUserSummaryLine() — 実名マスクとフィールド表示', () => {
    it('主要フィールドを1行にまとめ実名はマスクする', () => {
      const line = formatUserSummaryLine('やまだたろう', {
        streak: 5,
        grace: 2,
        bonus: 10,
        course: '小学生コース',
        lastConfirmedDate: '2026-08-26',
        history: { '2026-08-25': true, '2026-08-26': true },
        exemptDates: ['2026-08-20']
      });
      assert.match(line, /\*\*\*\*\*う/);
      assert.doesNotMatch(line, /やまだたろう/);
      assert.match(line, /streak=5/);
      assert.match(line, /grace=2/);
      assert.match(line, /bonus=10/);
      assert.match(line, /course=小学生コース/);
      assert.match(line, /履歴2日/);
      assert.match(line, /免除1日/);
    });

    it('stateがundefinedでも例外を投げずデフォルト値で表示する(I4: 破損データへの耐性)', () => {
      const line = formatUserSummaryLine('たろう', undefined);
      assert.match(line, /bonus=0/);
      assert.match(line, /course=\(未設定\)/);
      assert.match(line, /lastConfirmedDate=null/);
      assert.match(line, /履歴0日/);
      assert.match(line, /免除0日/);
    });
  });
});
