/**
 * 月次ボーナス清算エントリポイントのテスト
 * require.cache直接注入でモジュール依存(config/broadcast/streak)をモックする
 * (ブラウザ非依存のためplaywrightのモックは不要)
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

const MODULE_PATHS = ['../src/config', '../src/broadcast', '../src/streak'];

function resolveModule(p) {
  return require.resolve(p);
}

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    delete require.cache[resolveModule(p)];
  }
  delete require.cache[resolveModule('../src/monthly-bonus-index')];
}

describe('月次ボーナス清算 (src/monthly-bonus-index.js)', () => {
  let mainModule;
  let callLog;
  let originalDryRun;

  const defaultStreakUsers = {
    'じろう (小学生コース)': { streak: 12, grace: 3, bonus: 2, lastConfirmedDate: '2026-07-31' },
    'はなこ (小学生コース)': { streak: 5, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-31' }
  };

  function fakeSettleBonuses(streakUsers) {
    const settled = {};
    const settlements = [];
    Object.entries(streakUsers).forEach(([userName, state]) => {
      settlements.push({ userName, bonus: state.bonus ?? 0 });
      settled[userName] = { ...state, bonus: 0 };
    });
    return { streakUsers: settled, settlements };
  }

  function setupMocks(overrides = {}) {
    callLog = [];
    clearModuleCache();

    require.cache[resolveModule('../src/config')] = {
      id: resolveModule('../src/config'), filename: resolveModule('../src/config'), loaded: true,
      exports: {
        loadConfig: overrides.loadConfig || (() => ({
          SMILEZEMI_USERNAME: 'test@example.com',
          SMILEZEMI_PASSWORD: 'password123',
          LINE_CHANNEL_ACCESS_TOKEN: 'test_token',
          LINE_USER_ID: 'test_user',
          DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc'
        }))
      }
    };

    require.cache[resolveModule('../src/broadcast')] = {
      id: resolveModule('../src/broadcast'), filename: resolveModule('../src/broadcast'), loaded: true,
      exports: {
        broadcastMessage: overrides.broadcastMessage || (async (...args) => {
          callLog.push({ type: 'broadcastMessage', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        })
      }
    };

    require.cache[resolveModule('../src/streak')] = {
      id: resolveModule('../src/streak'), filename: resolveModule('../src/streak'), loaded: true,
      exports: {
        loadStreakData: overrides.loadStreakData || (async () => ({ success: true, data: defaultStreakUsers })),
        saveStreakData: overrides.saveStreakData || (async (users) => {
          callLog.push({ type: 'saveStreakData', users });
          return { success: true };
        }),
        settleBonuses: overrides.settleBonuses || fakeSettleBonuses
      }
    };

    mainModule = require('../src/monthly-bonus-index');
  }

  beforeEach(() => {
    originalDryRun = process.env.DRY_RUN;
    delete process.env.DRY_RUN;
    setupMocks();
  });

  afterEach(() => {
    if (originalDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = originalDryRun;
    }
    clearModuleCache();
  });

  after(() => {
    clearModuleCache();
  });

  describe('main() - 清算フロー', () => {
    it('正常系: 全ユーザーのボーナスを月ラベル付きで通知する(0ポイントの子も含む)', async () => {
      const result = await mainModule.main();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);

      const pushCalls = callLog.filter(c => c.type === 'broadcastMessage');
      assert.strictEqual(pushCalls.length, 1, '通知が1回送られること');
      const [message, passedConfig] = pushCalls[0].args;
      assert.strictEqual(passedConfig.LINE_CHANNEL_ACCESS_TOKEN, 'test_token');
      assert.strictEqual(passedConfig.LINE_USER_ID, 'test_user');
      assert.match(message, /💰 ボーナスポイント清算\(\d+月分\)/, '月ラベルが含まれること');
      assert.match(message, /じろう \(小学生コース\): 2ポイント/, 'ボーナスありの子が表示されること');
      assert.match(message, /はなこ \(小学生コース\): 0ポイント/, '0ポイントの子も表示されること');
      assert.match(message, /お小遣いとして支給/, '支給の案内が含まれること');
    });

    it('正常系: 送信成功後にボーナスを0にリセットして保存する', async () => {
      await mainModule.main();

      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 1, '保存が1回行われること');
      const saved = saveCalls[0].users;
      assert.strictEqual(saved['じろう (小学生コース)'].bonus, 0, 'ボーナスがリセットされること');
      assert.strictEqual(saved['じろう (小学生コース)'].streak, 12, 'ストリークは変わらないこと');
    });

    it('異常系: 送信失敗時はリセット保存せず終了コード1(清算持ち越し)', async () => {
      setupMocks({
        broadcastMessage: async () => ({
          success: false,
          results: [
            { channel: 'line', success: false, error: 'LINE API エラー: 429' },
            { channel: 'discord', success: false, error: 'Discord API エラー: 404' }
          ]
        })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 0, '送信失敗時は保存しないこと');
    });

    it('正常系: DRY_RUNでは送信も保存もしない', async () => {
      process.env.DRY_RUN = 'true';

      const result = await mainModule.main();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'broadcastMessage').length, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 0);
    });

    it('異常系: ストリークデータ読み込み失敗時は障害通知を送りexit 1(リセットしない)', async () => {
      setupMocks({
        loadStreakData: async () => ({ success: false, error: 'JSONパースエラー' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);

      const pushCalls = callLog.filter(c => c.type === 'broadcastMessage');
      assert.strictEqual(pushCalls.length, 1, '障害通知が送られること');
      assert.match(pushCalls[0].args[0], /⚠️/, '障害メッセージであること');

      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 0, '保存しないこと');
    });

    it('正常系: 対象ユーザーが0人でも通知は送る(死活確認を兼ねる)', async () => {
      setupMocks({
        loadStreakData: async () => ({ success: true, data: {} })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 0);
      const pushCalls = callLog.filter(c => c.type === 'broadcastMessage');
      assert.strictEqual(pushCalls.length, 1);
      assert.match(pushCalls[0].args[0], /対象のユーザーがいません/);
    });

    it('異常系: 設定読み込み失敗時はexit 1', async () => {
      setupMocks({
        loadConfig: () => { throw new Error('必須環境変数が設定されていません'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('正常系: Discordにだけ届いた場合もボーナスをリセットする(二重支給を防ぐ)', async () => {
      setupMocks({
        broadcastMessage: async (...args) => {
          callLog.push({ type: 'broadcastMessage', args });
          return {
            success: true,
            results: [
              { channel: 'line', success: false, error: 'LINE API エラー: 429' },
              { channel: 'discord', success: true }
            ]
          };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 0);
      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 1, 'Discordに届いていればリセットすること');
      assert.strictEqual(saveCalls[0].users['じろう (小学生コース)'].bonus, 0);
    });
  });

  describe('getPreviousMonthLabel', () => {
    it('前月の月ラベルを返す(JST基準)', () => {
      // JST 2026-08-01 08:00 = UTC 2026-07-31 23:00
      const label = mainModule.getPreviousMonthLabel(new Date('2026-07-31T23:00:00Z'));
      assert.strictEqual(label, '7月');
    });

    it('1月の清算は前年12月になる', () => {
      // JST 2027-01-01 08:00 = UTC 2026-12-31 23:00
      const label = mainModule.getPreviousMonthLabel(new Date('2026-12-31T23:00:00Z'));
      assert.strictEqual(label, '12月');
    });
  });
});
