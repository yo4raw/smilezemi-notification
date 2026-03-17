package notifier

import (
	"fmt"
	"strings"
)

// WeeklyReport は週間レポートのデータを表す。
type WeeklyReport struct {
	Period       string   `json:"period"`
	Torikumi     string   `json:"torikumi"`
	PraisePoints []string `json:"praisePoints"`
}

// WeeklyReportEntry はユーザーごとの週間レポートを表す。
type WeeklyReportEntry struct {
	UserName string       `json:"userName"`
	Report   WeeklyReport `json:"report"`
}

// FormatWeeklyReport は週間レポートデータをLINE通知用メッセージにフォーマットする。
func FormatWeeklyReport(reportData []WeeklyReportEntry) string {
	if len(reportData) == 0 {
		return "📋 スマイルゼミ 週間レポート\n\nレポートデータがありません。"
	}

	period := reportData[0].Report.Period

	var lines []string
	lines = append(lines, "📋 スマイルゼミ 週間レポート")
	if period != "" {
		lines = append(lines, fmt.Sprintf("📅 %s", period))
	}

	for _, entry := range reportData {
		lines = append(lines, "")
		lines = append(lines, "───────────────")
		lines = append(lines, fmt.Sprintf("👤 %s", entry.UserName))

		report := entry.Report

		if report.Torikumi != "" {
			lines = append(lines, "")
			lines = append(lines, "📝 とりくみの様子")
			lines = append(lines, report.Torikumi)
		}

		if len(report.PraisePoints) > 0 {
			lines = append(lines, "")
			lines = append(lines, "💪 頑張ったところ")
			for _, point := range report.PraisePoints {
				lines = append(lines, fmt.Sprintf("・%s", point))
			}
		}
	}

	message := strings.Join(lines, "\n")
	message = TruncateToLimit(message)
	return message
}
