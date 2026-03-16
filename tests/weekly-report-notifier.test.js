/**
 * 週間レポート通知フォーマッターのテスト
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('週間レポート通知フォーマッター (src/weekly-report-notifier.js)', () => {
  let weeklyReportNotifier;

  // モジュールは1回だけ読み込む（副作用なし）
  weeklyReportNotifier = require('../src/weekly-report-notifier');

  const sampleReportData = [
    {
      userName: '太郎（中学生コース）',
      report: {
        period: '3月9日～3月15日',
        torikumi: '今週は数学と英語を中心に取り組みました。',
        praisePoints: ['計算問題を素早く解けました', '英単語の暗記が進みました']
      }
    }
  ];

  const multiUserReportData = [
    {
      userName: '太郎（中学生コース）',
      report: {
        period: '3月9日～3月15日',
        torikumi: '数学と英語を頑張りました。',
        praisePoints: ['計算問題を素早く解けました']
      }
    },
    {
      userName: '花子（小学生コース）',
      report: {
        period: '3月9日～3月15日',
        torikumi: '国語と算数に取り組みました。',
        praisePoints: ['漢字の書き取りが上手になりました', '文章題を粘り強く解きました']
      }
    }
  ];

  describe('formatWeeklyReport() - レポートフォーマット', () => {
    it('正常系: レポートデータを正しくフォーマットする', () => {
      const message = weeklyReportNotifier.formatWeeklyReport(sampleReportData);

      assert.strictEqual(typeof message, 'string', 'メッセージが文字列であること');
      assert.match(message, /週間レポート/, 'ヘッダーが含まれること');
      assert.match(message, /太郎/, 'ユーザー名が含まれること');
    });

    it('正常系: 期間（period）をヘッダーに表示する', () => {
      const message = weeklyReportNotifier.formatWeeklyReport(sampleReportData);

      assert.match(message, /3月9日～3月15日/, '期間が表示されること');
    });

    it('正常系: とりくみの様子を含む', () => {
      const message = weeklyReportNotifier.formatWeeklyReport(sampleReportData);

      assert.match(message, /とりくみの様子/, 'セクションタイトルが含まれること');
      assert.match(message, /数学と英語/, 'とりくみの内容が含まれること');
    });

    it('正常系: 頑張ったところ（praisePoints）を箇条書きで表示する', () => {
      const message = weeklyReportNotifier.formatWeeklyReport(sampleReportData);

      assert.match(message, /頑張ったところ/, 'セクションタイトルが含まれること');
      assert.match(message, /・計算問題を素早く解けました/, '箇条書き形式であること');
      assert.match(message, /・英単語の暗記が進みました/, '2つ目のポイントが含まれること');
    });

    it('正常系: 複数ユーザーのレポートを結合する', () => {
      const message = weeklyReportNotifier.formatWeeklyReport(multiUserReportData);

      assert.match(message, /太郎/, '1人目のユーザー名が含まれること');
      assert.match(message, /花子/, '2人目のユーザー名が含まれること');
      assert.match(message, /数学と英語/, '1人目の内容が含まれること');
      assert.match(message, /国語と算数/, '2人目の内容が含まれること');
    });

    it('正常系: 5000文字以内に制限される', () => {
      // 大量のデータを作成
      const largeData = [];
      for (let i = 0; i < 50; i++) {
        largeData.push({
          userName: `ユーザー${i}`,
          report: {
            period: '3月9日～3月15日',
            torikumi: 'あ'.repeat(200),
            praisePoints: ['ポイント1'.repeat(20), 'ポイント2'.repeat(20)]
          }
        });
      }

      const message = weeklyReportNotifier.formatWeeklyReport(largeData);

      assert.strictEqual(message.length <= 5000, true, 'メッセージが5000文字以内であること');
    });

    it('境界値: 空配列の場合「レポートデータがありません」メッセージ', () => {
      const message = weeklyReportNotifier.formatWeeklyReport([]);

      assert.match(message, /レポートデータがありません/, '空データのメッセージが返ること');
    });

    it('境界値: null/undefinedの場合のハンドリング', () => {
      const messageNull = weeklyReportNotifier.formatWeeklyReport(null);
      assert.match(messageNull, /レポートデータがありません/, 'nullの場合のメッセージが返ること');

      const messageUndefined = weeklyReportNotifier.formatWeeklyReport(undefined);
      assert.match(messageUndefined, /レポートデータがありません/, 'undefinedの場合のメッセージが返ること');
    });

    it('境界値: とりくみが空の場合、セクションが省略される', () => {
      const data = [{
        userName: '太郎',
        report: {
          period: '3月9日～3月15日',
          torikumi: '',
          praisePoints: ['頑張りました']
        }
      }];

      const message = weeklyReportNotifier.formatWeeklyReport(data);

      assert.strictEqual(typeof message, 'string');
      // とりくみが空の場合、「とりくみの様子」セクションは表示されない
      assert.strictEqual(message.includes('とりくみの様子'), false, 'とりくみセクションが省略されること');
    });

    it('境界値: praisePointsが空配列の場合、セクションが省略される', () => {
      const data = [{
        userName: '太郎',
        report: {
          period: '3月9日～3月15日',
          torikumi: '頑張りました。',
          praisePoints: []
        }
      }];

      const message = weeklyReportNotifier.formatWeeklyReport(data);

      assert.strictEqual(typeof message, 'string');
      assert.strictEqual(message.includes('頑張ったところ'), false, '頑張ったところセクションが省略されること');
    });

    it('境界値: periodが空の場合、期間行が省略される', () => {
      const data = [{
        userName: '太郎',
        report: {
          period: '',
          torikumi: '頑張りました。',
          praisePoints: []
        }
      }];

      const message = weeklyReportNotifier.formatWeeklyReport(data);

      assert.strictEqual(typeof message, 'string');
      assert.match(message, /週間レポート/, 'ヘッダーは表示されること');
    });
  });
});
