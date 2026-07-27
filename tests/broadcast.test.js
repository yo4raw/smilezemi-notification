/**
 * 送信フォールバック層のテスト
 * LINE送信が失敗したときだけDiscordへ転送する順序と成否集約を検証する
 *
 * require.cache 直接注入で notifier / discord をモックする
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

const MODULE_PATHS = ['../src/notifier', '../src/discord', '../src/broadcast'];

function resolveModule(p) {
  return require.resolve(p);
}

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    delete require.cache[resolveModule(p)];
  }
}

describe('送信フォールバック層 (src/broadcast.js)', () => {
  let broadcast;
  let callLog;

  const defaultConfig = {
    LINE_CHANNEL_ACCESS_TOKEN: 'test_token',
    LINE_USER_ID: 'U0000000000',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc'
  };

  function setupMocks(overrides = {}) {
    callLog = [];
    clearModuleCache();

    require.cache[resolveModule('../src/notifier')] = {
      id: resolveModule('../src/notifier'), filename: resolveModule('../src/notifier'), loaded: true,
      exports: {
        sendPushMessage: overrides.sendPushMessage || (async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: true };
        }),
        // 切り詰めは本物と同じ挙動を使いたいので簡易実装で代替する
        truncateToLimit: (message, maxLength = 5000) =>
          message.length <= maxLength ? message : message.substring(0, maxLength)
      }
    };

    require.cache[resolveModule('../src/discord')] = {
      id: resolveModule('../src/discord'), filename: resolveModule('../src/discord'), loaded: true,
      exports: {
        sendDiscordMessage: overrides.sendDiscordMessage || (async (...args) => {
          callLog.push({ type: 'discord', args });
          return { success: true };
        }),
        DISCORD_MAX_MESSAGE_LENGTH: 2000
      }
    };

    broadcast = require('../src/broadcast');
  }

  beforeEach(() => {
    setupMocks();
  });

  afterEach(() => {
    clearModuleCache();
  });

  after(() => {
    clearModuleCache();
  });

  describe('broadcastMessage()', () => {
    it('正常系: LINEが成功したらDiscordは呼ばない', async () => {
      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, true);
      assert.strictEqual(callLog.filter(c => c.type === 'line').length, 1);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0, 'Discordを呼ばないこと');
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].channel, 'line');
    });

    it('正常系: LINEにはトークン・ユーザーIDを渡して送る', async () => {
      await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      const [message, token, userId] = callLog.find(c => c.type === 'line').args;
      assert.strictEqual(message, '本文メッセージ');
      assert.strictEqual(token, 'test_token');
      assert.strictEqual(userId, 'U0000000000');
    });

    it('正常系: LINE失敗時はDiscordへ転送し、届いたので成功扱いにする', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: false, error: 'LINE API エラー: 429 Too Many Requests - monthly limit' };
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, '1つ以上届けば成功扱い');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1, 'Discordへ転送すること');
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[0].channel, 'line');
      assert.strictEqual(result.results[0].success, false);
      assert.strictEqual(result.results[1].channel, 'discord');
      assert.strictEqual(result.results[1].success, true);
    });

    it('正常系: 転送メッセージの先頭にLINE失敗の理由行が付く', async () => {
      setupMocks({
        sendPushMessage: async () => ({
          success: false,
          error: 'LINE API エラー: 429 Too Many Requests - monthly limit'
        })
      });

      await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      const [sentMessage, webhookUrl] = callLog.find(c => c.type === 'discord').args;
      assert.match(sentMessage, /^⚠️ LINEへの送信に失敗したためDiscordに転送しました/, '転送である旨が先頭に付くこと');
      assert.match(sentMessage, /理由: LINE API エラー: 429/, '失敗理由が含まれること');
      assert.match(sentMessage, /本文メッセージ/, '本文が保持されること');
      assert.strictEqual(webhookUrl, 'https://discord.com/api/webhooks/123/abc');
    });

    it('正常系: Discordへは2000文字に切り詰めて渡す', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' })
      });

      await broadcast.broadcastMessage('あ'.repeat(5000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.length <= 2000, true, 'Discordの上限に収めること');
    });

    it('正常系: LINEへは5000文字に切り詰めて渡す', async () => {
      await broadcast.broadcastMessage('あ'.repeat(9000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'line').args;
      assert.strictEqual(sentMessage.length <= 5000, true, 'LINEの上限に収めること');
    });

    it('異常系: 両方失敗したら失敗を返す', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' }),
        sendDiscordMessage: async () => ({ success: false, error: 'Discord API エラー: 404' })
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[1].error, 'Discord API エラー: 404');
    });

    it('異常系: Webhook未設定でLINEが失敗したら転送せず失敗を返す', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: false, error: 'LINE API エラー: 429' };
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', {
        ...defaultConfig,
        DISCORD_WEBHOOK_URL: undefined
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0, 'Discordを呼ばないこと');
      assert.strictEqual(result.results.length, 1, 'LINEの結果だけが残ること');
    });
  });

  describe('formatFallbackMessage()', () => {
    it('理由行と本文を空行で区切って返す', () => {
      const result = broadcast.formatFallbackMessage('本文', 'LINE API エラー: 429');

      assert.strictEqual(
        result,
        '⚠️ LINEへの送信に失敗したためDiscordに転送しました\n理由: LINE API エラー: 429\n\n本文'
      );
    });
  });
});
