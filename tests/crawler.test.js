/**
 * クローラーモジュールのテスト
 * Requirements: 3.1, 3.2, 3.3, 3.4
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

describe('クローラーモジュール (src/crawler.js)', () => {
  let crawler;
  let mockPage;

  beforeEach(() => {
    // モジュールを読み込む（実装後に動作）
    crawler = require('../src/crawler');

    // Playwrightのモックページオブジェクト
    mockPage = {
      locator: mock.fn((selector) => {
        // セレクタに応じたモック要素を返す
        if (selector.includes('user')) {
          return {
            all: mock.fn(async () => [
              {
                textContent: mock.fn(async () => '太郎'),
                click: mock.fn(async () => {})
              },
              {
                textContent: mock.fn(async () => '花子'),
                click: mock.fn(async () => {})
              }
            ]),
            count: mock.fn(async () => 2)
          };
        }
        if (selector.includes('ミッション')) {
          return {
            all: mock.fn(async () => [
              { textContent: mock.fn(async () => '5ミッション') }
            ]),
            textContent: mock.fn(async () => '5ミッション')
          };
        }
        return {
          all: mock.fn(async () => []),
          count: mock.fn(async () => 0),
          textContent: mock.fn(async () => ''),
          click: mock.fn(async () => {})
        };
      }),
      waitForTimeout: mock.fn(async () => {}),
      waitForLoadState: mock.fn(async () => {})
    };
  });

  describe('getUserList() - ユーザー一覧取得', () => {
    it('正常系: ログイン後のページからユーザー一覧を取得できる', async () => {
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true, 'ユーザー一覧取得が成功すること');
      assert.strictEqual(Array.isArray(result.users), true, 'usersが配列であること');
      assert.strictEqual(result.users.length > 0, true, 'ユーザーが1人以上存在すること');
    });

    it('正常系: 各ユーザーに名前が含まれる', async () => {
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true);
      result.users.forEach(user => {
        assert.strictEqual(typeof user.name, 'string', 'ユーザー名が文字列であること');
        assert.strictEqual(user.name.length > 0, true, 'ユーザー名が空でないこと');
      });
    });

    it('正常系: 各ユーザーにインデックスが含まれる', async () => {
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true);
      result.users.forEach((user, index) => {
        assert.strictEqual(typeof user.index, 'number', 'インデックスが数値であること');
        assert.strictEqual(user.index, index, 'インデックスが連番であること');
      });
    });

    it('異常系: ユーザー要素が見つからない場合、エラーを返す', async () => {
      // ユーザー要素が見つからない設定（すべてのセレクタで空配列を返す）
      mockPage.locator = mock.fn(() => ({
        all: mock.fn(async () => []),
        count: mock.fn(async () => 0)
      }));

      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, false, 'ユーザー一覧取得が失敗すること');
      assert.match(
        result.error,
        /ユーザーが見つかりません|ユーザー要素が見つかりません/,
        'エラーメッセージにユーザーが見つからないことが含まれること'
      );
    });

    it('異常系: タイムアウトが発生した場合、エラーを返す', async () => {
      mockPage.locator = mock.fn(() => ({
        all: mock.fn(async () => {
          throw new Error('Timeout 30000ms exceeded');
        })
      }));

      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /タイムアウト|Timeout/);
    });
  });

  describe('getMissionCount() - ミッション数取得', () => {
    it('正常系: ユーザーを選択してミッション数を取得できる', async () => {
      const userIndex = 0;
      const result = await crawler.getMissionCount(mockPage, userIndex);

      assert.strictEqual(result.success, true, 'ミッション数取得が成功すること');
      assert.strictEqual(typeof result.count, 'number', 'ミッション数が数値であること');
      assert.strictEqual(result.count >= 0, true, 'ミッション数が0以上であること');
    });

    it('正常系: ミッション数が正しくパースされる', async () => {
      const result = await crawler.getMissionCount(mockPage, 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 5, 'ミッション数が5であること（"5ミッション"から抽出）');
    });

    it('正常系: ユーザー切り替え後、ページの安定を待つ', async () => {
      await crawler.getMissionCount(mockPage, 0);

      // waitForTimeoutが呼ばれたことを確認
      assert.strictEqual(
        mockPage.waitForTimeout.mock.calls.length > 0,
        true,
        'ページ安定化のための待機が実行されること'
      );
    });

    it('異常系: ミッション数要素が見つからない場合、エラーを返す', async () => {
      mockPage.locator = mock.fn((selector) => {
        if (selector.includes('user')) {
          return {
            all: mock.fn(async () => [
              { click: mock.fn(async () => {}) }
            ])
          };
        }
        // ミッション関連セレクタは全て空配列を返す
        return {
          all: mock.fn(async () => []),
          textContent: mock.fn(async () => '')
        };
      });

      const result = await crawler.getMissionCount(mockPage, 0);

      assert.strictEqual(result.success, false);
      assert.match(
        result.error,
        /ミッション数要素が見つかりません|ミッション要素が存在しません/
      );
    });

    it('異常系: ミッション数のパースに失敗した場合、エラーを返す', async () => {
      mockPage.locator = mock.fn((selector) => {
        if (selector.includes('user')) {
          return {
            all: mock.fn(async () => [
              { click: mock.fn(async () => {}) }
            ])
          };
        }
        if (selector.includes('ミッション')) {
          return {
            all: mock.fn(async () => [
              { textContent: mock.fn(async () => 'データなし') } // 数値が含まれない
            ]),
            textContent: mock.fn(async () => 'データなし')
          };
        }
        return {
          all: mock.fn(async () => []),
          textContent: mock.fn(async () => '')
        };
      });

      const result = await crawler.getMissionCount(mockPage, 0);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /ミッション数のパースに失敗|数値が抽出できません/);
    });

    it('異常系: 無効なユーザーインデックスの場合、エラーを返す', async () => {
      const result = await crawler.getMissionCount(mockPage, -1);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /無効|インデックス/);
    });
  });

  describe('getAllUsersMissionCounts() - 全ユーザーのミッション数取得', () => {
    it('正常系: 全ユーザーのミッション数を取得できる', async () => {
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, true, '全ユーザーのミッション数取得が成功すること');
      assert.strictEqual(Array.isArray(result.data), true, 'dataが配列であること');
      assert.strictEqual(result.data.length > 0, true, 'データが1件以上あること');
    });

    it('正常系: 各データにユーザー名とミッション数が含まれる', async () => {
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, true);
      result.data.forEach(item => {
        assert.strictEqual(typeof item.userName, 'string', 'ユーザー名が文字列であること');
        assert.strictEqual(typeof item.missionCount, 'number', 'ミッション数が数値であること');
        assert.strictEqual(item.missionCount >= 0, true, 'ミッション数が0以上であること');
      });
    });

    it('正常系: 各データに日付が含まれる', async () => {
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, true);
      result.data.forEach(item => {
        assert.strictEqual(typeof item.date, 'string', '日付が文字列であること');
        assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/, '日付がYYYY-MM-DD形式であること');
      });
    });

    it('異常系: ユーザー一覧取得に失敗した場合、エラーを返す', async () => {
      mockPage.locator = mock.fn(() => ({
        all: mock.fn(async () => {
          throw new Error('Failed to get users');
        })
      }));

      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, false);
      assert.strictEqual(typeof result.error, 'string');
    });

    it('異常系: 一部のユーザーでエラーが発生しても、取得できたデータは返す', async () => {
      let userClickCount = 0;
      mockPage.locator = mock.fn((selector) => {
        if (selector.includes('user')) {
          return {
            all: mock.fn(async () => [
              {
                textContent: mock.fn(async () => '太郎'),
                click: mock.fn(async () => {
                  userClickCount++;
                })
              },
              {
                textContent: mock.fn(async () => '花子'),
                click: mock.fn(async () => {
                  userClickCount++;
                })
              }
            ]),
            count: mock.fn(async () => 2)
          };
        }
        if (selector.includes('ミッション')) {
          // 2人目（花子）の場合は空配列を返す
          if (userClickCount === 2) {
            return {
              all: mock.fn(async () => [])  // 空配列でエラーを誘発
            };
          }
          return {
            all: mock.fn(async () => [
              { textContent: mock.fn(async () => '5ミッション') }
            ]),
            textContent: mock.fn(async () => '5ミッション')
          };
        }
        return {
          all: mock.fn(async () => []),
          count: mock.fn(async () => 0),
          textContent: mock.fn(async () => '')
        };
      });

      const result = await crawler.getAllUsersMissionCounts(mockPage);

      // 部分的な成功
      assert.strictEqual(result.success, true, '部分的に成功すること');
      assert.strictEqual(result.data.length, 1, '成功した1件のデータが返ること');
      assert.strictEqual(
        result.partialFailure,
        true,
        'partialFailureフラグが立つこと'
      );
    });
  });
});
