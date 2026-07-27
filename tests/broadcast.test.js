/**
 * 送信フォールバック層のテスト
 * LINE送信が失敗したときだけDiscordへ転送する順序と成否集約を検証する
 *
 * require.cache 直接注入で notifier / discord をモックする
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

const MODULE_PATHS = ['../src/notifier', '../src/discord', '../src/broadcast'];

// 切り詰めはモックせず本物を使う（ヘッダ付加後に実際に上限へ収まるかを検証したいため）
const { truncateToLimit } = require('../src/notifier');

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
        // 切り詰めは本物をそのまま使う（省略サフィックス・サロゲート処理まで含めて検証する）
        truncateToLimit
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

    it('異常系: sendPushMessageが例外を投げてもDiscordへ転送する', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          throw new SyntaxError('Invalid regular expression: /abc[/: Unterminated character class');
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, '例外でもDiscordに届けば成功扱い');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1, '例外時もDiscordへ転送すること');
      assert.strictEqual(result.results[0].channel, 'line');
      assert.strictEqual(result.results[0].success, false);
      assert.match(result.results[0].error, /Unterminated character class/, '例外メッセージが理由に残ること');

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.match(sentMessage, /Unterminated character class/, '理由行に例外メッセージが載ること');
    });

    it('異常系: 例外メッセージにトークンが含まれてもマスクしてから転送する', async () => {
      setupMocks({
        sendPushMessage: async () => {
          throw new Error(`Invalid regular expression: /${defaultConfig.LINE_CHANNEL_ACCESS_TOKEN}/`);
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.ok(
        !sentMessage.includes(defaultConfig.LINE_CHANNEL_ACCESS_TOKEN),
        'Discordへの転送文にトークンが生で出ないこと'
      );
      assert.ok(
        !result.results[0].error.includes(defaultConfig.LINE_CHANNEL_ACCESS_TOKEN),
        '結果のエラー文にもトークンが残らないこと'
      );
    });

    it('異常系: 例外時にWebhook未設定なら転送せず失敗を返す', async () => {
      setupMocks({
        sendPushMessage: async () => {
          throw new Error('予期しない例外');
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', {
        ...defaultConfig,
        DISCORD_WEBHOOK_URL: undefined
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0, 'Discordを呼ばないこと');
      assert.strictEqual(result.results.length, 1);
    });

    it('異常系: sendDiscordMessageが例外を投げても例外を投げず失敗として畳み込む', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' }),
        sendDiscordMessage: async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'includes')");
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, false, '両宛先に届いていないので失敗扱い');
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[1].channel, 'discord');
      assert.strictEqual(result.results[1].success, false);
      assert.match(result.results[1].error, /Cannot read properties of undefined/, '例外メッセージが理由に残ること');
    });

    it('正常系: 絵文字だらけの長文でも孤立サロゲートを含めずDiscordへ渡す', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' })
      });

      await broadcast.broadcastMessage('👤'.repeat(3000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.length <= 2000, true, 'Discordの上限に収めること');
      // JSON.stringify は孤立サロゲートをエスケープシーケンスとして残すため、\ud83d 単独が出ないことを見る
      assert.ok(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sentMessage),
        '孤立した高サロゲートが残らないこと'
      );
    });
  });

  describe('broadcastToAll() - 全宛先送信（月次清算の疎通確認用）', () => {
    it('正常系: LINEが成功してもDiscordにも送る', async () => {
      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true);
      assert.strictEqual(callLog.filter(c => c.type === 'line').length, 1);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1, 'LINE成功でもDiscordを呼ぶこと');
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[0].channel, 'line');
      assert.strictEqual(result.results[1].channel, 'discord');
    });

    it('正常系: LINE成功時、Discordには理由行のない本文をそのまま送る', async () => {
      await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage, '清算メッセージ', '転送ヘッダを付けないこと');
    });

    it('正常系: LINE失敗時はDiscordのメッセージに理由行が付く', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: false, error: 'LINE API エラー: 429 Too Many Requests' };
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, 'Discordに届いていれば成功扱い');
      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.match(sentMessage, /^⚠️ LINEへの送信に失敗したためDiscordに転送しました/);
      assert.match(sentMessage, /理由: LINE API エラー: 429/);
      assert.match(sentMessage, /清算メッセージ/);
    });

    it('正常系: LINE成功・Discord失敗でもsuccessはtrue（resultsに失敗が残る）', async () => {
      setupMocks({
        sendDiscordMessage: async (...args) => {
          callLog.push({ type: 'discord', args });
          return { success: false, error: 'Discord API エラー: 404 Not Found - Unknown Webhook' };
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, 'LINEに届いているので成功扱い');
      const discordResult = result.results.find(r => r.channel === 'discord');
      assert.strictEqual(discordResult.success, false);
      assert.match(discordResult.error, /Unknown Webhook/, '失効を判別できる理由が残ること');
    });

    it('異常系: 両方失敗したらsuccessはfalse', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' }),
        sendDiscordMessage: async () => ({ success: false, error: 'Discord API エラー: 404' })
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.results.length, 2);
    });

    it('正常系: Webhook未設定ならDiscordを呼ばず、resultsにdiscordが入らない', async () => {
      const result = await broadcast.broadcastToAll('清算メッセージ', {
        ...defaultConfig,
        DISCORD_WEBHOOK_URL: undefined
      });

      assert.strictEqual(result.success, true, 'LINEに届いているので成功');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0);
      assert.strictEqual(result.results.length, 1, 'LINEの結果だけが残ること');
      assert.strictEqual(result.results.find(r => r.channel === 'discord'), undefined);
    });

    it('正常系: LINE送信が例外を投げてもDiscordへ送る', async () => {
      setupMocks({
        sendPushMessage: async () => {
          throw new Error('想定外の例外');
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1, '例外でもDiscordへ送ること');
      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.match(sentMessage, /想定外の例外/, '例外の理由が転送メッセージに載ること');
    });

    it('セキュリティ: 例外メッセージに含まれるトークンはDiscordへ転送されない', async () => {
      setupMocks({
        sendPushMessage: async () => {
          throw new Error('failed with token=test_token and user=U0000000000');
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.includes('test_token'), false, 'LINEトークンが漏れないこと');
      assert.strictEqual(sentMessage.includes('U0000000000'), false, 'ユーザーIDが漏れないこと');
      const lineResult = result.results.find(r => r.channel === 'line');
      assert.strictEqual(lineResult.error.includes('test_token'), false);
    });

    it('異常系: LINE失敗かつWebhook未設定なら送信先がなく失敗を返す', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: false, error: 'LINE API エラー: 429 Too Many Requests' };
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', {
        ...defaultConfig,
        DISCORD_WEBHOOK_URL: undefined
      });

      assert.strictEqual(result.success, false, 'どこにも届いていないので失敗扱い(清算を持ち越す)');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0, 'Discordを呼ばないこと');
      assert.strictEqual(result.results.length, 1, 'LINEの結果だけが残ること');
      assert.strictEqual(result.results[0].channel, 'line');
      assert.strictEqual(result.results[0].success, false);
    });

    it('異常系: sendDiscordMessageが例外を投げても例外を投げずresultsへ失敗として積む', async () => {
      setupMocks({
        sendDiscordMessage: async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'includes')");
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, 'LINEには届いているので成功扱い');
      assert.strictEqual(result.results.length, 2);
      const discordResult = result.results.find(r => r.channel === 'discord');
      assert.strictEqual(discordResult.success, false);
      assert.match(discordResult.error, /Cannot read properties of undefined/, '例外メッセージが理由に残ること');
    });

    it('セキュリティ: Discord送信の例外メッセージに含まれるWebhook URLはマスクされる', async () => {
      setupMocks({
        sendDiscordMessage: async () => {
          throw new Error(`request to ${defaultConfig.DISCORD_WEBHOOK_URL} failed`);
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      const discordResult = result.results.find(r => r.channel === 'discord');
      assert.strictEqual(
        discordResult.error.includes(defaultConfig.DISCORD_WEBHOOK_URL),
        false,
        'Webhook URLが生で残らないこと'
      );
    });

    it('正常系: Discordへは2000文字に切り詰めて渡す', async () => {
      await broadcast.broadcastToAll('あ'.repeat(5000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.length <= 2000, true);
    });

    it('正常系: LINEへは5000文字に切り詰めて渡す', async () => {
      await broadcast.broadcastToAll('あ'.repeat(9000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'line').args;
      assert.strictEqual(sentMessage.length <= 5000, true);
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
