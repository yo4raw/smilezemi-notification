/**
 * 通知モジュールのテスト
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 7.1, 7.2, 9.4
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

describe('通知モジュール (src/notifier.js)', () => {
  let notifier;
  let mockFetch;

  beforeEach(() => {
    // モジュールを読み込む（実装後に動作）
    notifier = require('../src/notifier');

    // グローバルfetchのモック
    mockFetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({})
    }));
    global.fetch = mockFetch;
  });

  describe('sendNotification() - LINE通知送信', () => {
    it('正常系: 変更があった場合、LINE通知を送信できる', async () => {
      const changes = [
        {
          userName: '太郎',
          previousCount: 5,
          currentCount: 8,
          diff: 3,
          type: 'increase'
        }
      ];
      const accessToken = 'test_access_token';
      const userId = 'test_user_id';

      const result = await notifier.sendNotification(changes, accessToken, userId);

      assert.strictEqual(result.success, true, '通知送信が成功すること');
      assert.strictEqual(mockFetch.mock.calls.length, 1, 'fetchが1回呼ばれること');

      // fetchの引数を確認
      const [url, options] = mockFetch.mock.calls[0].arguments;
      assert.strictEqual(url, 'https://api.line.me/v2/bot/message/push', '正しいエンドポイントを使用すること');
      assert.strictEqual(options.method, 'POST', 'POST メソッドを使用すること');
      assert.strictEqual(
        options.headers['Authorization'],
        'Bearer test_access_token',
        '正しい認証ヘッダーを含むこと'
      );

      // リクエストボディを確認
      const body = JSON.parse(options.body);
      assert.strictEqual(body.to, 'test_user_id', '正しいユーザーIDを含むこと');
      assert.strictEqual(Array.isArray(body.messages), true, 'messagesが配列であること');
      assert.strictEqual(body.messages.length, 1, 'メッセージが1件含まれること');
      assert.strictEqual(body.messages[0].type, 'text', 'テキストメッセージであること');
      assert.match(body.messages[0].text, /太郎/, 'ユーザー名が含まれること');
      assert.match(body.messages[0].text, /3/, '差分が含まれること');
    });

    it('正常系: 複数の変更を通知できる', async () => {
      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' },
        { userName: '花子', previousCount: 10, currentCount: 7, diff: -3, type: 'decrease' },
        { userName: '次郎', previousCount: 0, currentCount: 2, diff: 2, type: 'new' }
      ];
      const accessToken = 'test_access_token';
      const userId = 'test_user_id';

      const result = await notifier.sendNotification(changes, accessToken, userId);

      assert.strictEqual(result.success, true);

      const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body);
      assert.match(body.messages[0].text, /太郎/, '1人目のユーザー名が含まれること');
      assert.match(body.messages[0].text, /花子/, '2人目のユーザー名が含まれること');
      assert.match(body.messages[0].text, /次郎/, '3人目のユーザー名が含まれること');
    });

    it('正常系: 変更がない場合、「変更なし」メッセージを送信する', async () => {
      const changes = [];
      const accessToken = 'test_access_token';
      const userId = 'test_user_id';

      const result = await notifier.sendNotification(changes, accessToken, userId);

      assert.strictEqual(result.success, true);

      const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body);
      assert.match(body.messages[0].text, /変更なし|変更ありませ/, '変更なしのメッセージが含まれること');
    });

    it('正常系: メッセージが5000文字以内に制限される', async () => {
      // 大量の変更を作成してメッセージ長をテスト
      const changes = [];
      for (let i = 0; i < 100; i++) {
        changes.push({
          userName: `ユーザー${i}`,
          previousCount: 0,
          currentCount: 5,
          diff: 5,
          type: 'new'
        });
      }

      const result = await notifier.sendNotification(changes, 'token', 'user');

      assert.strictEqual(result.success, true);

      const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body);
      assert.strictEqual(body.messages[0].text.length <= 5000, true, 'メッセージが5000文字以内であること');
    });

    it('正常系: 増加・減少・新規の変更タイプを区別して表示する', async () => {
      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' },
        { userName: '花子', previousCount: 10, currentCount: 7, diff: -3, type: 'decrease' },
        { userName: '次郎', previousCount: 0, currentCount: 2, diff: 2, type: 'new' }
      ];

      const result = await notifier.sendNotification(changes, 'token', 'user');

      assert.strictEqual(result.success, true);

      const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body);
      const message = body.messages[0].text;

      // 増加は "+" または "↑" で表示
      assert.match(message, /\+|↑|増加/, '増加を示す記号が含まれること');
      // 減少は "-" または "↓" で表示
      assert.match(message, /-|↓|減少/, '減少を示す記号が含まれること');
      // 新規は "新規" または "NEW" で表示
      assert.match(message, /新規|NEW/i, '新規を示す文言が含まれること');
    });

    it('異常系: API呼び出し失敗時、リトライして最終的にエラーを返す', async () => {
      // 常にエラーを返すモック
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      }));

      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' }
      ];

      const result = await notifier.sendNotification(changes, 'token', 'user', { maxRetries: 3 });

      assert.strictEqual(result.success, false, '通知送信が失敗すること');
      assert.strictEqual(global.fetch.mock.calls.length, 3, '3回リトライされること');
      assert.match(result.error, /API|失敗|エラー|500/i, 'エラーメッセージが含まれること');
    });

    it('異常系: ネットワークエラー時、リトライしてエラーを返す', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Network error');
      });

      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' }
      ];

      const result = await notifier.sendNotification(changes, 'token', 'user', { maxRetries: 3 });

      assert.strictEqual(result.success, false);
      assert.strictEqual(global.fetch.mock.calls.length, 3, '3回リトライされること');
      assert.match(result.error, /ネットワーク|Network/i);
    });

    it('異常系: 認証エラー時（401）、リトライせずにエラーを返す', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      }));

      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' }
      ];

      const result = await notifier.sendNotification(changes, 'invalid_token', 'user');

      assert.strictEqual(result.success, false);
      assert.strictEqual(global.fetch.mock.calls.length, 1, '認証エラーはリトライしないこと');
      assert.match(result.error, /認証|Unauthorized|401/i);
    });

    it('異常系: 必須パラメータが欠けている場合、エラーを返す', async () => {
      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' }
      ];

      // accessTokenが欠けている
      const result = await notifier.sendNotification(changes, null, 'user');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /必須|パラメータ|token/i);
    });

    it('正常系: リトライ間隔が指数バックオフであること', async () => {
      let callCount = 0;
      const callTimes = [];

      global.fetch = mock.fn(async () => {
        callTimes.push(Date.now());
        callCount++;
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error'
        };
      });

      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' }
      ];

      await notifier.sendNotification(changes, 'token', 'user', {
        maxRetries: 3,
        retryDelay: 100
      });

      assert.strictEqual(callCount, 3, '3回試行されること');

      // 2回目と1回目の間隔が約100ms（指数バックオフの初回: 100ms）
      if (callTimes.length >= 2) {
        const interval1 = callTimes[1] - callTimes[0];
        assert.strictEqual(interval1 >= 90 && interval1 <= 150, true, '1回目のリトライ間隔が適切であること');
      }

      // 3回目と2回目の間隔が約200ms（指数バックオフの2回目: 200ms）
      if (callTimes.length >= 3) {
        const interval2 = callTimes[2] - callTimes[1];
        assert.strictEqual(interval2 >= 180 && interval2 <= 250, true, '2回目のリトライ間隔が適切であること');
      }
    });
  });

  describe('formatMessage() - メッセージフォーマット', () => {
    it('正常系: 変更情報を読みやすい形式でフォーマットする', () => {
      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' }
      ];

      const message = notifier.formatMessage(changes);

      assert.strictEqual(typeof message, 'string', 'メッセージが文字列であること');
      assert.match(message, /太郎/, 'ユーザー名が含まれること');
      assert.match(message, /5/, '前回値が含まれること');
      assert.match(message, /8/, '現在値が含まれること');
      assert.match(message, /3/, '差分が含まれること');
    });

    it('正常系: 変更がない場合、適切なメッセージを返す', () => {
      const changes = [];

      const message = notifier.formatMessage(changes);

      assert.strictEqual(typeof message, 'string');
      assert.match(message, /変更なし|変更ありませ/, '変更なしのメッセージが含まれること');
    });
  });

  describe('センシティブデータのマスキング', () => {
    it('エラーメッセージにアクセストークンが含まれない', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Failed with token: secret_token_12345');
      });

      const changes = [
        { userName: '太郎', previousCount: 5, currentCount: 8, diff: 3, type: 'increase' }
      ];

      const result = await notifier.sendNotification(changes, 'secret_token_12345', 'user');

      assert.strictEqual(result.success, false);
      assert.strictEqual(
        result.error.includes('secret_token_12345'),
        false,
        'エラーメッセージにトークンが含まれないこと'
      );
      assert.match(result.error, /\*\*\*/, 'トークンがマスキングされること');
    });
  });
});
