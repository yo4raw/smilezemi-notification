/**
 * 週間レポート通知フォーマッターモジュール
 * 指導レポートデータをLINE通知用メッセージにフォーマットする
 */

const { truncateToLimit } = require('./notifier');

/**
 * 週間レポートデータをLINE通知用メッセージにフォーマットする
 *
 * @param {Array<{userName: string, report: {period: string, torikumi: string, praisePoints: string[]}}>} reportData
 * @returns {string} フォーマットされたメッセージ
 */
function formatWeeklyReport(reportData) {
  if (!reportData || reportData.length === 0) {
    return '📋 スマイルゼミ 週間レポート\n\nレポートデータがありません。';
  }

  // 期間は最初のレポートから取得（全ユーザー共通のはず）
  const period = reportData[0].report.period || '';

  const lines = [];
  lines.push('📋 スマイルゼミ 週間レポート');
  if (period) {
    lines.push(`📅 ${period}`);
  }

  for (const entry of reportData) {
    lines.push('');
    lines.push('───────────────');
    lines.push(`👤 ${entry.userName}`);

    const report = entry.report;

    // とりくみの様子
    if (report.torikumi) {
      lines.push('');
      lines.push('📝 とりくみの様子');
      lines.push(report.torikumi);
    }

    // 頑張ったところ（元データは「褒めポイント」）
    if (report.praisePoints && report.praisePoints.length > 0) {
      lines.push('');
      lines.push('💪 頑張ったところ');
      for (const point of report.praisePoints) {
        lines.push(`・${point}`);
      }
    }
  }

  let message = lines.join('\n');
  message = truncateToLimit(message);
  return message;
}

module.exports = {
  formatWeeklyReport
};
