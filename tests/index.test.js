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
  '../src/crawler', '../src/data', '../src/notifier', '../src/broadcast', '../src/streak', 'playwright'
];

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    try { delete require.cache[resolveModule(p)]; } catch {}
  }
}

// 切り詰めは本物を使う（DRY_RUNプレビューが実送信と同じ文面になることを担保するため）
const { truncateToLimit: realTruncateToLimit } = require('../src/notifier');
const { getDiscordFailure: realGetDiscordFailure } = require('../src/broadcast');

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
      data: [{ userName: '太郎', studyItemCount: 5, missionCount: 5, date: '2025-12-25', studyTime: '1時間30分', missions: [], totalScore: 100 }],
      detailsAvailable: true,
      partialFailure: false
    };
    const crawlBasicResult = overrides.crawlBasicResult || {
      success: true,
      data: [{ userName: '太郎', studyItemCount: 5, missionCount: 5, date: '2025-12-25' }]
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
        formatMessage: overrides.formatMessage || ((changes) => `テスト基本メッセージ(${changes.length}件)`),
        formatUnqualifiedMessage: overrides.formatUnqualifiedMessage || (() => 'テスト未達メッセージ'),
        // 切り詰めはDRY_RUNプレビューで使うので本物を使う
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
        broadcastToDiscordOnly: overrides.broadcastToDiscordOnly || (async (...args) => {
          callLog.push({ type: 'broadcastToDiscordOnly', args });
          return { success: true, results: [{ channel: 'discord', success: true }] };
        }),
        // 判定は純粋関数なのでモックせず本物を使う（resultsの形と終了コードの連動を検証したいため）
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
        updateStreaks: overrides.updateStreaks || (() => {
          callLog.push({ type: 'updateStreaks' });
          return { streakUsers: {}, results: [] };
        }),
        formatStreakInfo: overrides.formatStreakInfo || (() => 'テストストリーク情報'),
        isStudied: overrides.isStudied || (() => false),
        createInitialState: overrides.createInitialState || (() => ({ streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null })),
        getRequirementForCourse: overrides.getRequirementForCourse || ((course) => course === 'juniorHigh' ? 3 : 4),
        STREAK_REQUIREMENTS: overrides.STREAK_REQUIREMENTS || { elementaryMissions: 4, juniorHighCourses: 3 }
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

    it('正常系: 通知がbroadcastToAll経由で送信される', async () => {
      await mainModule.main();

      const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
      assert.strictEqual(pushCalls.length, 1, 'broadcastToAllが1回呼ばれること');
      const [message, passedConfig] = pushCalls[0].args;
      assert.strictEqual(typeof message, 'string', '整形済みメッセージが渡されること');
      assert.strictEqual(passedConfig.LINE_CHANNEL_ACCESS_TOKEN, 'test_token');
      assert.strictEqual(passedConfig.LINE_USER_ID, 'test_user');

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

    it('正常系: 基本モードにフォールバックした場合も通知はbroadcast経由で送られる', async () => {
      setupMocks({
        crawlDetailedResult: { success: false, error: '詳細取得エラー' }
      });

      await mainModule.main();

      const calls = callLog.filter(c => c.type === 'broadcastToAll');
      assert.strictEqual(calls.length, 1, '基本モードでも1回だけ通知すること');
      assert.match(calls[0].args[0], /テスト基本メッセージ/, 'formatMessageの結果が送られること');
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

    it('異常系: 詳細も基本も失敗したら「変更なし」ではなく障害通知を送る', async () => {
      setupMocks({
        crawlDetailedResult: { success: false, error: '詳細取得エラー' },
        crawlBasicResult: { success: false, error: '基本取得エラー' }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      const calls = callLog.filter(c => c.type === 'broadcastToAll');
      assert.strictEqual(calls.length, 1, '障害通知が送られること');
      assert.match(calls[0].args[0], /⚠️/, '障害メッセージであること');
      assert.doesNotMatch(calls[0].args[0], /変更ありませんでした/, '正常を装うメッセージでないこと');
    });

    it('異常系: 全宛先で送信失敗した場合、errorsに記録される', async () => {
      setupMocks({
        broadcastToAll: async () => ({
          success: false,
          results: [
            { channel: 'line', success: false, error: 'LINE API エラー: 500 Internal Server Error' },
            { channel: 'discord', success: false, error: 'Discord API エラー: 404' }
          ]
        })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(Array.isArray(result.errors), true);
      assert.strictEqual(result.errors.some(e => e.includes('全宛先')), true);
    });

    it('正常系: LINEが失敗してもDiscordに届いていれば成功扱いになる', async () => {
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

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);
    });

    it('異常系: LINEが成功してもDiscordが失敗したら異常終了する（Webhook失効の検知）', async () => {
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

      assert.strictEqual(result.exitCode, 1, 'Discord失敗はワークフローを赤くすること');
      assert.strictEqual(result.errors.some(e => e.includes('Unknown Webhook')), true, '失効を判別できる理由が残ること');
    });

    it('正常系: Webhook未設定でDiscordのresultsが無い場合は正常終了する', async () => {
      setupMocks({
        broadcastToAll: async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 0, '宛先がないだけなので赤くしないこと');
    });

    it('正常系: 夜通知は確定処理(updateStreaks/saveStreakData)を行わない', async () => {
      await mainModule.main();

      const updateCalls = callLog.filter(c => c.type === 'updateStreaks');
      const saveStreakCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(updateCalls.length, 0, '夜通知はupdateStreaksを呼ばない');
      assert.strictEqual(saveStreakCalls.length, 0, '夜通知はsaveStreakDataを呼ばない');
    });

    it('正常系: 夜通知は当日学習判定にコース別しきい値を使う', async () => {
      let capturedIsStudiedOptions;
      setupMocks({
        // 未達(false)にして送信経路を通す(全員達成だと送信スキップされ判定を検証できない)
        isStudied: (user, options) => { capturedIsStudiedOptions = options; return false; },
        getRequirementForCourse: (course) => course === 'juniorHigh' ? 3 : 4
      });

      await mainModule.main();

      // デフォルトの太郎は course 未設定 → elementary 扱い → 4
      assert.deepStrictEqual(
        capturedIsStudiedOptions,
        { minCompletedMissions: 4 },
        '当日暫定判定に elementary しきい値(4)が渡ること'
      );
    });

    it('正常系: 全ユーザーがストリーク要件達成済みの日はDiscordのみに送る(LINE送信数節約)', async () => {
      setupMocks({
        isStudied: () => true
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);

      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 0,
        '全員達成の日はLINE経路(broadcastToAll)を使わないこと'
      );
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToDiscordOnly').length, 1,
        '全員達成の日はDiscordのみに1回送ること'
      );

      const saveCalls = callLog.filter(c => c.type === 'saveData');
      assert.strictEqual(saveCalls.length, 1, 'データは保存されること');
    });

    it('正常系: 全員達成の日のDiscord本文には断り行が先頭に付く', async () => {
      setupMocks({
        isStudied: () => true,
        formatUnqualifiedMessage: () => 'テスト未達メッセージ'
      });

      await mainModule.main();

      const [sentMessage] = callLog.find(c => c.type === 'broadcastToDiscordOnly').args;
      assert.match(
        sentMessage,
        /^ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します\(送信数節約\)\n\n/,
        '断り行と空行が先頭に付くこと'
      );
      assert.match(sentMessage, /テスト未達メッセージ/, '本文が保持されること');
    });

    it('正常系: 免除ユーザーがいる日のDiscord本文は「全員が達成した」と主張しない', async () => {
      setupMocks({
        // 唯一のクロール対象ユーザー(太郎)が当日免除日 → 未達判定から除外され discordOnly になる
        loadStreakData: async () => ({
          success: true,
          data: { '太郎': { exemptDates: ['2025-12-24'] } }
        }),
        formatUnqualifiedMessage: () => 'テスト未達メッセージ'
      });

      await mainModule.main();

      const [sentMessage] = callLog.find(c => c.type === 'broadcastToDiscordOnly').args;
      assert.doesNotMatch(
        sentMessage,
        /全員が本日のストリーク要件を達成した/,
        '免除ユーザーがいる日に「全員達成」と読める文言を出さないこと'
      );
      assert.match(sentMessage, /おやすみ登録/, '免除があったことが分かる文言を出すこと');
      assert.match(sentMessage, /テスト未達メッセージ/, '本文が保持されること');
    });

    it('異常系: 全員達成の日にDiscord送信が失敗したら終了コード1になる', async () => {
      setupMocks({
        isStudied: () => true,
        broadcastToDiscordOnly: async (...args) => {
          callLog.push({ type: 'broadcastToDiscordOnly', args });
          return { success: false, results: [{ channel: 'discord', success: false, error: 'Discord API エラー: 404' }] };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1, 'どこにも届かないので赤くすること');
    });

    it('正常系: Webhook未設定(skipped)なら赤くせず正常終了する', async () => {
      setupMocks({
        isStudied: () => true,
        broadcastToDiscordOnly: async (...args) => {
          callLog.push({ type: 'broadcastToDiscordOnly', args });
          return { success: false, skipped: true, results: [] };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true, '宛先がないだけなので赤くしないこと');
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'saveData').length, 1, 'データは保存されること');
    });

    it('正常系: 未達ユーザーが1人でもいる日は夜通知を送信する', async () => {
      // 太郎(達成)と次郎(未達)の2ユーザー
      setupMocks({
        getAllUsersDetailedData: async () => ({
          success: true,
          detailsAvailable: true,
          data: [
            { userName: '太郎', studyItemCount: 5, missionCount: 5, missions: [] },
            { userName: '次郎', studyItemCount: 1, missionCount: 1, missions: [] }
          ]
        }),
        isStudied: (user) => user.userName === '太郎'
      });

      await mainModule.main();

      const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
      assert.strictEqual(pushCalls.length, 1, '未達ユーザーがいる日は送信されること');

      const [sentMessage] = pushCalls[0].args;
      assert.doesNotMatch(
        sentMessage,
        /全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します/,
        'LINE経路には全員達成の断り行が付かないこと'
      );
    });

    it('正常系: 免除日のユーザーは未達に数えずDiscordのみに送る', async () => {
      setupMocks({
        isStudied: () => false, // 全員がしきい値未達
        loadStreakData: async () => ({
          success: true,
          data: { '太郎': { exemptDates: ['2025-12-24'] } } // getTargetDates モックと同じ日
        })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 0,
        '免除日のユーザーしかいない日はLINE経路を使わないこと'
      );
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToDiscordOnly').length, 1,
        'Discordには記録として送ること'
      );
    });

    it('正常系: 免除日でないユーザーが未達なら従来どおりLINEに送る', async () => {
      setupMocks({
        isStudied: () => false,
        loadStreakData: async () => ({
          success: true,
          data: { '太郎': { exemptDates: ['2025-12-01'] } } // 当日ではない免除日
        })
      });

      await mainModule.main();

      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 1,
        '免除日でない未達ユーザーがいればLINEに送ること'
      );
    });

    it('正常系: ストリークデータを読めなくても免除なしとして通知を続ける', async () => {
      setupMocks({
        isStudied: () => false,
        loadStreakData: async () => ({ success: false, error: '読み込み失敗' })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true, '通知処理は止めないこと');
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 1,
        '免除なし扱いで従来どおり送ること'
      );
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
        assert.strictEqual(callLog.filter(c => c.type === 'broadcastToAll').length, 0);
        assert.strictEqual(callLog.filter(c => c.type === 'broadcastToDiscordOnly').length, 0, 'ドライランではDiscordにも送らないこと');
        assert.strictEqual(callLog.filter(c => c.type === 'saveData').length, 0, 'ドライランではデータ保存しないこと');
      } finally {
        if (originalDryRun === undefined) {
          delete process.env.DRY_RUN;
        } else {
          process.env.DRY_RUN = originalDryRun;
        }
      }
    });

    it('正常系: ドライラン+全員達成の日はプレビューを切り詰めない（Discordは分割して全文が届く）', async () => {
      const originalDryRun = process.env.DRY_RUN;
      process.env.DRY_RUN = 'true';
      const longMessage = 'あ'.repeat(5000);

      setupMocks({
        isStudied: () => true,
        formatUnqualifiedMessage: () => longMessage
      });

      const logs = [];
      const originalConsoleLog = console.log;
      console.log = (...args) => { logs.push(args); };

      try {
        await mainModule.main();
      } finally {
        console.log = originalConsoleLog;
        if (originalDryRun === undefined) {
          delete process.env.DRY_RUN;
        } else {
          process.env.DRY_RUN = originalDryRun;
        }
      }

      const previewLog = logs.find(args =>
        typeof args[0] === 'string' && args[0].includes(longMessage.slice(0, 50))
      );
      assert.ok(previewLog, 'プレビューが出力されること');
      assert.ok(
        previewLog[0].includes(longMessage),
        'プレビューに本文が全文含まれること（分割送信で欠けないため）'
      );
      assert.ok(
        !previewLog[0].includes('省略'),
        '切り詰めの省略サフィックスが付かないこと'
      );
    });

    it('正常系: ドライラン+未達ユーザーがいる日はプレビューがLINEの上限(5000文字)まで収まる', async () => {
      const originalDryRun = process.env.DRY_RUN;
      process.env.DRY_RUN = 'true';
      const longMessage = 'あ'.repeat(5000);

      setupMocks({
        isStudied: () => false,
        formatUnqualifiedMessage: () => longMessage
      });

      const logs = [];
      const originalConsoleLog = console.log;
      console.log = (...args) => { logs.push(args); };

      try {
        await mainModule.main();
      } finally {
        console.log = originalConsoleLog;
        if (originalDryRun === undefined) {
          delete process.env.DRY_RUN;
        } else {
          process.env.DRY_RUN = originalDryRun;
        }
      }

      const previewLog = logs.find(args =>
        typeof args[0] === 'string' && args[0].includes(longMessage.slice(0, 50))
      );
      assert.ok(previewLog, 'プレビューが出力されること');
      assert.ok(
        previewLog[0].length > 2000,
        `プレビューがDiscordの上限(2000)より長く切り詰められること(実測${previewLog[0].length}文字)`
      );
      assert.ok(
        previewLog[0].length <= 5000,
        `プレビューがLINEの上限(5000)以内に収まること(実測${previewLog[0].length}文字)`
      );
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

        const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
        assert.strictEqual(pushCalls.length, 0, 'broadcastToAllが呼ばれないこと');

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
            data: [{ userName: '太郎', course: 'elementary', studyItemCount: 5, missionCount: 5, date: '2025-12-25', studyTime: { hours: 1, minutes: 30 }, missions: [], totalScore: 100 }],
            detailsAvailable: true,
            partialFailure: false
          };
        }
      });

      await mainModule.main();

      assert.strictEqual(detailedCalls.length, 1, 'getAllUsersDetailedData は当日分の1回だけ');
      assert.deepStrictEqual(detailedCalls[0], { courseFilter: null }, '両コース(null)で当日分を取得すること');
    });

    it('夜通知はストリーク確定処理を行わない(loadStreakDataは免除日判定のためだけに読み、失敗しても続行する)', async () => {
      setupMocks({
        loadStreakData: async () => {
          callLog.push({ type: 'loadStreakData' });
          return { success: false, error: 'ストリークデータ読み込み失敗' };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 0, 'ストリーク読み込み失敗に影響されないこと');

      const loadStreakCalls = callLog.filter(c => c.type === 'loadStreakData');
      assert.strictEqual(loadStreakCalls.length, 1, '免除日判定のためloadStreakDataは呼ばれること');

      const saveStreakCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveStreakCalls.length, 0, '夜通知は保存しないこと(確定処理はしない)');

      const pushCalls = callLog.filter(c => c.type === 'broadcastToAll');
      assert.strictEqual(pushCalls.length, 1, '通知は送信されること');
    });

    it('formatUnqualifiedMessageに未達ユーザーの名前だけを渡す', async () => {
      let capturedParams;
      setupMocks({
        getAllUsersDetailedData: async () => ({
          success: true,
          detailsAvailable: true,
          data: [
            { userName: '太郎', studyItemCount: 5, missionCount: 5, missions: [] },
            { userName: '次郎', studyItemCount: 1, missionCount: 1, missions: [] }
          ]
        }),
        isStudied: (user) => user.userName === '太郎',
        formatUnqualifiedMessage: (params) => {
          capturedParams = params;
          return 'テスト未達メッセージ';
        }
      });

      await mainModule.main();

      assert.ok(capturedParams, 'formatUnqualifiedMessageが呼ばれること');
      assert.deepStrictEqual(capturedParams.unqualifiedNames, ['次郎'], '未達ユーザーだけを渡すこと');
      assert.deepStrictEqual(capturedParams.unreliableNames, [], '取得失敗ユーザーはいないこと');
    });

    it('免除日のユーザーはexemptNamesとしてformatUnqualifiedMessageに渡る', async () => {
      let capturedParams;
      setupMocks({
        loadStreakData: async () => ({
          success: true,
          data: { '太郎': { exemptDates: ['2025-12-24'] } }
        }),
        isStudied: () => false,
        formatUnqualifiedMessage: (params) => {
          capturedParams = params;
          return 'テスト未達メッセージ';
        }
      });

      await mainModule.main();

      assert.deepStrictEqual(capturedParams.exemptNames, ['太郎'], '免除日のユーザーを渡すこと');
      assert.deepStrictEqual(capturedParams.unqualifiedNames, [], '免除日のユーザーを未達に数えないこと');
    });

    it('データ取得に失敗したユーザーは未達ではなくunreliableNamesに入る', async () => {
      let capturedParams;
      setupMocks({
        getAllUsersDetailedData: async () => ({
          success: true,
          detailsAvailable: true,
          data: [
            { userName: '太郎', studyItemCount: 5, missionCount: 5, missions: [] },
            { userName: '次郎', dataReliable: false, studyItemCount: 0, missionCount: 0, missions: [] }
          ]
        }),
        isStudied: () => true,
        formatUnqualifiedMessage: (params) => {
          capturedParams = params;
          return 'テスト未達メッセージ';
        }
      });

      await mainModule.main();

      assert.deepStrictEqual(capturedParams.unqualifiedNames, [], '取得失敗ユーザーを未達に混ぜないこと');
      assert.deepStrictEqual(capturedParams.unreliableNames, ['次郎'], '取得失敗ユーザーを別枠に渡すこと');
    });

    it('データ取得に失敗したユーザーがいる日はLINEにも送る', async () => {
      setupMocks({
        getAllUsersDetailedData: async () => ({
          success: true,
          detailsAvailable: true,
          data: [
            { userName: '次郎', dataReliable: false, studyItemCount: 0, missionCount: 0, missions: [] }
          ]
        }),
        // 他のユーザーは全員達成という状況でも、取得失敗があれば見逃さないようLINEに送る
        isStudied: () => true
      });

      await mainModule.main();

      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToAll').length, 1,
        '取得失敗ユーザーがいる日はLINE経路を使うこと'
      );
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToDiscordOnly').length, 0,
        'Discordのみの経路にしないこと'
      );
    });

    it('データ取得に失敗したユーザーには当日学習判定を行わない', async () => {
      const isStudiedCalls = [];
      setupMocks({
        getAllUsersDetailedData: async () => ({
          success: true,
          detailsAvailable: true,
          data: [
            { userName: '太郎', studyItemCount: 5, missionCount: 5, missions: [] },
            { userName: '次郎', dataReliable: false, studyItemCount: 0, missionCount: 0, missions: [] }
          ]
        }),
        isStudied: (user) => { isStudiedCalls.push(user.userName); return true; }
      });

      await mainModule.main();

      assert.deepStrictEqual(isStudiedCalls, ['太郎'], '取得失敗ユーザーは判定対象から外すこと');
    });

    it('ミッション詳細の差分比較は行わない(本文に使わないため)', async () => {
      let compareMissionDetailsCalls = 0;
      setupMocks({
        compareMissionDetails: () => {
          compareMissionDetailsCalls++;
          return { success: true, changes: [] };
        }
      });

      await mainModule.main();

      assert.strictEqual(compareMissionDetailsCalls, 0, 'compareMissionDetailsを呼ばないこと');
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
