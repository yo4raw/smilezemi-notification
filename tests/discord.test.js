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

    it('異常系: 429(レート制限)はリトライして成功できる', async () => {
      let callCount = 0;
      const mockFetch = mock.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: false, status: 429, statusText: 'Too Many Requests',
            text: async () => '{"message": "You are being rate limited.", "retry_after": 0.1}'
          };
        }
        return { ok: true, status: 204, statusText: 'No Content', text: async () => '' };
      });
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 3, retryDelay: 1
      });

      assert.strictEqual(result.success, true, 'リトライ後に成功すること');
      assert.strictEqual(mockFetch.mock.calls.length, 2, '429はリトライすること');
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

  describe('splitIntoChunks() - 2000文字ごとの分割', () => {
    it('上限に収まる短文は1チャンクのまま、ページ番号を付けない', () => {
      const chunks = discord.splitIntoChunks('短いメッセージ', 2000);

      assert.deepStrictEqual(chunks, ['短いメッセージ']);
    });

    it('行の境界で分割する（行の途中では割らない）', () => {
      // 各行30文字。maxLength=100なら3行(90文字+改行2)までが1チャンクに入る
      const lines = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(30));
      const chunks = discord.splitIntoChunks(lines.join('\n'), 100);

      assert.ok(chunks.length >= 2, '複数チャンクに分かれること');
      for (const chunk of chunks) {
        // ページ番号の行を除いた本文の各行が、元の行のいずれかと一致すること
        const body = chunk.split('\n').slice(1).join('\n');
        for (const line of body.split('\n')) {
          assert.ok(lines.includes(line), `行が途中で割れていないこと: ${line}`);
        }
      }
    });

    it('1行だけで上限を超える場合はその行を文字単位で分割する', () => {
      const chunks = discord.splitIntoChunks('あ'.repeat(250), 100);

      assert.ok(chunks.length >= 3, '長い1行が複数チャンクに割れること');
      for (const chunk of chunks) {
        assert.ok(chunk.length <= 100, `上限に収まること: ${chunk.length}`);
      }
      const restored = chunks.map(c => c.split('\n').slice(1).join('\n')).join('');
      assert.strictEqual(restored, 'あ'.repeat(250), '本文が欠けず復元できること');
    });

    it('サロゲートペアを割らない（絵文字が壊れない）', () => {
      const chunks = discord.splitIntoChunks('👤'.repeat(200), 100);

      for (const chunk of chunks) {
        assert.ok(
          !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk),
          '孤立した高サロゲートが残らないこと'
        );
        assert.ok(
          !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk),
          '孤立した低サロゲートが残らないこと'
        );
      }
      const restored = chunks.map(c => c.split('\n').slice(1).join('\n')).join('');
      assert.strictEqual(restored, '👤'.repeat(200), '本文が欠けず復元できること');
    });

    it('2チャンク以上なら各チャンクの先頭にページ番号を付ける', () => {
      const chunks = discord.splitIntoChunks('あ'.repeat(250), 100);

      chunks.forEach((chunk, index) => {
        assert.ok(
          chunk.startsWith(`(${index + 1}/${chunks.length})\n`),
          `先頭に(${index + 1}/${chunks.length})が付くこと: ${chunk.slice(0, 10)}`
        );
      });
    });

    it('ページ番号を含めても上限に収まる', () => {
      const chunks = discord.splitIntoChunks('あ'.repeat(9000), 2000);

      assert.ok(chunks.length >= 5);
      for (const chunk of chunks) {
        assert.ok(chunk.length <= 2000, `ヘッダー込みで上限に収まること: ${chunk.length}`);
      }
    });

    it('空文字は空配列を返す', () => {
      assert.deepStrictEqual(discord.splitIntoChunks('', 2000), []);
    });
  });

  describe('sendDiscordMessage() - 分割送信', () => {
    it('上限を超える本文は複数回に分けてPOSTする', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true, status: 204, statusText: 'No Content', text: async () => ''
      }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('あ'.repeat(5000), TEST_WEBHOOK_URL, { chunkDelay: 0 });

      assert.strictEqual(result.success, true);
      assert.ok(mockFetch.mock.calls.length >= 3, `分割して送ること(実際: ${mockFetch.mock.calls.length}回)`);

      const sentBodies = mockFetch.mock.calls.map(c => JSON.parse(c.arguments[1].body).content);
      for (const content of sentBodies) {
        assert.ok(content.length <= 2000, '各通が上限に収まること');
      }
      const restored = sentBodies.map(c => c.split('\n').slice(1).join('\n')).join('');
      assert.strictEqual(restored, 'あ'.repeat(5000), '本文が切り詰められず全て送られること');
    });

    it('途中のチャンクが失敗しても残りのチャンクを送る', async () => {
      let call = 0;
      const mockFetch = mock.fn(async () => {
        call += 1;
        if (call === 2) {
          return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"message": "Unknown Webhook"}' };
        }
        return { ok: true, status: 204, statusText: 'No Content', text: async () => '' };
      });
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('あ'.repeat(5000), TEST_WEBHOOK_URL, { chunkDelay: 0 });

      assert.strictEqual(result.success, false, '1つでも失敗したら全体は失敗扱い');
      assert.ok(mockFetch.mock.calls.length >= 3, '失敗後も送信を続けること');
      assert.match(result.error, /\(2\//, '失敗したページ番号が理由に含まれること');
      assert.match(result.error, /Unknown Webhook/, '失敗理由が残ること');
    });

    it('1通に収まる場合はページ番号を付けずそのまま送る', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true, status: 204, statusText: 'No Content', text: async () => ''
      }));
      global.fetch = mockFetch;

      await discord.sendDiscordMessage('短いメッセージ', TEST_WEBHOOK_URL, { chunkDelay: 0 });

      assert.strictEqual(mockFetch.mock.calls.length, 1);
      assert.strictEqual(JSON.parse(mockFetch.mock.calls[0].arguments[1].body).content, '短いメッセージ');
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
