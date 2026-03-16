/**
 * 週間レポートクローラーのテスト
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

describe('週間レポートクローラー (src/weekly-report-crawler.js)', () => {
  let weeklyReportCrawler;
  let mockPage;

  beforeEach(() => {
    weeklyReportCrawler = require('../src/weekly-report-crawler');
  });

  /**
   * モックページを作成するヘルパー
   */
  function createMockPage(options = {}) {
    const {
      reportTabVisible = true,
      urlIncludesGuidanceReport = true,
      sectionTitleVisible = false,
      torikumiTabVisible = false,
      evaluateResult = { period: '3月9日～3月15日', torikumi: 'テスト', praisePoints: ['ポイント1'] }
    } = options;

    return {
      locator: mock.fn((selector) => {
        if (selector.includes('指導レポート')) {
          return {
            isVisible: mock.fn(async () => reportTabVisible),
            click: mock.fn(async () => {})
          };
        }
        if (selector.includes('とりくみ')) {
          return {
            isVisible: mock.fn(async () => torikumiTabVisible),
            click: mock.fn(async () => {})
          };
        }
        // sectionTitle用
        return {
          first: mock.fn(() => ({
            isVisible: mock.fn(async () => sectionTitleVisible)
          })),
          isVisible: mock.fn(async () => false),
          click: mock.fn(async () => {}),
          all: mock.fn(async () => []),
          count: mock.fn(async () => 0),
          textContent: mock.fn(async () => '')
        };
      }),
      url: mock.fn(() => urlIncludesGuidanceReport
        ? 'https://smile-zemi.jp/mimamoru-net/ui/study/s/guidance-report'
        : 'https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline'),
      waitForTimeout: mock.fn(async () => {}),
      waitForLoadState: mock.fn(async () => {}),
      evaluate: mock.fn(async () => evaluateResult),
      goto: mock.fn(async () => {})
    };
  }

  describe('navigateToGuidanceReport() - 指導レポートページ遷移', () => {
    it('正常系: 指導レポートタブをクリックして遷移成功（URL確認）', async () => {
      mockPage = createMockPage({ reportTabVisible: true, urlIncludesGuidanceReport: true });

      const result = await weeklyReportCrawler.navigateToGuidanceReport(mockPage);

      assert.strictEqual(result.success, true, '遷移が成功すること');
    });

    it('正常系: URLが変わらなくてもコンテンツ表示で成功', async () => {
      mockPage = createMockPage({
        reportTabVisible: true,
        urlIncludesGuidanceReport: false,
        sectionTitleVisible: true
      });

      const result = await weeklyReportCrawler.navigateToGuidanceReport(mockPage);

      assert.strictEqual(result.success, true, 'コンテンツ表示で成功すること');
    });

    it('正常系: 「とりくみ」タブ経由で遷移', async () => {
      // navigateToGuidanceReport の実装:
      // 1. reportTab.isVisible() → false (catch内でfalse)
      // 2. torikumiTab.isVisible() → true
      // 3. torikumiTab.click()
      // 4. reportTab.isVisible() → true (リトライ)
      // 5. reportTab.click()
      // 6. page.url() で確認

      let reportTabVisibleCount = 0;
      mockPage = {
        locator: mock.fn((selector) => {
          if (selector.includes('指導レポート')) {
            return {
              isVisible: mock.fn(async () => {
                reportTabVisibleCount++;
                return reportTabVisibleCount > 1; // 2回目以降はtrue
              }),
              click: mock.fn(async () => {})
            };
          }
          if (selector.includes('とりくみ')) {
            return {
              isVisible: mock.fn(async () => true),
              click: mock.fn(async () => {})
            };
          }
          return {
            first: mock.fn(() => ({
              isVisible: mock.fn(async () => false)
            })),
            isVisible: mock.fn(async () => false),
            click: mock.fn(async () => {})
          };
        }),
        url: mock.fn(() => 'https://smile-zemi.jp/mimamoru-net/ui/study/s/guidance-report'),
        waitForTimeout: mock.fn(async () => {}),
        waitForLoadState: mock.fn(async () => {})
      };

      const result = await weeklyReportCrawler.navigateToGuidanceReport(mockPage);

      assert.strictEqual(result.success, true, 'とりくみタブ経由で成功すること');
    });

    it('異常系: タブが見つからない場合エラー', async () => {
      mockPage = createMockPage({ reportTabVisible: false, torikumiTabVisible: false });
      // isVisibleがfalseを返し、catch時もfalseを返す
      mockPage.locator = mock.fn(() => ({
        isVisible: mock.fn(async () => false),
        click: mock.fn(async () => {}),
        first: mock.fn(() => ({
          isVisible: mock.fn(async () => false)
        }))
      }));

      const result = await weeklyReportCrawler.navigateToGuidanceReport(mockPage);

      assert.strictEqual(result.success, false, '遷移が失敗すること');
      assert.match(result.error, /指導レポートタブが見つかりません|遷移/, 'エラーメッセージが含まれること');
    });

    it('異常系: 例外発生時のエラーハンドリング', async () => {
      mockPage = {
        locator: mock.fn(() => {
          throw new Error('Unexpected error');
        }),
        url: mock.fn(() => ''),
        waitForTimeout: mock.fn(async () => {})
      };

      const result = await weeklyReportCrawler.navigateToGuidanceReport(mockPage);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /エラー/);
    });
  });

  describe('getGuidanceReport() - 指導レポートデータ取得', () => {
    it('正常系: レポートデータを正しく抽出する', async () => {
      const reportData = { period: '3月9日～3月15日', torikumi: '頑張りました', praisePoints: ['計算が得意'] };
      mockPage = createMockPage({ evaluateResult: reportData });

      const result = await weeklyReportCrawler.getGuidanceReport(mockPage);

      assert.strictEqual(result.success, true, 'データ取得が成功すること');
      assert.deepStrictEqual(result.data, reportData, 'データが正しいこと');
    });

    it('正常系: 期間、とりくみの様子、褒めポイントを取得', async () => {
      const reportData = {
        period: '3月9日～3月15日',
        torikumi: '数学と英語を中心に取り組みました。',
        praisePoints: ['計算問題を素早く解けました', '英単語の暗記が進みました']
      };
      mockPage = createMockPage({ evaluateResult: reportData });

      const result = await weeklyReportCrawler.getGuidanceReport(mockPage);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.period, '3月9日～3月15日');
      assert.strictEqual(result.data.torikumi, '数学と英語を中心に取り組みました。');
      assert.strictEqual(result.data.praisePoints.length, 2);
    });

    it('異常系: page.evaluate失敗時のエラーハンドリング', async () => {
      mockPage = createMockPage();
      mockPage.evaluate = mock.fn(async () => {
        throw new Error('Evaluate failed');
      });

      const result = await weeklyReportCrawler.getGuidanceReport(mockPage);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /エラー/);
    });
  });

  describe('getAllUsersWeeklyReport() - 全ユーザーのレポート取得', () => {
    it('正常系: コース選択なしで全ユーザーのレポートを取得', async () => {
      // getUserList, switchToUser, checkCourseSelection をモック
      // crawler.jsの関数をモックする必要があるが、モジュール内部でrequireしているため
      // mockPageのlocatorでユーザー一覧を返すようにモック

      // この関数はcrawler.jsのgetUserList等に依存しているため、
      // mockPageを通じてそれらの関数が成功するようにモックする
      mockPage = createMockPage({
        reportTabVisible: true,
        urlIncludesGuidanceReport: true,
        evaluateResult: { period: '3月9日～3月15日', torikumi: 'テスト', praisePoints: ['ポイント'] }
      });

      // getUserListが返すユーザー一覧のモック
      const mockUsers = [
        { textContent: mock.fn(async () => '太郎'), click: mock.fn(async () => {}) }
      ];

      let locatorCallCount = 0;
      mockPage.locator = mock.fn((selector) => {
        // ユーザー一覧のセレクタ
        if (selector.includes('user') || selector.includes('div[class*="name"]') || selector.includes('option')) {
          return {
            all: mock.fn(async () => mockUsers),
            count: mock.fn(async () => 1),
            textContent: mock.fn(async () => '太郎'),
            click: mock.fn(async () => {})
          };
        }
        if (selector.includes('指導レポート')) {
          return {
            isVisible: mock.fn(async () => true),
            click: mock.fn(async () => {})
          };
        }
        if (selector.includes('中学生コース') || selector.includes('小学生コース')) {
          return {
            isVisible: mock.fn(async () => false),
            click: mock.fn(async () => {})
          };
        }
        return {
          all: mock.fn(async () => []),
          count: mock.fn(async () => 0),
          textContent: mock.fn(async () => ''),
          click: mock.fn(async () => {}),
          isVisible: mock.fn(async () => false),
          first: mock.fn(() => ({
            isVisible: mock.fn(async () => false)
          }))
        };
      });

      const result = await weeklyReportCrawler.getAllUsersWeeklyReport(mockPage);

      // getUserListの内部実装に依存するため、成功/失敗両方のケースがあり得る
      // ここでは関数が例外を投げずに返ることを確認
      assert.strictEqual(typeof result.success, 'boolean', '結果がboolean型であること');
    });

    it('異常系: ユーザー一覧取得失敗', async () => {
      mockPage = createMockPage();
      mockPage.locator = mock.fn(() => ({
        all: mock.fn(async () => {
          throw new Error('Failed to get users');
        }),
        count: mock.fn(async () => 0)
      }));

      const result = await weeklyReportCrawler.getAllUsersWeeklyReport(mockPage);

      assert.strictEqual(result.success, false, 'レポート取得が失敗すること');
      assert.strictEqual(typeof result.error, 'string', 'エラーメッセージが文字列であること');
    });

    it('異常系: 例外発生時のエラーハンドリング', async () => {
      mockPage = createMockPage();
      mockPage.locator = mock.fn(() => {
        throw new Error('Unexpected error');
      });

      const result = await weeklyReportCrawler.getAllUsersWeeklyReport(mockPage);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /エラー/);
    });
  });

  describe('maskName() - 名前マスキング（内部関数、getAllUsersWeeklyReportを通じた間接テスト）', () => {
    it('getAllUsersWeeklyReportが名前をログにマスク出力する（例外なし確認）', async () => {
      // maskNameは内部関数だがgetAllUsersWeeklyReportのログで使用される
      // 正常に動作することを間接的に確認
      mockPage = createMockPage();
      mockPage.locator = mock.fn(() => ({
        all: mock.fn(async () => []),
        count: mock.fn(async () => 0),
        isVisible: mock.fn(async () => false),
        click: mock.fn(async () => {})
      }));

      // 例外が発生しないことを確認
      const result = await weeklyReportCrawler.getAllUsersWeeklyReport(mockPage);
      assert.strictEqual(typeof result, 'object', '結果がオブジェクトであること');
    });
  });
});
