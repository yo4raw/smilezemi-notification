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
    'じろう': { streak: 12, grace: 3, bonus: 2, course: 'elementary', lastConfirmedDate: '2026-07-31' },
    'はなこ': { streak: 5, grace: 1, bonus: 0, course: 'juniorHigh', lastConfirmedDate: '2026-07-31' }
  };

  function fakeSettleBonuses(streakUsers) {
    const settled = {};
    const settlements = [];
    Object.entries(streakUsers).forEach(([userName, state]) => {
      settlements.push({ userName, bonus: state.bonus ?? 0, course: state.course });
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
        broadcastToAll: overrides.broadcastToAll || (async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return {
            success: true,
            results: [
              { channel: 'line', success: true },
              { channel: 'discord', success: true }
            ]
          };
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

      const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
      assert.strictEqual(pushCalls.length, 1, '通知が1回送られること');
      const [message, passedConfig] = pushCalls[0].args;
      assert.strictEqual(passedConfig.LINE_CHANNEL_ACCESS_TOKEN, 'test_token');
      assert.strictEqual(passedConfig.LINE_USER_ID, 'test_user');
      assert.match(message, /💰 ボーナスポイント清算\(\d+月分\)/, '月ラベルが含まれること');
      assert.match(message, /じろう: 2ポイント/, 'ボーナスありの子が表示されること');
      assert.match(message, /はなこ: 0ポイント/, '0ポイントの子も表示されること');
      assert.match(message, /お小遣いとして支給/, '支給の案内が含まれること');
    });

    it('正常系: 送信成功後にボーナスを0にリセットして保存する', async () => {
      await mainModule.main();

      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 1, '保存が1回行われること');
      const saved = saveCalls[0].users;
      assert.strictEqual(saved['じろう'].bonus, 0, 'ボーナスがリセットされること');
      assert.strictEqual(saved['じろう'].streak, 12, 'ストリークは変わらないこと');
    });

    it('異常系: 送信失敗時はリセット保存せず終了コード1(清算持ち越し)', async () => {
      setupMocks({
        broadcastToAll: async () => ({
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
      assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 0);
    });

    it('異常系: ストリークデータ読み込み失敗時は障害通知を送りexit 1(リセットしない)', async () => {
      setupMocks({
        loadStreakData: async () => ({ success: false, error: 'JSONパースエラー' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);

      const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
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
      const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
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
        broadcastToAll: async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
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
      assert.strictEqual(saveCalls[0].users['じろう'].bonus, 0);
    });

    it('正常系: LINE成功・Discord失敗のときリセットはするが終了コード1で失効を知らせる', async () => {
      setupMocks({
        broadcastToAll: async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return {
            success: true,
            results: [
              { channel: 'line', success: true },
              { channel: 'discord', success: false, error: 'Discord API エラー: 404 Not Found - Unknown Webhook' }
            ]
          };
        }
      });

      const result = await mainModule.main();

      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 1, 'LINEに届いているのでリセットすること(二重支給防止)');
      assert.strictEqual(saveCalls[0].users['じろう'].bonus, 0);
      assert.strictEqual(result.exitCode, 1, 'Webhook失効に気づけるよう終了コード1にすること');
    });

    it('正常系: Webhook未設定のときはリセットして終了コード0(任意項目のため失敗にしない)', async () => {
      setupMocks({
        broadcastToAll: async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 1);
      assert.strictEqual(result.exitCode, 0, 'Discordの結果がなければ終了コードに影響させないこと');
    });
  });

  describe('formatMonthlyBonusMessage - 金額表示', () => {
    it('小学生コースは1ポイント30円で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ', bonus: 2, course: 'elementary' }],
        '7月'
      );

      assert.match(message, /👤 はなこ: 2ポイント × ¥30 → ¥60/);
    });

    it('中学生コースは1ポイント50円で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう', bonus: 3, course: 'juniorHigh' }],
        '7月'
      );

      assert.match(message, /👤 たろう: 3ポイント × ¥50 → ¥150/);
    });

    it('0ポイントのユーザーも0円として表示する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'じろう', bonus: 0, course: 'elementary' }],
        '7月'
      );

      assert.match(message, /👤 じろう: 0ポイント × ¥30 → ¥0/);
    });

    it('合計行に全ユーザーの金額の合算を出す(コース混在)', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [
          { userName: 'たろう', bonus: 3, course: 'juniorHigh' },
          { userName: 'はなこ', bonus: 2, course: 'elementary' },
          { userName: 'じろう', bonus: 0, course: 'elementary' }
        ],
        '7月'
      );

      // 3×50 + 2×30 + 0×30 = 210
      assert.match(message, /合計: ¥210/);
    });

    it('4桁の金額は3桁区切りで表示する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう', bonus: 31, course: 'juniorHigh' }],
        '7月'
      );

      // 31×50 = 1550
      assert.match(message, /31ポイント × ¥50 → ¥1,550/);
      assert.match(message, /合計: ¥1,550/);
    });

    it('course が未設定のユーザーは小学生単価(¥30)で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ', bonus: 2 }],
        '7月'
      );

      assert.match(message, /👤 はなこ: 2ポイント × ¥30 → ¥60/);
    });

    it('未知の course 値も小学生単価(¥30)で換算する(支給を止めない)', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'やまだ', bonus: 2, course: 'highSchool' }],
        '7月'
      );

      assert.match(message, /👤 やまだ: 2ポイント × ¥30 → ¥60/);
    });

    it('表示名にコース名が含まれていても単価は course で決まる', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう (小学生コース)', bonus: 2, course: 'juniorHigh' }],
        '7月'
      );

      assert.match(message, /2ポイント × ¥50 → ¥100/, '名前の文字列マッチに戻っていないこと');
    });

    it('対象ユーザーが0人なら合計行を出さない', () => {
      const message = mainModule.formatMonthlyBonusMessage([], '7月');

      assert.match(message, /対象のユーザーがいませんでした。/);
      assert.doesNotMatch(message, /合計:/);
    });

    it('支給の案内文と月ラベルは従来どおり残る', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ', bonus: 2, course: 'elementary' }],
        '7月'
      );

      assert.match(message, /💰 ボーナスポイント清算\(7月分\)/);
      assert.match(message, /お小遣いとして支給してね!/);
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
