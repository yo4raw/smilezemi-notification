/**
 * Discord通知モジュールのテスト
 * LINE送信失敗時のフォールバック先として使う Webhook 送信をテストする
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const discord = require('../src/discord');

const TEST_WEBHOOK_URL = 'https://discord.com/api/webhooks/1234567890/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

describe('Discord通知モジュール (src/discord.js)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('sendDiscordMessage()', () => {
    it('正常系: Webhookに content として POST する', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true, status: 204, statusText: 'No Content', text: async () => ''
      }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL);

      assert.strictEqual(result.success, true);
      assert.strictEqual(mockFetch.mock.calls.length, 1, 'fetchが1回呼ばれること');

      const [url, options] = mockFetch.mock.calls[0].arguments;
      assert.strictEqual(url, TEST_WEBHOOK_URL, 'Webhook URLにPOSTすること');
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers['Content-Type'], 'application/json');

      const body = JSON.parse(options.body);
      assert.strictEqual(body.content, 'テストメッセージ', 'contentフィールドで送ること');
    });

    it('異常系: Webhook URLが未設定なら送信せず失敗を返す', async () => {
      const mockFetch = mock.fn(async () => ({ ok: true, status: 204, statusText: 'No Content' }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', '');

      assert.strictEqual(result.success, false);
      assert.strictEqual(mockFetch.mock.calls.length, 0, 'fetchを呼ばないこと');
    });

    it('異常系: 4xxはリトライせず即失敗する(Webhook削除・ペイロード不正)', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false, status: 404, statusText: 'Not Found',
        text: async () => '{"message": "Unknown Webhook", "code": 10015}'
      }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 3, retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(mockFetch.mock.calls.length, 1, '4xxはリトライしないこと');
      assert.match(result.error, /404/, 'ステータスがエラー文に含まれること');
      assert.match(result.error, /Unknown Webhook/, 'レスポンスボディの理由が含まれること');
    });

    it('異常系: 5xxはリトライし、最終的に失敗を返す', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false, status: 500, statusText: 'Internal Server Error', text: async () => ''
      }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 3, retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(mockFetch.mock.calls.length, 3, '5xxは指定回数リトライすること');
    });

    it('正常系: 5xxの後に成功したら成功を返す', async () => {
      let callCount = 0;
      global.fetch = mock.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' };
        }
        return { ok: true, status: 204, statusText: 'No Content', text: async () => '' };
      });

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 3, retryDelay: 1
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(callCount, 2);
    });

    it('異常系: タイムアウトするとタイムアウト理由を返す', async () => {
      global.fetch = mock.fn(async (_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      });

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 1, retryDelay: 1, timeoutMs: 20
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /タイムアウト/);
    });

    it('セキュリティ: エラー文にWebhookトークンが含まれない', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error(`request to ${TEST_WEBHOOK_URL} failed`);
      });

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 1, retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(
        result.error.includes('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
        false,
        'Webhookトークンが漏れないこと'
      );
      assert.match(result.error, /\*\*\*/, 'マスキングされていること');
    });
  });

  describe('maskWebhookUrl()', () => {
    it('Webhook URLのトークン部分を伏せる', () => {
      const masked = discord.maskWebhookUrl(`POST ${TEST_WEBHOOK_URL} failed`, TEST_WEBHOOK_URL);

      assert.match(masked, /webhooks\/1234567890\/\*\*\*/, 'ID は残しトークンだけ伏せること');
      assert.strictEqual(masked.includes('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'), false);
    });

    it('第2引数なしでもURLパターンからトークンを伏せる', () => {
      const masked = discord.maskWebhookUrl(`POST ${TEST_WEBHOOK_URL} failed`);

      assert.strictEqual(masked.includes('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'), false);
    });

    it('URLを含まない文字列はそのまま返す', () => {
      assert.strictEqual(discord.maskWebhookUrl('ネットワークエラー'), 'ネットワークエラー');
    });
  });

  describe('エクスポート', () => {
    it('必要な関数と定数をエクスポートしている', () => {
      assert.strictEqual(typeof discord.sendDiscordMessage, 'function');
      assert.strictEqual(typeof discord.maskWebhookUrl, 'function');
      assert.strictEqual(discord.DISCORD_MAX_MESSAGE_LENGTH, 2000);
    });
  });
});
