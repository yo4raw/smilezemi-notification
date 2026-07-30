/**
 * クローラーモジュールのテスト
 * Requirements: 3.1, 3.2, 3.3, 3.4
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

describe('クローラーモジュール (src/crawler.js)', () => {
  let crawler;

  beforeEach(() => {
    crawler = require('../src/crawler');
  });

  // ─── テスト用モックファクトリ ───

  /**
   * Playwright互換のチェーン可能なLocatorモック
   */
  function createChainableLocator(opts = {}) {
    return {
      filter: mock.fn(() => createChainableLocator(opts)),
      first: mock.fn(() => createChainableLocator(opts)),
      click: mock.fn(async () => {
        if (opts.throwOnClick) throw opts.throwOnClick;
      }),
      isVisible: mock.fn(async () => {
        if (opts.throwOnAll) throw opts.throwOnAll;
        return opts.visible !== undefined ? opts.visible : true;
      }),
      all: mock.fn(async () => {
        if (opts.throwOnAll) throw opts.throwOnAll;
        return opts.elements || [];
      }),
      textContent: mock.fn(async () => opts.text || ''),
      innerText: mock.fn(async () => opts.text || ''),
      count: mock.fn(async () => (opts.elements || []).length),
      boundingBox: mock.fn(async () => opts.box || null),
      locator: mock.fn(() => createChainableLocator()),
    };
  }

  /**
   * Playwright要素モック
   */
  function createMockElement(text, box = { x: 100, y: 100, width: 100, height: 20 }) {
    return {
      textContent: mock.fn(async () => text),
      innerText: mock.fn(async () => text),
      click: mock.fn(async () => {}),
      isVisible: mock.fn(async () => true),
      boundingBox: mock.fn(async () => box),
      locator: mock.fn(() => createChainableLocator()),
    };
  }

  /**
   * Playwright Pageオブジェクトのモック
   *
   * @param {object} config
   * @param {string[]} config.userNames - ユーザー名一覧（「さん」付き）
   * @param {boolean} config.showChildrenHeader - 「お子さま」セクション表示フラグ
   * @param {Error|null} config.throwOnFirstLocator - 最初のlocatorでスローするエラー
   * @param {number} config.vpWidth - ビューポート幅
   * @param {number} config.vpHeight - ビューポート高さ
   */
  function createMockPage(config = {}) {
    const {
      userNames = ['太郎さん', '花子さん'],
      showChildrenHeader = true,
      throwOnFirstLocator = null,
      vpWidth = 1280,
      vpHeight = 720,
    } = config;

    // サイドバー内のユーザー要素（左側に配置）
    const userElements = userNames.map((name, i) =>
      createMockElement(name, { x: 100, y: 200 + i * 30, width: 100, height: 20 })
    );

    // 右上に表示される現在のユーザー名（getCurrentUserNameが参照）
    const currentUserName = userNames[0] || '';
    const currentUserBox = {
      x: vpWidth * 0.7,
      y: vpHeight * 0.05,
      width: 100,
      height: 20,
    };
    const currentUserEl = createMockElement(currentUserName, currentUserBox);

    const page = {
      locator: mock.fn((selector) => {
        // エラーモード: 全てのlocator操作でエラーをスロー
        if (throwOnFirstLocator) {
          return createChainableLocator({
            throwOnAll: throwOnFirstLocator,
            throwOnClick: throwOnFirstLocator,
            visible: false,
          });
        }

        // div要素（ユーザーエリアクリック、候補検索で使用）
        if (selector === 'div') {
          return createChainableLocator({
            elements: [currentUserEl, ...userElements],
            text: currentUserName,
            box: currentUserBox,
          });
        }

        // 「お子さま」ヘッダー
        if (selector === 'text="お子さま"') {
          return createChainableLocator({ visible: showChildrenHeader });
        }

        // MENUボタン（テストでは非表示）
        if (selector === 'text="MENU"') {
          return createChainableLocator({ visible: false });
        }

        // プロフィール設定ページチェック
        if (selector === 'text="プロフィール設定"') {
          return createChainableLocator({ visible: false });
        }

        // 正規表現パターンによるユーザー名検索 (text=/.*さん$/)
        if (typeof selector === 'string' && selector.includes('さん') && !selector.startsWith('text="')) {
          return createChainableLocator({ elements: userElements });
        }

        // 特定のtext="名前"セレクタ（サイドバー内のユーザー検索）
        if (typeof selector === 'string' && selector.startsWith('text="')) {
          const name = selector.match(/text="(.+)"/)?.[1];
          if (name && userNames.includes(name)) {
            return createChainableLocator({
              visible: true,
              elements: [createMockElement(name, { x: 200, y: 300, width: 100, height: 20 })],
            });
          }
          return createChainableLocator({ visible: false, elements: [] });
        }

        // その他（日付パターン等）
        return createChainableLocator({ elements: [], visible: false });
      }),
      url: mock.fn(() => config.pageUrl || 'https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline'),
      waitForTimeout: mock.fn(async () => {}),
      waitForLoadState: mock.fn(async () => {}),
      waitForSelector: mock.fn(async () => null),
      waitForFunction: mock.fn(async () => {}),
      keyboard: { press: mock.fn(async () => {}) },
      viewportSize: mock.fn(() => ({ width: vpWidth, height: vpHeight })),
      evaluate: mock.fn(async () => {}),
      screenshot: mock.fn(async () => {}),
      goBack: mock.fn(async () => {}),
    };

    return page;
  }

  // ─── getUserList テスト ───

  describe('getUserList() - ユーザー一覧取得', () => {
    it('正常系: ログイン後のページからユーザー一覧を取得できる', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん', '花子さん'] });
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true, 'ユーザー一覧取得が成功すること');
      assert.strictEqual(Array.isArray(result.users), true, 'usersが配列であること');
      assert.strictEqual(result.users.length > 0, true, 'ユーザーが1人以上存在すること');
    });

    it('正常系: 各ユーザーに名前が含まれる', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん', '花子さん'] });
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true);
      result.users.forEach(user => {
        assert.strictEqual(typeof user.name, 'string', 'ユーザー名が文字列であること');
        assert.strictEqual(user.name.length > 0, true, 'ユーザー名が空でないこと');
      });
    });

    it('正常系: 各ユーザーにインデックスが含まれる', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん', '花子さん'] });
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true);
      result.users.forEach((user, index) => {
        assert.strictEqual(typeof user.index, 'number', 'インデックスが数値であること');
        assert.strictEqual(user.index, index, 'インデックスが連番であること');
      });
    });

    it('異常系: ユーザー要素が見つからない場合、エラーを返す', async () => {
      const mockPage = createMockPage({ userNames: [], showChildrenHeader: true });
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, false, 'ユーザー一覧取得が失敗すること');
      assert.strictEqual(typeof result.error, 'string', 'エラーメッセージが含まれること');
    });

    it('異常系: タイムアウトが発生した場合、エラーを返す', async () => {
      const mockPage = createMockPage({
        throwOnFirstLocator: new Error('Timeout 30000ms exceeded'),
      });

      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /タイムアウト|Timeout/);
    });

    // 固定待機→条件ベース待機への置き換え（waitForSelector）の回帰テスト
    it('正常系: サイドバー表示を waitForSelector で待機する', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん', '花子さん'] });
      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        mockPage.waitForSelector.mock.callCount() >= 1,
        true,
        'waitForSelectorで条件ベース待機が行われること'
      );
    });

    it('正常系: waitForSelectorがタイムアウトしても後続のisVisibleチェックで成功する', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'], showChildrenHeader: true });
      mockPage.waitForSelector = mock.fn(async () => {
        throw new Error('Timeout 10000ms exceeded');
      });

      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, true, 'waitForSelector失敗はcatchで握りつぶされ成功すること');
    });

    it('異常系: waitForSelectorタイムアウト後、要素が無ければ従来どおりエラーを返す', async () => {
      const mockPage = createMockPage({ userNames: [], showChildrenHeader: false });
      mockPage.waitForSelector = mock.fn(async () => {
        throw new Error('Timeout 10000ms exceeded');
      });

      const result = await crawler.getUserList(mockPage);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /お子さま/, '従来のエラーメッセージが維持されること');
    });
  });

  // ─── getMissionCount テスト ───

  describe('getMissionCount() - ミッション数取得', () => {
    it('正常系: ユーザーを指定してミッション数を取得できる', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getMissionCount(mockPage, '太郎さん');

      assert.strictEqual(result.success, true, 'ミッション数取得が成功すること');
      assert.strictEqual(typeof result.count, 'number', 'ミッション数が数値であること');
      assert.strictEqual(result.count >= 0, true, 'ミッション数が0以上であること');
    });

    it('正常系: ミッション数が数値として返される', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getMissionCount(mockPage, '太郎さん');

      assert.strictEqual(result.success, true);
      assert.strictEqual(typeof result.count, 'number', 'ミッション数が数値型であること');
    });

    it('正常系: 今日のデータがない場合は0件を返す', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getMissionCount(mockPage, '太郎さん');

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 0, '今日のデータがない場合は0件');
    });

    it('異常系: 存在しないユーザーの場合、エラーを返す', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getMissionCount(mockPage, '存在しないユーザー');

      assert.strictEqual(result.success, false);
      assert.strictEqual(typeof result.error, 'string', 'エラーメッセージが含まれること');
    });

    it('異常系: ページ操作でエラーが発生した場合、エラーを返す', async () => {
      const mockPage = createMockPage({
        throwOnFirstLocator: new Error('ページ操作エラー'),
      });

      const result = await crawler.getMissionCount(mockPage, '太郎さん');

      assert.strictEqual(result.success, false);
      assert.strictEqual(typeof result.error, 'string');
    });

    it('異常系: タイムアウトが発生した場合、エラーを返す', async () => {
      const mockPage = createMockPage({
        throwOnFirstLocator: new Error('Timeout 30000ms exceeded'),
      });

      const result = await crawler.getMissionCount(mockPage, '太郎さん');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /タイムアウト|Timeout|エラー/);
    });
  });

  // ─── getAllUsersMissionCounts テスト ───

  describe('getAllUsersMissionCounts() - 全ユーザーのミッション数取得', () => {
    it('正常系: 全ユーザーのミッション数を取得できる', async () => {
      // 1ユーザーの場合、getCurrentUserNameが一致するため切り替え不要で成功
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, true, '全ユーザーのミッション数取得が成功すること');
      assert.strictEqual(Array.isArray(result.data), true, 'dataが配列であること');
      assert.strictEqual(result.data.length > 0, true, 'データが1件以上あること');
    });

    it('正常系: 各データにユーザー名とミッション数が含まれる', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, true);
      result.data.forEach(item => {
        assert.strictEqual(typeof item.userName, 'string', 'ユーザー名が文字列であること');
        assert.strictEqual(typeof item.missionCount, 'number', 'ミッション数が数値であること');
        assert.strictEqual(item.missionCount >= 0, true, 'ミッション数が0以上であること');
      });
    });

    it('正常系: 各データに日付が含まれる', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, true);
      result.data.forEach(item => {
        assert.strictEqual(typeof item.date, 'string', '日付が文字列であること');
        assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/, '日付がYYYY-MM-DD形式であること');
      });
    });

    it('正常系: 日付がJST基準(getTargetDatesと同一)であること', async () => {
      const mockPage = createMockPage({ userNames: ['太郎さん'] });
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, true);
      const expectedDate = crawler.getTargetDates(0).dateString;
      result.data.forEach(item => {
        assert.strictEqual(
          item.date,
          expectedDate,
          'UTCではなくJST基準の当日日付が記録されること'
        );
      });
    });

    it('異常系: ユーザー一覧取得に失敗した場合、エラーを返す', async () => {
      const mockPage = createMockPage({
        throwOnFirstLocator: new Error('Failed to get users'),
      });

      const result = await crawler.getAllUsersMissionCounts(mockPage);

      assert.strictEqual(result.success, false);
      assert.strictEqual(typeof result.error, 'string');
    });

    it('異常系: 一部のユーザーでエラーが発生しても、取得できたデータは返す', async () => {
      // 2ユーザー: 1人目は成功（currentUserと一致）、2人目は切り替え検証で失敗
      const mockPage = createMockPage({ userNames: ['太郎さん', '花子さん'] });
      const result = await crawler.getAllUsersMissionCounts(mockPage);

      // 部分的な成功（太郎さんのみ成功）
      assert.strictEqual(result.success, true, '部分的に成功すること');
      assert.strictEqual(result.data.length, 1, '成功した1件のデータが返ること');
      assert.strictEqual(
        result.partialFailure,
        true,
        'partialFailureフラグが立つこと'
      );
    });
  });

  // ─── getTotalScore テスト ───

  describe('getTotalScore() - 合計点数計算', () => {
    it('正常系: ミッション配列から合計点数を計算する', () => {
      const missions = [
        { name: '算数', score: 80, completed: true },
        { name: '国語', score: 90, completed: true },
        { name: '理科', score: 70, completed: true },
      ];

      const total = crawler.getTotalScore(missions);
      assert.strictEqual(total, 240, '合計点数が正しいこと');
    });

    it('正常系: 空配列の場合は0を返す', () => {
      assert.strictEqual(crawler.getTotalScore([]), 0);
    });

    it('正常系: null/undefinedの場合は0を返す', () => {
      assert.strictEqual(crawler.getTotalScore(null), 0);
      assert.strictEqual(crawler.getTotalScore(undefined), 0);
    });

    it('正常系: scoreが0のミッションも正しく処理する', () => {
      const missions = [
        { name: '算数', score: 100, completed: true },
        { name: '国語', score: 0, completed: false },
      ];

      assert.strictEqual(crawler.getTotalScore(missions), 100);
    });
  });

  // ─── summarizeStudyRows テスト ───

  describe('summarizeStudyRows() - 行データの集計', () => {
    it('全てミッションの場合、studyItemCount と missionCount が一致する', () => {
      const rows = [
        { name: 'こそあど言葉', isMission: true, score: 93 },
        { name: '小数のひき算', isMission: true, score: 80 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.studyItemCount, 2);
      assert.strictEqual(result.missionCount, 2);
      assert.strictEqual(result.totalScore, 173);
      assert.strictEqual(result.missions.length, 2);
      assert.strictEqual(result.missions[0].isMission, true);
      assert.strictEqual(result.missions[0].completed, true);
    });

    it('ミッションと自主学習が混在する場合、missionCount はミッションのみを数える', () => {
      const rows = [
        { name: 'こそあど言葉', isMission: true, score: 93 },
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.studyItemCount, 2);
      assert.strictEqual(result.missionCount, 1);
      assert.strictEqual(result.missions[1].isMission, false);
    });

    it('全て自主学習の場合、missionCount は0になる', () => {
      const rows = [
        { name: 'ふしぎ探検 世界遺産', isMission: false },
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.studyItemCount, 2);
      assert.strictEqual(result.missionCount, 0);
    });

    it('空配列の場合、全て0と空配列を返す', () => {
      const result = crawler.summarizeStudyRows([]);

      assert.strictEqual(result.studyItemCount, 0);
      assert.strictEqual(result.missionCount, 0);
      assert.strictEqual(result.totalScore, 0);
      assert.deepStrictEqual(result.missions, []);
    });

    it('正答数タイプの行は score 0 で合計点に寄与しない', () => {
      const rows = [
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.totalScore, 0);
      assert.strictEqual(result.missions[0].score, 0);
      assert.strictEqual(result.missions[0].correctAnswers, 9);
      assert.strictEqual(result.missions[0].questionCount, 10);
    });

    it('点数タイプと正答数タイプが混在しても合計点は点数タイプのみ', () => {
      const rows = [
        { name: 'こそあど言葉', isMission: true, score: 93 },
        { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 },
        { name: '小数のひき算', isMission: true, score: 80 }
      ];

      const result = crawler.summarizeStudyRows(rows);

      assert.strictEqual(result.totalScore, 173);
      assert.strictEqual(result.missions[0].questionCount, null);
      assert.strictEqual(result.missions[1].score, 0);
    });

    it('名前が空の行はデフォルト名になる', () => {
      const result = crawler.summarizeStudyRows([{ name: '', isMission: true, score: 50 }]);

      assert.strictEqual(result.missions[0].name, 'ミッション');
    });

    it('rows が配列でない場合も0件として扱う', () => {
      const result = crawler.summarizeStudyRows(null);

      assert.strictEqual(result.studyItemCount, 0);
      assert.deepStrictEqual(result.missions, []);
    });
  });

  describe('getTargetDates', () => {
    it('UTC 22:00 (JST 翌日7:00) のとき dateOffset=0 で JST の今日を返す', () => {
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-09T22:00:00Z').getTime() });
      try {
        const dates = crawler.getTargetDates(0);
        assert.strictEqual(dates.withPadding, '07/10');
        assert.strictEqual(dates.withoutPadding, '7/10');
        assert.strictEqual(dates.dateString, '2026-07-10');
      } finally {
        mock.timers.reset();
      }
    });

    it('dateOffset=-1 で JST の昨日を返す', () => {
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-09T22:00:00Z').getTime() });
      try {
        const dates = crawler.getTargetDates(-1);
        assert.strictEqual(dates.withPadding, '07/09');
        assert.strictEqual(dates.dateString, '2026-07-09');
      } finally {
        mock.timers.reset();
      }
    });

    it('年跨ぎ: JST 1/1 に dateOffset=-1 で前年 12/31 を返す', () => {
      // UTC 2025-12-31T15:00:00Z = JST 2026-01-01T00:00:00
      mock.timers.enable({ apis: ['Date'], now: new Date('2025-12-31T15:00:00Z').getTime() });
      try {
        const dates = crawler.getTargetDates(-1);
        assert.strictEqual(dates.withPadding, '12/31');
        assert.strictEqual(dates.dateString, '2025-12-31');
      } finally {
        mock.timers.reset();
      }
    });
  });

  describe('resolveTargetCourses', () => {
    it('filterなし: 両コース持ちは中学生コースのみ(現行互換)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: true }, null),
        ['中学生コース']
      );
    });

    it('elementary: 小学生のみのユーザーは小学生コース', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: false, hasElementarySchool: true }, 'elementary'),
        ['小学生コース']
      );
    });

    it('elementary: 両コース持ちはスキップ(空配列)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: true }, 'elementary'),
        []
      );
    });

    it('elementary: 中学生のみはスキップ(空配列)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: false }, 'elementary'),
        []
      );
    });

    it('juniorHigh: 両コース持ちは中学生コース', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: true, hasElementarySchool: true }, 'juniorHigh'),
        ['中学生コース']
      );
    });

    it('juniorHigh: 小学生のみはスキップ(空配列)', () => {
      assert.deepStrictEqual(
        crawler.resolveTargetCourses({ hasJuniorHighSchool: false, hasElementarySchool: true }, 'juniorHigh'),
        []
      );
    });
  });

  describe('isJuniorHighSchool (course 導出の根拠)', () => {
    it('コース名が中学生コースなら true', () => {
      assert.strictEqual(crawler.isJuniorHighSchool('中学生コース', null), true);
    });

    it('コース名が小学生コースなら false', () => {
      assert.strictEqual(crawler.isJuniorHighSchool('小学生コース', null), false);
    });

    it('コース名未指定でも URL が /study/c/ なら true', () => {
      const fakePage = { url: () => 'https://smile-zemi.jp/mimamoru-net/ui/study/c/timeline' };
      assert.strictEqual(crawler.isJuniorHighSchool(null, fakePage), true);
    });

    it('コース名未指定で URL が /study/s/ なら false', () => {
      const fakePage = { url: () => 'https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline' };
      assert.strictEqual(crawler.isJuniorHighSchool(null, fakePage), false);
    });
  });

  describe('shouldProcessSingleCourseUser', () => {
    const juniorUrl = 'https://smile-zemi.jp/mimamoru-net/ui/study/c/timeline';
    const elementaryUrl = 'https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline';

    it('elementary filter: 中学生タイムラインのユーザーは対象外', () => {
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(juniorUrl, 'elementary'), false);
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(elementaryUrl, 'elementary'), true);
    });

    it('juniorHigh filter: 小学生タイムラインのユーザーは対象外', () => {
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(juniorUrl, 'juniorHigh'), true);
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(elementaryUrl, 'juniorHigh'), false);
    });

    it('filterなし: 常に対象', () => {
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(juniorUrl, null), true);
      assert.strictEqual(crawler.shouldProcessSingleCourseUser(elementaryUrl, null), true);
    });
  });
});
