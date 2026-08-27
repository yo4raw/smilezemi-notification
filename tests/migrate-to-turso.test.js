/**
 * Turso移行スクリプトのテスト
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseArgs, maskUserName } = require('../scripts/migrate-to-turso');

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
});
