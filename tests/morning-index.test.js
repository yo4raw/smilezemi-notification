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
