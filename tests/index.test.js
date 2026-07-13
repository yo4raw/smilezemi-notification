/**
 * オーケストレーションモジュールのテスト
 * Requirements: 1.1, 1.2, 1.3, 1.4, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 9.6
 *
 * src/index.js はトップレベルで依存モジュールを require しているため、
 * require.cache にモックを注入してからモジュールをロードする方式でテストする。
 * IPC シリアライズ問題を回避するためプレーン関数でモックする。
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

function resolveModule(p) {
  return require.resolve(p);
}

const MODULE_PATHS = [
  '../src/index', '../src/config', '../src/auth',
  '../src/crawler', '../src/data', '../src/notifier', '../src/streak', 'playwright'
];

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    try { delete require.cache[resolveModule(p)]; } catch {}
  }
}

describe('オーケストレーション (src/index.js)', () => {
  let mainModule;

  // 呼び出し記録用
  let callLog;
  let mockFetch;
  let browserCloseCount;
  let contextCloseCount;

  function setupMocks(overrides = {}) {
    callLog = [];
    browserCloseCount = 0;
    contextCloseCount = 0;

    const mockPage = {
      screenshot: async () => {},
      goto: async () => {}
    };

    const mockContext = {
      close: async () => { contextCloseCount++; }
    };

    const mockBrowser = {
      close: async () => { browserCloseCount++; }
    };

    const loginResult = overrides.loginResult || {
      success: true, page: mockPage, context: mockContext
    };
    const crawlDetailedResult = overrides.crawlDetailedResult || {
      success: true,
      data: [{ userName: '太郎', missionCount: 5, date: '2025-12-25', studyTime: '1時間30分', missions: [], totalScore: 100 }],
      detailsAvailable: true,
      partialFailure: false
    };
    const crawlBasicResult = overrides.crawlBasicResult || {
      success: true,
      data: [{ userName: '太郎', missionCount: 5, date: '2025-12-25' }]
    };
    const previousDataResult = overrides.previousDataResult || { success: true, data: [] };
    const compareResult = overrides.compareResult || {
      success: true,
      changes: [{ userName: '太郎', previousCount: 0, currentCount: 5, diff: 5, type: 'new' }]
    };
    const saveResult = overrides.saveResult || { success: true };

    mockFetch = overrides.fetch || (async () => ({ ok: true, status: 200, text: async () => '' }));
    global.fetch = async (...args) => {
      callLog.push({ type: 'fetch', args });
      return mockFetch(...args);
    };

    clearModuleCache();

    require.cache[resolveModule('../src/config')] = {
      id: resolveModule('../src/config'), filename: resolveModule('../src/config'), loaded: true,
      exports: {
        loadConfig: overrides.loadConfig || (() => ({
          SMILEZEMI_USERNAME: 'test@example.com',
          SMILEZEMI_PASSWORD: 'password123',
          LINE_CHANNEL_ACCESS_TOKEN: 'test_token',
          LINE_USER_ID: 'test_user'
        }))
      }
    };

    require.cache[resolveModule('playwright')] = {
      id: resolveModule('playwright'), filename: resolveModule('playwright'), loaded: true,
      exports: {
        chromium: {
          launch: overrides.chromiumLaunch || (async () => mockBrowser)
        }
      }
    };

    require.cache[resolveModule('../src/auth')] = {
      id: resolveModule('../src/auth'), filename: resolveModule('../src/auth'), loaded: true,
      exports: {
        login: overrides.login || (async () => loginResult)
      }
    };

    require.cache[resolveModule('../src/crawler')] = {
      id: resolveModule('../src/crawler'), filename: resolveModule('../src/crawler'), loaded: true,
      exports: {
        getAllUsersDetailedData: overrides.getAllUsersDetailedData || (async () => crawlDetailedResult),
        getAllUsersMissionCounts: overrides.getAllUsersMissionCounts || (async () => crawlBasicResult),
        getUserList: overrides.getUserList || (async () => ({ success: true, users: [{ name: '太郎', index: 0 }] })),
        getTargetDates: overrides.getTargetDates || (() => ({ dateString: '2025-12-24', withPadding: '2025-12-24' }))
      }
    };

    require.cache[resolveModule('../src/data')] = {
      id: resolveModule('../src/data'), filename: resolveModule('../src/data'), loaded: true,
      exports: {
        loadPreviousData: overrides.loadPreviousData || (async () => previousDataResult),
        compareData: overrides.compareData || (() => compareResult),
        compareMissionDetails: overrides.compareMissionDetails || (() => ({ success: true, changes: [] })),
        saveData: overrides.saveData || (async () => {
          callLog.push({ type: 'saveData' });
          return saveResult;
        })
      }
    };

    require.cache[resolveModule('../src/notifier')] = {
      id: resolveModule('../src/notifier'), filename: resolveModule('../src/notifier'), loaded: true,
      exports: {
        sendNotification: overrides.sendNotification || (async (...args) => {
          callLog.push({ type: 'sendNotification', args });
          return { success: true };
        }),
        formatDetailedMessage: overrides.formatDetailedMessage || (() => 'テスト詳細メッセージ'),
        truncateToLimit: overrides.truncateToLimit || ((msg) => msg)
      }
    };

    require.cache[resolveModule('../src/streak')] = {
      id: resolveModule('../src/streak'), filename: resolveModule('../src/streak'), loaded: true,
      exports: {
        loadStreakData: overrides.loadStreakData || (async () => ({ success: true, data: {} })),
        saveStreakData: overrides.saveStreakData || (async () => ({ success: true })),
        updateStreaks: overrides.updateStreaks || (() => ({ streakUsers: {}, results: [] })),
        formatStreakInfo: overrides.formatStreakInfo || (() => 'テストストリーク情報'),
        isStudied: overrides.isStudied || (() => false),
        createInitialState: overrides.createInitialState || (() => ({}))
      }
    };

    mainModule = require('../src/index');
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

  describe('main() - メイン実行フロー', () => {
    it('正常系: 全体フローが正常に完了する', async () => {
      const result = await mainModule.main();

      assert.strictEqual(result.success, true, '全体処理が成功すること');
      assert.strictEqual(result.exitCode, 0, '終了コードが0であること');
    });

    it('正常系: LINE APIにメッセージを送信する', async () => {
      await mainModule.main();

      const fetchCalls = callLog.filter(c => c.type === 'fetch');
      assert.strictEqual(fetchCalls.length, 1, 'fetchが1回呼ばれること');
      const [url, options] = fetchCalls[0].args;
      assert.strictEqual(url, 'https://api.line.me/v2/bot/message/push');
      assert.strictEqual(options.method, 'POST');

      const body = JSON.parse(options.body);
      assert.strictEqual(body.to, 'test_user');
      assert.strictEqual(body.messages[0].type, 'text');
    });

    it('正常系: データ保存が実行される', async () => {
      await mainModule.main();

      const saveCalls = callLog.filter(c => c.type === 'saveData');
      assert.strictEqual(saveCalls.length, 1, 'saveDataが呼ばれること');
    });

    it('異常系: 環境変数が欠けている場合、終了コード1で終了する', async () => {
      setupMocks({
        loadConfig: () => { throw new Error('必須環境変数が設定されていません'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.error, /環境変数/);
    });

    it('異常系: ブラウザ起動失敗時、終了コード1で終了する', async () => {
      setupMocks({
        chromiumLaunch: async () => { throw new Error('ブラウザ起動失敗'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('異常系: ログイン失敗時、終了コード1で終了する', async () => {
      setupMocks({
        login: async () => ({ success: false, error: '認証失敗' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.error, '認証失敗');
    });

    it('異常系: クローリング失敗時、基本モードにフォールバックする', async () => {
      setupMocks({
        getAllUsersDetailedData: async () => ({ success: false, error: 'クローリング失敗' })
      });

      const result = await mainModule.main();

      const notifyCalls = callLog.filter(c => c.type === 'sendNotification');
      assert.strictEqual(notifyCalls.length, 1, 'フォールバックで通知が送られること');
    });

    it('異常系: 詳細・基本の両方が失敗した場合、終了コード1', async () => {
      setupMocks({
        getAllUsersDetailedData: async () => ({ success: false, error: '詳細失敗' }),
        getAllUsersMissionCounts: async () => ({ success: false, error: '基本も失敗' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('異常系: LINE API失敗時、errorsに記録される', async () => {
      setupMocks({
        fetch: async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(Array.isArray(result.errors), true);
      assert.strictEqual(result.errors.some(e => e.includes('LINE API')), true);
    });

    it('異常系: LINE API例外時、errorsに記録', async () => {
      setupMocks({
        fetch: async () => { throw new Error('Network error'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(Array.isArray(result.errors), true);
    });

    it('異常系: ブラウザは必ず終了する（finally句）', async () => {
      await mainModule.main();

      assert.strictEqual(browserCloseCount, 1, 'browser.close()が呼ばれること');
      assert.strictEqual(contextCloseCount, 1, 'context.close()が呼ばれること');
    });

    it('異常系: 予期しないエラー発生時もブラウザが終了する', async () => {
      setupMocks({
        getAllUsersDetailedData: async () => { throw new Error('予期しないエラー'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(browserCloseCount, 1, 'エラー時もbrowser.close()が呼ばれること');
    });

    it('正常系: 前回データが取得できなくても処理を続行する', async () => {
      setupMocks({
        loadPreviousData: async () => ({ success: false, error: 'ファイルなし' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true, '前回データなしでも処理が続行されること');
    });
  });

  describe('終了コード管理', () => {
    it('正常系: 成功時は終了コード0を返す', async () => {
      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 0);
    });

    it('異常系: 失敗時は終了コード1を返す', async () => {
      setupMocks({
        loadConfig: () => { throw new Error('エラー'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
    });
  });
});
