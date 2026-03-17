package notifier

import (
	"strings"
	"testing"
)

func TestFormatWeeklyReport_Empty(t *testing.T) {
	msg := FormatWeeklyReport(nil)
	if !strings.Contains(msg, "レポートデータがありません") {
		t.Error("should indicate no data")
	}

	msg = FormatWeeklyReport([]WeeklyReportEntry{})
	if !strings.Contains(msg, "レポートデータがありません") {
		t.Error("should indicate no data for empty slice")
	}
}

func TestFormatWeeklyReport_SingleUser(t *testing.T) {
	reports := []WeeklyReportEntry{
		{
			UserName: "太郎",
			Report: WeeklyReport{
				Period:       "2025/12/18 〜 2025/12/24",
				Torikumi:     "毎日コツコツ学習を続けています。",
				PraisePoints: []string{"算数の計算が早くなりました", "漢字テストで満点を取りました"},
			},
		},
	}

	msg := FormatWeeklyReport(reports)

	if !strings.Contains(msg, "週間レポート") {
		t.Error("should contain header")
	}
	if !strings.Contains(msg, "2025/12/18 〜 2025/12/24") {
		t.Error("should contain period")
	}
	if !strings.Contains(msg, "太郎") {
		t.Error("should contain user name")
	}
	if !strings.Contains(msg, "とりくみの様子") {
		t.Error("should contain torikumi section")
	}
	if !strings.Contains(msg, "毎日コツコツ") {
		t.Error("should contain torikumi content")
	}
	if !strings.Contains(msg, "頑張ったところ") {
		t.Error("should contain praise section")
	}
	if !strings.Contains(msg, "算数の計算が早くなりました") {
		t.Error("should contain praise points")
	}
}

func TestFormatWeeklyReport_MultipleUsers(t *testing.T) {
	reports := []WeeklyReportEntry{
		{
			UserName: "太郎",
			Report: WeeklyReport{
				Period:       "2025/12/18 〜 2025/12/24",
				Torikumi:     "頑張っています。",
				PraisePoints: []string{"よくできました"},
			},
		},
		{
			UserName: "花子",
			Report: WeeklyReport{
				Period:       "2025/12/18 〜 2025/12/24",
				Torikumi:     "積極的に取り組んでいます。",
				PraisePoints: []string{"理科の実験が上手でした"},
			},
		},
	}

	msg := FormatWeeklyReport(reports)
	if !strings.Contains(msg, "太郎") || !strings.Contains(msg, "花子") {
		t.Error("should contain both user names")
	}
	if !strings.Contains(msg, "───") {
		t.Error("should contain separator")
	}
}

func TestFormatWeeklyReport_NoPraisePoints(t *testing.T) {
	reports := []WeeklyReportEntry{
		{
			UserName: "太郎",
			Report: WeeklyReport{
				Period:       "2025/12/18 〜 2025/12/24",
				Torikumi:     "学習中です。",
				PraisePoints: []string{},
			},
		},
	}

	msg := FormatWeeklyReport(reports)
	if strings.Contains(msg, "頑張ったところ") {
		t.Error("should not contain praise section when no praise points")
	}
}

func TestFormatWeeklyReport_NoPeriod(t *testing.T) {
	reports := []WeeklyReportEntry{
		{
			UserName: "太郎",
			Report: WeeklyReport{
				Period:       "",
				Torikumi:     "学習中です。",
				PraisePoints: []string{},
			},
		},
	}

	msg := FormatWeeklyReport(reports)
	if strings.Contains(msg, "📅") {
		t.Error("should not contain period line when period is empty")
	}
}
