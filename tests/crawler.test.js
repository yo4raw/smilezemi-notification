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
   * extractElementaryDay の page.evaluate コールバックが使うDOM APIだけを持つ最小のfake要素
   * 使うのは querySelectorAll / querySelector / children / textContent の4つのみ
   */
  function createFakeElement({ classes = [], text = '', children = [] } = {}) {
    const el = {
      classes,
      textContent: text,
      children,
      // 自分自身を含まない子孫の平坦なリスト
      descendants() {
        return children.flatMap(child => [child, ...child.descendants()]);
      },
      querySelector(selector) {
        return el.querySelectorAll(selector)[0] ?? null;
      },
      querySelectorAll(selector) {
        // 子孫セレクタ(スペース区切り、例: '[class*="totalStudyTime__"] [class*="minute__"]')を
        // 左から順に絞り込むことで模す。実装側のセレクタ文字列はそのまま通す。
        const needles = selector
          .trim()
          .split(/\s+/)
          .map(part => part.match(/\[class\*="(.+?)"\]/)?.[1] ?? part);

        let candidates = [el];
        for (const needle of needles) {
          const matched = [];
          for (const ctx of candidates) {
            for (const node of ctx.descendants()) {
              if (node.classes.some(cls => cls.includes(needle))) {
                matched.push(node);
              }
            }
          }
          candidates = matched;
        }
        return candidates;
      }
    };
    return el;
  }

  /**
   * extractElementaryDay 用の fake document を組み立てる。
   *
   * @param {Array<{dateText: string, minuteText?: string, rows?: Array<object>}>} dayBlocks
   *   rows の各要素は { type: 'accordion' }(スターアプリ行、除外対象) か
   *   { name, isMission, score?, correctAnswers?, questionCount? }(学習行)
   */
  function buildElementaryDocument(dayBlocks) {
    const dayBlockEls = dayBlocks.map(({ dateText, minuteText = '', rows = [] }) => {
      const dateEl = createFakeElement({ classes: ['date__hash1'], text: dateText });
      const minuteEl = createFakeElement({ classes: ['minute__hash2'], text: minuteText });
      const totalStudyTimeEl = createFakeElement({ classes: ['totalStudyTime__hash3'], children: [minuteEl] });

      const rowEls = rows.map((row) => {
        if (row.type === 'accordion') {
          // スターアプリ行: accordionRoot__ を持つ子要素を含むだけの行
          return createFakeElement({
            classes: ['rowItem__hash4'],
            children: [createFakeElement({ classes: ['accordionRoot__hash5'] })]
          });
        }

        const children = [createFakeElement({ classes: ['title__hash6'], text: row.name ?? '' })];

        if (row.isMission) {
          children.push(createFakeElement({ classes: ['missionIcon__hash7'] }));
        }
        if (row.score !== undefined) {
          children.push(createFakeElement({ classes: ['scoreNumber__hash8'], text: String(row.score) }));
        }
        if (row.correctAnswers !== undefined) {
          children.push(createFakeElement({ classes: ['correctAnswerCount__hash9'], text: String(row.correctAnswers) }));
        }
        if (row.questionCount !== undefined) {
          children.push(createFakeElement({ classes: ['questionCount__hash10'], text: `/${row.questionCount}` }));
        }

        return createFakeElement({ classes: ['rowItem__hash11'], children });
      });

      const courseListEl = createFakeElement({ classes: ['courseList__hash12'], children: rowEls });

      return createFakeElement({
        classes: ['dailyTimeline__hash13'],
        children: [dateEl, totalStudyTimeEl, courseListEl]
      });
    });

    const root = createFakeElement({ classes: ['root'], children: dayBlockEls });
    return { querySelectorAll: (selector) => root.querySelectorAll(selector) };
  }

  // extractElementaryDay のデフォルトfake document。日ブロックを1件だけ持つが、
  // 現実にありえない日付("13/40")にしてあるため、courseName未指定/小学生コースの
  // 既存テストで「対象日は見つからないが日ブロック自体は存在する」(dayBlockCount>0の
  // 正当な0件)という現行互換の挙動を保つ。個別に検証したいテストは
  // config.elementaryDocument で差し替える。
  const defaultElementaryDocument = buildElementaryDocument([{ dateText: '13/40(月)', minuteText: '0分', rows: [] }]);

  /**
   * Playwright Pageオブジェクトのモック
   *
   * @param {object} config
   * @param {string[]} config.userNames - ユーザー名一覧（「さん」付き）
   * @param {boolean} config.showChildrenHeader - 「お子さま」セクション表示フラグ
   * @param {Error|null} config.throwOnFirstLocator - 最初のlocatorでスローするエラー
   * @param {number} config.vpWidth - ビューポート幅
   * @param {number} config.vpHeight - ビューポート高さ
   * @param {object} [config.elementaryDocument] - extractElementaryDay 用 fake document
   *   （buildElementaryDocument の戻り値。省略時は defaultElementaryDocument）
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
      // page.evaluate(fn, arg) を実際に fn(arg) 実行する形でモックする。
      // fn(extractElementaryDayのコールバック)はブラウザのグローバル document を参照するため、
      // 呼び出し中だけ global.document を fake document に差し替えて元に戻す。
      evaluate: mock.fn(async (fn, arg) => {
        const previousDocument = global.document;
        global.document = config.elementaryDocument ?? defaultElementaryDocument;
        try {
          return await fn(arg);
        } finally {
          if (previousDocument === undefined) {
            delete global.document;
          } else {
            global.document = previousDocument;
          }
        }
      }),
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

    it('11件以上の行でも全件から studyItemCount/missionCount/totalScore を計算する(10件上限撤廃の回帰防止)', () => {
      const rows = Array.from({ length: 13 }, (_, i) => ({
        name: `講座${i + 1}`,
        isMission: i % 2 === 0,
        score: 10 + i
      }));

      const result = crawler.summarizeStudyRows(rows);

      const expectedMissionCount = rows.filter(row => row.isMission).length;
      const expectedTotalScore = rows.reduce((sum, row) => sum + row.score, 0);

      assert.strictEqual(result.studyItemCount, 13, '13件全てが件数に反映されること(rows.slice(0, 10)の復活を検知)');
      assert.strictEqual(result.missions.length, 13, 'missions配列が10件で打ち切られないこと');
      assert.strictEqual(result.missionCount, expectedMissionCount, '11件目以降のミッション行も数えられること');
      assert.strictEqual(result.totalScore, expectedTotalScore, '11件目以降のscoreも合計点に含まれること(過少計上の回帰防止)');
    });
  });

  // ─── 小学生タイムライン抽出テスト ───

  describe('小学生コースのタイムライン抽出', () => {
    // getTargetDates(0) が withPadding: '07/10', withoutPadding: '7/10',
    // dateString: '2026-07-10' を返す基準時刻(既存のgetTargetDatesテストと同じ)。
    // 日付マッチングを含む実際のDOM抽出ロジックを通すため、実時刻に依存しないよう固定する。
    const FIXED_NOW = new Date('2026-07-09T22:00:00Z').getTime();

    function withFixedNow(fn) {
      return async () => {
        mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
        try {
          await fn();
        } finally {
          mock.timers.reset();
        }
      };
    }

    const missionAndIndependentRows = [
      { name: 'こそあど言葉', isMission: true, score: 93 },
      { name: '小数のひき算', isMission: true, score: 80 },
      { name: '小数のたし算', isMission: true, score: 80 },
      { name: '8級 同じ漢字の読み', isMission: true, score: 90 },
      { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
    ];

    it('getTodayMissionCount() は自主学習を含めた学習件数を返す', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '15分', rows: missionAndIndependentRows }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getTodayMissionCount(page, '小学生コース', 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.count, 5);
      assert.strictEqual(result.missionCount, 4);
    }));

    it('getMissionDetails() は自主学習の行も isMission: false で返す', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '15分', rows: missionAndIndependentRows }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getMissionDetails(page, '小学生コース', 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.missions.length, 5);
      assert.strictEqual(result.missions[4].isMission, false);
      assert.strictEqual(result.missions[4].correctAnswers, 9);
      assert.strictEqual(result.missions[4].questionCount, 10);
    }));

    it('getMissionDetails() は questionCount の "/10" 表記から数値10を取り出す', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '15分', rows: [
          { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
        ] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getMissionDetails(page, '小学生コース', 0);

      assert.strictEqual(result.missions[0].questionCount, 10);
    }));

    it('getMissionDetails() は講座名の前後の空白をtrimする', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '15分', rows: [
          { name: '  こそあど言葉  ', isMission: true, score: 93 }
        ] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getMissionDetails(page, '小学生コース', 0);

      assert.strictEqual(result.missions[0].name, 'こそあど言葉');
    }));

    it('getStudyTime() は左カラムの分数をパースする', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '15分', rows: missionAndIndependentRows }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getStudyTime(page, '小学生コース', 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hours, 0);
      assert.strictEqual(result.minutes, 15);
    }));

    it('日付マッチはゼロパディングあり("07/10")で一致する', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '15分', rows: [{ name: 'こそあど言葉', isMission: true, score: 93 }] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getTodayMissionCount(page, '小学生コース', 0);

      assert.strictEqual(result.count, 1, 'ゼロパディングありの日付表記でマッチすること');
    }));

    it('日付マッチはゼロパディングなし("7/10")でも一致する', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '7/10(金)', minuteText: '15分', rows: [{ name: 'こそあど言葉', isMission: true, score: 93 }] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getTodayMissionCount(page, '小学生コース', 0);

      assert.strictEqual(result.count, 1, 'ゼロパディングなしの日付表記でもマッチすること');
    }));

    it('日ブロックはあるが対象日が見つからない場合は0件・0分を success で返す(正当な0)', withFixedNow(async () => {
      // 対象日(07/10)ではない日ブロックのみを用意する。dayBlockCount > 0 のため
      // 「タイムライン未描画」ではなく「対象日の学習なし」として success:true を返す。
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/09(木)', minuteText: '10分', rows: [{ name: '前日の学習', isMission: true, score: 50 }] },
        { dateText: '07/08(水)', minuteText: '5分', rows: [] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const count = await crawler.getTodayMissionCount(page, '小学生コース', 0);
      const details = await crawler.getMissionDetails(page, '小学生コース', 0);
      const time = await crawler.getStudyTime(page, '小学生コース', 0);

      assert.strictEqual(count.success, true);
      assert.strictEqual(count.count, 0);
      assert.strictEqual(details.success, true);
      assert.deepStrictEqual(details.missions, []);
      assert.strictEqual(time.success, true);
      assert.strictEqual(time.minutes, 0);
    }));

    it('日ブロックが1件も見つからない場合は success:false を返す(タイムライン未描画と区別)', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const count = await crawler.getTodayMissionCount(page, '小学生コース', 0);
      const time = await crawler.getStudyTime(page, '小学生コース', 0);
      const details = await crawler.getMissionDetails(page, '小学生コース', 0);

      assert.strictEqual(count.success, false);
      assert.strictEqual(count.error, '学習件数取得エラー: タイムラインの日ブロックが1件も見つかりません');
      assert.strictEqual(count.count, 0);

      assert.strictEqual(time.success, false);
      assert.strictEqual(time.error, '勉強時間取得エラー: タイムラインの日ブロックが1件も見つかりません');
      assert.strictEqual(time.hours, 0);
      assert.strictEqual(time.minutes, 0);

      assert.strictEqual(details.success, false);
      assert.strictEqual(details.error, '学習詳細取得エラー: タイムラインの日ブロックが1件も見つかりません');
      assert.deepStrictEqual(details.missions, []);
    }));

    it('スターアプリ(アコーディオン)行は rows から除外され件数に入らない', withFixedNow(async () => {
      // ミッション1件 + スターアプリ(アコーディオン)行1件を含む日ブロックを組み立て、
      // extractElementaryDay 自身がアコーディオン行を読み飛ばすことを検証する
      // (モックが結果を差し替えているのではなく、実際の抽出ロジックを通す)
      const elementaryDocument = buildElementaryDocument([
        {
          dateText: '07/10(金)',
          minuteText: '15分',
          rows: [
            { name: 'こそあど言葉', isMission: true, score: 93 },
            { type: 'accordion' }
          ]
        }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getTodayMissionCount(page, '小学生コース', 0);

      assert.strictEqual(result.count, 1, 'アコーディオン行を除いた件数になること');
    }));

    it('ミッションバッジの有無で isMission が正しく分かれる', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        {
          dateText: '07/10(金)',
          minuteText: '15分',
          rows: [
            { name: 'ミッション講座', isMission: true, score: 93 },
            { name: '自主学習講座', isMission: false, correctAnswers: 3, questionCount: 5 }
          ]
        }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });

      const result = await crawler.getMissionDetails(page, '小学生コース', 0);

      assert.strictEqual(result.missions[0].isMission, true);
      assert.strictEqual(result.missions[1].isMission, false);
    }));
  });

  // ─── getCourseData テスト ───
  //
  // studyItemCount/missionCount/dataReliable が合流する唯一の場所。
  // page.evaluate の呼び出し回数を数えて特定回だけ失敗させることで、
  // getStudyTime/getTodayMissionCount/getMissionDetails のうちどれか1つだけが
  // 失敗した状況を実際のコード経路(extractElementaryDay)を通して再現する。
  // getCourseData内の呼び出し順は 1:getStudyTime 2:getTodayMissionCount 3:getMissionDetails。
  describe('getCourseData() - コースデータ取得(集計の合流点)', () => {
    const FIXED_NOW = new Date('2026-07-09T22:00:00Z').getTime();

    // ミッション4件+自主学習1件(小学生コースのタイムライン抽出 describe内の定義と同内容)
    const missionAndIndependentRows = [
      { name: 'こそあど言葉', isMission: true, score: 93 },
      { name: '小数のひき算', isMission: true, score: 80 },
      { name: '小数のたし算', isMission: true, score: 80 },
      { name: '8級 同じ漢字の読み', isMission: true, score: 90 },
      { name: '漢字のミニテスト', isMission: false, correctAnswers: 9, questionCount: 10 }
    ];

    function withFixedNow(fn) {
      return async () => {
        mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
        try {
          await fn();
        } finally {
          mock.timers.reset();
        }
      };
    }

    // page.evaluate の呼び出し回数をカウントし、targetCallNumber 回目だけ例外を投げるように差し替える
    function makeEvaluateFailOnCall(page, targetCallNumber) {
      const originalEvaluate = page.evaluate;
      let callCount = 0;
      page.evaluate = async (fn, arg) => {
        callCount += 1;
        if (callCount === targetCallNumber) {
          throw new Error('DOM評価エラー(テスト用)');
        }
        return originalEvaluate(fn, arg);
      };
    }

    it('正常系: studyItemCount と missionCount が別々の正しい値で入り dataReliable:true になる', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '15分', rows: missionAndIndependentRows }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });
      const dateString = crawler.getTargetDates(0).dateString;

      const result = await crawler.getCourseData(page, '太郎さん', '小学生コース', dateString, 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.studyItemCount, 5, '学習件数(ミッション+自主)が5件であること');
      assert.strictEqual(result.data.missionCount, 4, 'ミッション数は内訳として4件のままであること');
      assert.strictEqual(result.data.dataReliable, true);
    }));

    it('missionCountResult.missionCount が返らない場合(中学生コースの catch 経路)は studyItemCount にフォールバックする', withFixedNow(async () => {
      const page = createMockPage({
        userNames: ['太郎さん'],
        pageUrl: 'https://smile-zemi.jp/mimamoru-net/ui/study/c/timeline'
      });
      // 中学生コースのタイムライン取得(page.locator('.dailyRoot__a754V'))を例外にし、
      // getTodayMissionCountForJuniorHigh 等の catch 経路(missionCountフィールドを持たないエラー戻り値)を通す
      const originalLocator = page.locator;
      page.locator = (selector) => {
        if (selector === '.dailyRoot__a754V') {
          throw new Error('中学生タイムライン取得エラー(テスト用)');
        }
        return originalLocator(selector);
      };
      const dateString = crawler.getTargetDates(0).dateString;

      const result = await crawler.getCourseData(page, '太郎さん', '中学生コース', dateString, 0);

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.data.missionCount,
        result.data.studyItemCount,
        'missionCountResult.missionCount 不在時は studyItemCount にフォールバックしmissionCountと一致すること'
      );
    }));

    it('getTodayMissionCount が success:false のとき dataReliable:false になる', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '10分', rows: [{ name: 'こそあど言葉', isMission: true, score: 90 }] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });
      // getCourseData内2番目の呼び出し(getTodayMissionCount)のみ失敗させる。
      // getStudyTime/getMissionDetailsは成功させることで、dataReliableの式から
      // 「missionCountResult.success &&」だけを取り除く改変を殺す。
      makeEvaluateFailOnCall(page, 2);
      const dateString = crawler.getTargetDates(0).dateString;

      const result = await crawler.getCourseData(page, '太郎さん', '小学生コース', dateString, 0);

      assert.strictEqual(result.success, true, 'getCourseData自体はグレースフルデグラデーションで成功を返すこと');
      assert.strictEqual(result.data.dataReliable, false, 'ミッション数取得失敗がdataReliableに伝搬すること');
    }));

    it('getStudyTime が success:false のとき dataReliable:false になる', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '10分', rows: [{ name: 'こそあど言葉', isMission: true, score: 90 }] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });
      // 1番目の呼び出し(getStudyTime)のみ失敗させる
      makeEvaluateFailOnCall(page, 1);
      const dateString = crawler.getTargetDates(0).dateString;

      const result = await crawler.getCourseData(page, '太郎さん', '小学生コース', dateString, 0);

      assert.strictEqual(result.data.dataReliable, false, '勉強時間取得失敗がdataReliableに伝搬すること');
    }));

    it('getMissionDetails が success:false のとき dataReliable:false かつ detailsAvailable:false になる', withFixedNow(async () => {
      const elementaryDocument = buildElementaryDocument([
        { dateText: '07/10(金)', minuteText: '10分', rows: [{ name: 'こそあど言葉', isMission: true, score: 90 }] }
      ]);
      const page = createMockPage({ userNames: ['太郎さん'], elementaryDocument });
      // 3番目の呼び出し(getMissionDetails)のみ失敗させる
      makeEvaluateFailOnCall(page, 3);
      const dateString = crawler.getTargetDates(0).dateString;

      const result = await crawler.getCourseData(page, '太郎さん', '小学生コース', dateString, 0);

      assert.strictEqual(result.data.dataReliable, false, 'ミッション詳細取得失敗がdataReliableに伝搬すること');
      assert.strictEqual(result.detailsAvailable, false, 'ミッション詳細取得失敗がdetailsAvailableに伝搬すること');
    }));
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
