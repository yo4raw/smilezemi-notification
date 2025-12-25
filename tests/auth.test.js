/**
 * 認証モジュールのテスト
 * Requirements: 2.1, 2.2, 9.2
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

describe('認証モジュール (src/auth.js)', () => {
  let auth;
  let mockPage;
  let mockBrowser;
  let mockContext;

  beforeEach(() => {
    // モジュールを読み込む（実装後に動作）
    auth = require('../src/auth');

    // Playwrightのモックオブジェクト
    mockPage = {
      goto: mock.fn(async () => {}),
      locator: mock.fn(() => ({
        fill: mock.fn(async () => {}),
        click: mock.fn(async () => {})
      })),
      url: mock.fn(() => 'https://smile-zemi.jp/mimamoru-net/ui/dashboard'),
      waitForLoadState: mock.fn(async () => {}),
      waitForTimeout: mock.fn(async () => {})
    };

    mockContext = {
      newPage: mock.fn(async () => mockPage),
      close: mock.fn(async () => {})
    };

    mockBrowser = {
      newContext: mock.fn(async () => mockContext)
    };
  });

  describe('login() - ログイン機能', () => {
    it('正常系: 認証情報が正しい場合、ログインに成功する', async () => {
      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      const result = await auth.login(mockBrowser, credentials);

      assert.strictEqual(result.success, true, 'ログインが成功すること');
      assert.strictEqual(result.error, undefined, 'エラーがないこと');
    });

    it('正常系: ログインページにアクセスする', async () => {
      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      await auth.login(mockBrowser, credentials);

      assert.strictEqual(
        mockPage.goto.mock.calls.length,
        1,
        'page.gotoが1回呼ばれること'
      );

      const gotoArgs = mockPage.goto.mock.calls[0].arguments;
      assert.strictEqual(
        gotoArgs[0],
        'https://smile-zemi.jp/mimamoru-net/ui/login',
        '正しいログインURLにアクセスすること'
      );
    });

    it('正常系: フォームに認証情報を入力する', async () => {
      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      await auth.login(mockBrowser, credentials);

      assert.strictEqual(
        mockPage.locator.mock.calls.length >= 2,
        true,
        'locatorが2回以上呼ばれること（username, password）'
      );
    });

    it('正常系: ログインボタンをクリックする', async () => {
      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      await auth.login(mockBrowser, credentials);

      // clickが呼ばれたことを確認（モック構造上、間接的に確認）
      assert.strictEqual(
        mockPage.locator.mock.calls.length >= 3,
        true,
        'ログインボタンのlocatorも呼ばれること'
      );
    });

    it('異常系: ネットワークエラーが発生した場合、エラーを返す', async () => {
      // gotoがエラーを投げる設定
      mockPage.goto = mock.fn(async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      });

      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      const result = await auth.login(mockBrowser, credentials);

      assert.strictEqual(result.success, false, 'ログインが失敗すること');
      assert.strictEqual(
        typeof result.error,
        'string',
        'エラーメッセージが文字列で返ること'
      );
      assert.match(
        result.error,
        /ネットワークエラー|接続エラー/,
        'エラーメッセージにネットワークエラーが含まれること'
      );
    });

    it('異常系: タイムアウトが発生した場合、エラーを返す', async () => {
      // gotoがタイムアウトエラーを投げる設定
      mockPage.goto = mock.fn(async () => {
        throw new Error('Timeout 60000ms exceeded');
      });

      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      const result = await auth.login(mockBrowser, credentials);

      assert.strictEqual(result.success, false, 'ログインが失敗すること');
      assert.match(
        result.error,
        /タイムアウト|Timeout/,
        'エラーメッセージにタイムアウトが含まれること'
      );
    });

    it('異常系: 認証失敗時（ログイン後もログインページのまま）、エラーを返す', async () => {
      // ログイン後もURLが変わらない設定
      mockPage.url = mock.fn(() => 'https://smile-zemi.jp/mimamoru-net/ui/login');

      const credentials = {
        username: 'wrong@example.com',
        password: 'wrongpassword'
      };

      const result = await auth.login(mockBrowser, credentials);

      assert.strictEqual(result.success, false, 'ログインが失敗すること');
      assert.match(
        result.error,
        /認証失敗|ログイン失敗/,
        'エラーメッセージに認証失敗が含まれること'
      );
    });

    it('異常系: 必須パラメータが欠けている場合、エラーを返す', async () => {
      const invalidCredentials = {
        username: 'test@example.com'
        // password が欠けている
      };

      const result = await auth.login(mockBrowser, invalidCredentials);

      assert.strictEqual(result.success, false, 'ログインが失敗すること');
      assert.match(
        result.error,
        /必須|欠けている|invalid/i,
        'エラーメッセージにパラメータエラーが含まれること'
      );
    });
  });

  describe('リトライロジック', () => {
    it('一時的なエラーの場合、最大3回リトライする', async () => {
      let attemptCount = 0;

      // 最初の2回は失敗、3回目で成功
      mockPage.goto = mock.fn(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('net::ERR_CONNECTION_REFUSED');
        }
        // 3回目は成功
      });

      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      const result = await auth.login(mockBrowser, credentials, { maxRetries: 3 });

      assert.strictEqual(
        attemptCount,
        3,
        '3回試行されること'
      );
      assert.strictEqual(
        result.success,
        true,
        '最終的にログインが成功すること'
      );
    });

    it('3回リトライしても失敗する場合、エラーを返す', async () => {
      // 常にエラーを投げる設定
      mockPage.goto = mock.fn(async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      });

      const credentials = {
        username: 'test@example.com',
        password: 'password123'
      };

      const result = await auth.login(mockBrowser, credentials, { maxRetries: 3 });

      assert.strictEqual(result.success, false, 'ログインが失敗すること');
      assert.strictEqual(
        mockPage.goto.mock.calls.length,
        3,
        '3回リトライされること'
      );
    });
  });

  describe('センシティブデータのマスキング', () => {
    it('エラーメッセージにパスワードが含まれない', async () => {
      mockPage.goto = mock.fn(async () => {
        throw new Error('Login failed with password: secret123');
      });

      const credentials = {
        username: 'test@example.com',
        password: 'secret123'
      };

      const result = await auth.login(mockBrowser, credentials);

      assert.strictEqual(
        result.error.includes('secret123'),
        false,
        'エラーメッセージにパスワードが含まれないこと'
      );
      assert.match(
        result.error,
        /\*\*\*/,
        'パスワードがマスキングされること'
      );
    });
  });
});
