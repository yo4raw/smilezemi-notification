/**
 * 朝通知エントリポイントのテスト
 *
 * src/morning-index.js はトップレベルで依存モジュールを require しているため、
 * require.cache にモックを注入してからモジュールをロードする方式でテストする。
 * (tests/index.test.js と同じ方式)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

function resolveModule(p) {
  return require.resolve(p);
}

const MODULE_PATHS = [
  '../src/morning-index', '../src/config', '../src/auth', '../src/crawler',
  '../src/notifier', '../src/broadcast', '../src/streak', '../src/store', 'playwright'
];

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    try { delete require.cache[resolveModule(p)]; } catch {}
  }
}

const { getDiscordFailure: realGetDiscordFailure } = require('../src/broadcast');
const { truncateToLimit: realTruncateToLimit } = require('../src/notifier');

describe('朝通知エントリポイント (src/morning-index.js)', () => {
  let morningModule;
  let callLog;

  function setupMocks(overrides = {}) {
    callLog = [];
    clearModuleCache();

    const mockPage = { screenshot: async () => {}, goto: async () => {} };
    const mockContext = { close: async () => {} };
    const mockBrowser = { close: async () => {} };

    const crawlResult = overrides.crawlResult || {
      success: true,
      partialFailure: false,
      data: [
        { userName: 'たろう', course: 'elementary', studyItemCount: 4, missionCount: 4, date: '2026-08-26', studyTime: { hours: 0, minutes: 30 }, totalScore: 300, missions: [] }
      ]
    };

    require.cache[resolveModule('playwright')] = {
      id: resolveModule('playwright'), filename: resolveModule('playwright'), loaded: true,
      exports: { chromium: { launch: async () => mockBrowser } }
    };

    require.cache[resolveModule('../src/config')] = {
      id: resolveModule('../src/config'), filename: resolveModule('../src/config'), loaded: true,
      exports: {
        loadConfig: overrides.loadConfig || (() => ({
          SMILEZEMI_USERNAME: 'u', SMILEZEMI_PASSWORD: 'p',
          LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_USER_ID: 'g'
        })),
        maskSensitiveData: (value) => value
      }
    };

    require.cache[resolveModule('../src/auth')] = {
      id: resolveModule('../src/auth'), filename: resolveModule('../src/auth'), loaded: true,
      exports: { login: async () => ({ success: true, page: mockPage, context: mockContext }) }
    };

    require.cache[resolveModule('../src/crawler')] = {
      id: resolveModule('../src/crawler'), filename: resolveModule('../src/crawler'), loaded: true,
      exports: {
        getAllUsersDetailedData: overrides.getAllUsersDetailedData || (async () => crawlResult),
        getUserList: async () => ({ success: true, users: [{ name: 'たろう', index: 0 }] }),
        getTargetDates: () => ({ dateString: '2026-08-26', withPadding: '08/26' })
      }
    };

    require.cache[resolveModule('../src/notifier')] = {
      id: resolveModule('../src/notifier'), filename: resolveModule('../src/notifier'), loaded: true,
      exports: {
        formatDetailedMessage: overrides.formatDetailedMessage || ((userData, changes, options) => {
          callLog.push({ type: 'formatDetailedMessage', options });
          return 'テスト朝メッセージ';
        }),
        truncateToLimit: realTruncateToLimit
      }
    };

    require.cache[resolveModule('../src/broadcast')] = {
      id: resolveModule('../src/broadcast'), filename: resolveModule('../src/broadcast'), loaded: true,
      exports: {
        broadcastToAll: overrides.broadcastToAll || (async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        }),
        getDiscordFailure: realGetDiscordFailure,
        LINE_MAX_MESSAGE_LENGTH: 5000,
        DISCORD_MAX_MESSAGE_LENGTH: 2000
      }
    };

    require.cache[resolveModule('../src/streak')] = {
      id: resolveModule('../src/streak'), filename: resolveModule('../src/streak'), loaded: true,
      exports: {
        loadStreakData: overrides.loadStreakData || (async () => {
          callLog.push({ type: 'loadStreakData' });
          return { success: true, data: {} };
        }),
        saveStreakData: overrides.saveStreakData || (async () => {
          callLog.push({ type: 'saveStreakData' });
          return { success: true };
        }),
        updateStreaksByCourse: overrides.updateStreaksByCourse || (() => {
          callLog.push({ type: 'updateStreaksByCourse' });
          return {
            streakUsers: { 'たろう': { streak: 1, grace: 1, bonus: 0 } },
            results: [{ userName: 'たろう', state: { streak: 1, grace: 1, bonus: 0 }, event: 'none' }]
          };
        }),
        formatStreakInfo: () => 'テストストリーク情報',
        STREAK_REQUIREMENTS: { elementaryMissions: 4, juniorHighCourses: 3 }
      }
    };

    morningModule = require('../src/morning-index');
  }

  beforeEach(() => {
    setupMocks();
  });

  afterEach(() => {
    clearModuleCache();
  });

  it('main 関数をエクスポートしている', () => {
    assert.strictEqual(typeof morningModule.main, 'function');
  });

  it('正常系: ストリークを確定して保存し、通知を送る', async () => {
    const result = await morningModule.main();

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(callLog.filter(c => c.type === 'updateStreaksByCourse').length, 1, '確定処理を行うこと');
    assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 1, '保存すること');
    assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 1, '通知を送ること');
  });

  it('Turso未初期化のときは確定処理をスキップして通知だけ出す', async () => {
    setupMocks({
      loadStreakData: async () => {
        callLog.push({ type: 'loadStreakData' });
        return {
          success: false,
          uninitialized: true,
          error: 'ストリークデータの保存先(Turso)が未初期化です。移行ワークフローを実行してください'
        };
      }
    });

    const result = await morningModule.main();

    assert.strictEqual(
      callLog.filter(c => c.type === 'updateStreaksByCourse').length, 0,
      '空データで確定すると連続日数が0にリセットされるためスキップすること'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'saveStreakData').length, 0,
      '未初期化のまま保存しないこと'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'broadcastToAll').length, 1,
      '通知は送ること'
    );
    assert.strictEqual(result.exitCode, 1, '移行前だと気づけるよう赤くすること');
  });

  it('Turso未初期化のときはストリーク行を出さない', async () => {
    setupMocks({
      loadStreakData: async () => ({ success: false, uninitialized: true, error: '未初期化です' })
    });

    await morningModule.main();

    const formatCall = callLog.find(c => c.type === 'formatDetailedMessage');
    assert.ok(formatCall, 'formatDetailedMessageが呼ばれること');
    assert.strictEqual(formatCall.options.streaks, null, 'ストリーク行を出さないこと');
    assert.deepStrictEqual(formatCall.options.exemptUserNames, [], '免除日も空にすること');
  });

  it('通常の読み取り失敗でも確定処理をスキップする(空状態での上書きを防ぐ)', async () => {
    setupMocks({
      loadStreakData: async () => {
        callLog.push({ type: 'loadStreakData' });
        return { success: false, error: 'タイムアウト: Turso が10000ms以内に応答しませんでした' };
      }
    });

    const result = await morningModule.main();

    assert.strictEqual(
      callLog.filter(c => c.type === 'updateStreaksByCourse').length, 0,
      '一時的な障害でも空データで確定してはならない(streak/grace/bonusを上書きしてしまう)'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'saveStreakData').length, 0,
      '読めなかったデータを上書き保存しないこと'
    );
    assert.strictEqual(
      callLog.filter(c => c.type === 'broadcastToAll').length, 1,
      '通知は送ること'
    );
    assert.strictEqual(result.exitCode, 1, '読み取り失敗はerrorsに積まれるため赤くなること');
  });

  it('保存失敗は通知を出したうえで終了コード1にする', async () => {
    setupMocks({
      saveStreakData: async () => {
        callLog.push({ type: 'saveStreakData' });
        return { success: false, error: 'ストリークデータ保存エラー: SQL エラー' };
      }
    });

    const result = await morningModule.main();

    assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 1, '通知は送ること');
    assert.strictEqual(result.exitCode, 1);
  });

  it('ドライランでは保存も送信もしない', async () => {
    const original = process.env.DRY_RUN;
    process.env.DRY_RUN = 'true';
    setupMocks();

    try {
      const result = await morningModule.main();

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 0);
    } finally {
      if (original === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = original;
    }
  });

  it('免除日のユーザーはexemptUserNamesとして渡る', async () => {
    setupMocks({
      updateStreaksByCourse: () => ({
        streakUsers: { 'はなこ': { streak: 5, grace: 3, bonus: 0 } },
        results: [{ userName: 'はなこ', state: { streak: 5, grace: 3, bonus: 0 }, event: 'exempt' }]
      })
    });

    await morningModule.main();

    const formatCall = callLog.find(c => c.type === 'formatDetailedMessage');
    assert.deepStrictEqual(formatCall.options.exemptUserNames, ['はなこ']);
  });
});
