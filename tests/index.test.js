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
        sendPushMessage: overrides.sendPushMessage || (async (...args) => {
          callLog.push({ type: 'sendPushMessage', args });
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
        saveStreakData: overrides.saveStreakData || (async () => {
          callLog.push({ type: 'saveStreakData' });
          return { success: true };
        }),
        updateStreaks: overrides.updateStreaks || (() => {
          callLog.push({ type: 'updateStreaks' });
          return { streakUsers: {}, results: [] };
        }),
        formatStreakInfo: overrides.formatStreakInfo || (() => 'テストストリーク情報'),
        isStudied: overrides.isStudied || (() => false),
        createInitialState: overrides.createInitialState || (() => ({ streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null })),
        getRequirementForCourse: overrides.getRequirementForCourse || ((course) => course === 'juniorHigh' ? 3 : 4),
        STREAK_REQUIREMENTS: overrides.STREAK_REQUIREMENTS || { elementaryMissions: 4, juniorHighCourses: { weekday: 3, weekend: 5 } }
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

    it('正常系: LINE通知がsendPushMessage経由で送信される', async () => {
      await mainModule.main();

      const pushCalls = callLog.filter(c => c.type === 'sendPushMessage');
      assert.strictEqual(pushCalls.length, 1, 'sendPushMessageが1回呼ばれること');
      const [message, accessToken, userId] = pushCalls[0].args;
      assert.strictEqual(typeof message, 'string', '整形済みメッセージが渡されること');
      assert.strictEqual(accessToken, 'test_token');
      assert.strictEqual(userId, 'test_user');

      const fetchCalls = callLog.filter(c => c.type === 'fetch');
      assert.strictEqual(fetchCalls.length, 0, '素のfetch直書きが使われないこと');
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

    it('異常系: 詳細・基本の両方が失敗した場合、「変更なし」ではなく障害通知を送る', async () => {
      setupMocks({
        getAllUsersDetailedData: async () => ({ success: false, error: '詳細失敗' }),
        getAllUsersMissionCounts: async () => ({ success: false, error: '基本も失敗' })
      });

      await mainModule.main();

      const notifyCalls = callLog.filter(c => c.type === 'sendNotification');
      assert.strictEqual(notifyCalls.length, 0, '空changesのsendNotification(=変更なし偽装)が呼ばれないこと');

      const pushCalls = callLog.filter(c => c.type === 'sendPushMessage');
      assert.strictEqual(pushCalls.length, 1, '障害通知がsendPushMessageで送られること');
      const [message] = pushCalls[0].args;
      assert.match(message, /⚠️/, '警告アイコンが含まれること');
      assert.match(message, /エラー|失敗/, '障害であることが明示されること');
      assert.doesNotMatch(message, /変更ありませんでした/, '正常を装うメッセージでないこと');
    });

    it('異常系: LINE API失敗時、errorsに記録される', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 500 Internal Server Error' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(Array.isArray(result.errors), true);
      assert.strictEqual(result.errors.some(e => e.includes('LINE API')), true);
    });

    it('異常系: LINE送信のネットワークエラー時、errorsに記録', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'ネットワークエラー: Network error' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(Array.isArray(result.errors), true);
    });

    it('正常系: 夜通知は確定処理(updateStreaks/saveStreakData)を行わない', async () => {
      await mainModule.main();

      const updateCalls = callLog.filter(c => c.type === 'updateStreaks');
      const saveStreakCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(updateCalls.length, 0, '夜通知はupdateStreaksを呼ばない');
      assert.strictEqual(saveStreakCalls.length, 0, '夜通知はsaveStreakDataを呼ばない');
    });

    it('正常系: 夜通知は当日学習判定にコース別しきい値を使い、警告閾値も渡す', async () => {
      let capturedIsStudiedOptions;
      let capturedFormatOptions;
      setupMocks({
        // 未達(false)にして送信経路を通す(全員達成だと送信スキップされ警告閾値を検証できない)
        isStudied: (user, options) => { capturedIsStudiedOptions = options; return false; },
        getRequirementForCourse: (course) => course === 'juniorHigh' ? 3 : 4,
        formatDetailedMessage: (currentData, changes, options) => {
          capturedFormatOptions = options;
          return 'テスト詳細メッセージ';
        }
      });

      await mainModule.main();

      // デフォルトの太郎は course 未設定 → elementary 扱い → 4
      assert.deepStrictEqual(
        capturedIsStudiedOptions,
        { minCompletedMissions: 4 },
        '当日暫定判定に elementary しきい値(4)が渡ること'
      );
      assert.ok(capturedFormatOptions.missionWarningThresholds, 'missionWarningThresholds が渡ること');
      assert.strictEqual(capturedFormatOptions.missionWarningThresholds.elementary, 4);
      assert.strictEqual(capturedFormatOptions.missionWarningThresholds.juniorHigh, 3);
    });

    it('正常系: 全ユーザーがストリーク要件達成済みの日は夜通知を送信しない(送信数節約)', async () => {
      setupMocks({
        isStudied: () => true
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true, '送信スキップでも正常終了すること');
      assert.strictEqual(result.exitCode, 0);

      const pushCalls = callLog.filter(c => c.type === 'sendPushMessage');
      assert.strictEqual(pushCalls.length, 0, '全員達成の日はsendPushMessageが呼ばれないこと');

      const saveCalls = callLog.filter(c => c.type === 'saveData');
      assert.strictEqual(saveCalls.length, 1, '通知しない日もデータは保存されること');
    });

    it('正常系: 未達ユーザーが1人でもいる日は夜通知を送信する', async () => {
      // 太郎(達成)と次郎(未達)の2ユーザー
      setupMocks({
        getAllUsersDetailedData: async () => ({
          success: true,
          detailsAvailable: true,
          data: [
            { userName: '太郎', missionCount: 5, missions: [] },
            { userName: '次郎', missionCount: 1, missions: [] }
          ]
        }),
        isStudied: (user) => user.userName === '太郎'
      });

      await mainModule.main();

      const pushCalls = callLog.filter(c => c.type === 'sendPushMessage');
      assert.strictEqual(pushCalls.length, 1, '未達ユーザーがいる日は送信されること');
    });

    it('正常系: ドライラン+全員達成の日は送信もデータ保存も行わない', async () => {
      const originalDryRun = process.env.DRY_RUN;
      process.env.DRY_RUN = 'true';

      setupMocks({
        isStudied: () => true
      });

      try {
        const result = await mainModule.main();

        assert.strictEqual(result.success, true);
        assert.strictEqual(callLog.filter(c => c.type === 'sendPushMessage').length, 0);
        assert.strictEqual(callLog.filter(c => c.type === 'saveData').length, 0, 'ドライランではデータ保存しないこと');
      } finally {
        if (originalDryRun === undefined) {
          delete process.env.DRY_RUN;
        } else {
          process.env.DRY_RUN = originalDryRun;
        }
      }
    });

    it('正常系: ドライランモードでは送信・保存を行わない', async () => {
      const originalDryRun = process.env.DRY_RUN;
      process.env.DRY_RUN = 'true';

      let saveStreakCalls = 0;
      setupMocks({
        saveStreakData: async () => {
          saveStreakCalls++;
          return { success: true };
        }
      });

      try {
        const result = await mainModule.main();

        assert.strictEqual(result.success, true, 'ドライランが成功すること');
        assert.strictEqual(result.exitCode, 0);

        const pushCalls = callLog.filter(c => c.type === 'sendPushMessage');
        assert.strictEqual(pushCalls.length, 0, 'sendPushMessageが呼ばれないこと');

        const saveCalls = callLog.filter(c => c.type === 'saveData');
        assert.strictEqual(saveCalls.length, 0, 'saveDataが呼ばれないこと');

        assert.strictEqual(saveStreakCalls, 0, 'saveStreakDataが呼ばれないこと');
      } finally {
        if (originalDryRun === undefined) {
          delete process.env.DRY_RUN;
        } else {
          process.env.DRY_RUN = originalDryRun;
        }
      }
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

  describe('ストリーク統合', () => {
    it('正常系: 当日クロールが courseFilter:null で1回だけ呼ばれる(前日クロールしない)', async () => {
      const detailedCalls = [];
      setupMocks({
        getAllUsersDetailedData: async (page, options) => {
          detailedCalls.push(options);
          return {
            success: true,
            data: [{ userName: '太郎', course: 'elementary', missionCount: 5, date: '2025-12-25', studyTime: { hours: 1, minutes: 30 }, missions: [], totalScore: 100 }],
            detailsAvailable: true,
            partialFailure: false
          };
        }
      });

      await mainModule.main();

      assert.strictEqual(detailedCalls.length, 1, 'getAllUsersDetailedData は当日分の1回だけ');
      assert.deepStrictEqual(detailedCalls[0], { courseFilter: null }, '両コース(null)で当日分を取得すること');
    });

    it('異常系: loadStreakData失敗時、errorsに記録し保存せず表示のみで続行する', async () => {
      let capturedFormatOptions;
      setupMocks({
        loadStreakData: async () => ({ success: false, error: 'ストリークデータ読み込み失敗' }),
        formatDetailedMessage: (currentData, changes, options) => {
          capturedFormatOptions = options;
          return 'テスト詳細メッセージ';
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1, 'loadStreakData失敗時は終了コード1');
      assert.strictEqual(result.errors.includes('ストリークデータ読み込み失敗'), true, 'errorsに記録されること');

      const saveStreakCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveStreakCalls.length, 0, '夜通知は保存しないこと');

      const pushCalls = callLog.filter(c => c.type === 'sendPushMessage');
      assert.strictEqual(pushCalls.length, 1, '通知は送信されること');
      assert.ok(capturedFormatOptions.streaks, 'streaksマップは渡されること(空状態ベース)');
    });

    it('正常系: formatDetailedMessageに渡すoptions.streaksに対象ユーザーのキーが含まれる', async () => {
      let capturedOptions;
      setupMocks({
        formatDetailedMessage: (currentData, missionChangesResult, options) => {
          capturedOptions = options;
          return 'テスト詳細メッセージ';
        }
      });

      await mainModule.main();

      assert.ok(capturedOptions, 'formatDetailedMessageが呼ばれること');
      assert.ok(capturedOptions.streaks, 'streaksオプションが渡されること');
      assert.strictEqual(typeof capturedOptions.streaks['太郎'], 'string', '対象ユーザー(太郎)のキーが含まれること');
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
