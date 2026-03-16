/**
 * 週間レポートオーケストレーションのテスト
 *
 * src/weekly-report-index.js はトップレベルで依存モジュールを require しているため、
 * require.cache にモックを注入してからモジュールをロードする方式でテストする。
 * IPC シリアライズ問題を回避するためプレーン関数でモックする。
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

function resolveModule(p) {
  return require.resolve(p);
}

const MODULE_PATHS = [
  '../src/weekly-report-index', '../src/config', '../src/auth',
  '../src/weekly-report-crawler', '../src/weekly-report-notifier',
  '../src/notifier', 'playwright'
];

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    try { delete require.cache[resolveModule(p)]; } catch {}
  }
}

describe('週間レポートオーケストレーション (src/weekly-report-index.js)', () => {
  let mainModule;

  // 呼び出し記録用
  let callLog;
  let mockFetch;
  let browserCloseCount;
  let contextCloseCount;
  let originalDryRun;

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

    const reportResult = overrides.reportResult || {
      success: true,
      data: [{
        userName: '太郎（中学生コース）',
        report: { period: '3月9日～3月15日', torikumi: '頑張りました。', praisePoints: ['よくできました'] }
      }],
      partialFailure: false
    };

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

    require.cache[resolveModule('../src/weekly-report-crawler')] = {
      id: resolveModule('../src/weekly-report-crawler'), filename: resolveModule('../src/weekly-report-crawler'), loaded: true,
      exports: {
        getAllUsersWeeklyReport: overrides.getAllUsersWeeklyReport || (async () => reportResult)
      }
    };

    require.cache[resolveModule('../src/notifier')] = {
      id: resolveModule('../src/notifier'), filename: resolveModule('../src/notifier'), loaded: true,
      exports: {
        truncateToLimit: (msg) => msg.length > 5000 ? msg.substring(0, 5000) : msg,
        sendNotification: async () => ({ success: true }),
        formatMessage: () => '',
        formatDetailedMessage: () => ''
      }
    };

    require.cache[resolveModule('../src/weekly-report-notifier')] = {
      id: resolveModule('../src/weekly-report-notifier'), filename: resolveModule('../src/weekly-report-notifier'), loaded: true,
      exports: {
        formatWeeklyReport: overrides.formatWeeklyReport || (() => '📋 テストメッセージ')
      }
    };

    mainModule = require('../src/weekly-report-index');
  }

  beforeEach(() => {
    originalDryRun = process.env.DRY_RUN;
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
    });

    it('正常系: ドライランモードで通知をスキップ', async () => {
      process.env.DRY_RUN = 'true';

      const result = await mainModule.main();

      assert.strictEqual(result.success, true, 'ドライランが成功すること');
      assert.strictEqual(result.exitCode, 0);
      const fetchCalls = callLog.filter(c => c.type === 'fetch');
      assert.strictEqual(fetchCalls.length, 0, 'fetchが呼ばれないこと');
    });

    it('異常系: 設定読み込み失敗時、exitCode 1', async () => {
      setupMocks({
        loadConfig: () => { throw new Error('設定エラー'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('異常系: ブラウザ起動失敗時、exitCode 1', async () => {
      setupMocks({
        chromiumLaunch: async () => { throw new Error('ブラウザ起動失敗'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('異常系: ログイン失敗時、exitCode 1', async () => {
      setupMocks({
        login: async () => ({ success: false, error: 'ログイン失敗' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('異常系: レポート取得失敗時、exitCode 1', async () => {
      setupMocks({
        getAllUsersWeeklyReport: async () => ({ success: false, error: 'レポート取得失敗' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('異常系: LINE API失敗時、errorsに記録', async () => {
      setupMocks({
        fetch: async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(Array.isArray(result.errors), true);
      assert.strictEqual(result.errors.length > 0, true);
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
        getAllUsersWeeklyReport: async () => { throw new Error('予期しないエラー'); }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(browserCloseCount, 1, 'エラー時もbrowser.close()が呼ばれること');
    });
  });
});
