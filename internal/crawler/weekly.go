// Package crawler はみまもるネットのデータ取得機能を提供する。
package crawler

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/chromedp/chromedp"

	"github.com/yo4raw/smilezemi-notification/internal/notifier"
)

// NavigateToGuidanceReport は指導レポートページに遷移する。
func NavigateToGuidanceReport(ctx context.Context) error {
	// 「指導レポート」タブを探してクリック
	var tabFound bool
	chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const buttons = document.querySelectorAll('button');
				for (const btn of buttons) {
					if (btn.textContent.includes('%s') && btn.offsetParent !== null) {
						btn.click();
						return true;
					}
				}
				return false;
			})()
		`, escapeJS(ReportTabText)), &tabFound),
	)

	if !tabFound {
		// 「とりくみ」タブをクリックしてサブタブを表示
		var torikumiFound bool
		chromedp.Run(ctx,
			chromedp.Evaluate(`
				(() => {
					const buttons = document.querySelectorAll('button');
					for (const btn of buttons) {
						if (btn.textContent.includes('とりくみ') && btn.offsetParent !== null) {
							btn.click();
							return true;
						}
					}
					return false;
				})()
			`, &torikumiFound),
			chromedp.Sleep(2*time.Second),
		)

		if torikumiFound {
			// リトライ
			chromedp.Run(ctx,
				chromedp.Evaluate(fmt.Sprintf(`
					(() => {
						const buttons = document.querySelectorAll('button');
						for (const btn of buttons) {
							if (btn.textContent.includes('%s') && btn.offsetParent !== null) {
								btn.click();
								return true;
							}
						}
						return false;
					})()
				`, escapeJS(ReportTabText)), &tabFound),
			)
		}

		if !tabFound {
			return fmt.Errorf("指導レポートタブが見つかりません")
		}
	}

	chromedp.Run(ctx, chromedp.Sleep(TabClickWait))

	// URL確認
	var currentURL string
	chromedp.Run(ctx, chromedp.Location(&currentURL))

	if strings.Contains(currentURL, "guidance-report") {
		log.Printf("✅ 指導レポートページに遷移しました")
		return nil
	}

	// コンテンツ確認
	var hasContent bool
	chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const el = document.querySelector('%s');
				return el !== null && el.offsetParent !== null;
			})()
		`, escapeJS(SectionTitleSelector)), &hasContent),
	)

	if hasContent {
		log.Printf("✅ 指導レポートのコンテンツが表示されています")
		return nil
	}

	return fmt.Errorf("指導レポートページへの遷移を確認できません")
}

// GetGuidanceReport は指導レポートページからデータを抽出する。
func GetGuidanceReport(ctx context.Context) (*notifier.WeeklyReport, error) {
	var reportData map[string]interface{}
	err := chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const result = { period: '', torikumi: '', praisePoints: [] };

				// 期間を取得（例: "3月9日～3月15日"）
				const allSpans = document.querySelectorAll('span');
				for (const span of allSpans) {
					const text = span.textContent.trim();
					if (text.includes('～') && text.includes('月') && text.includes('日')) {
						result.period = text;
						break;
					}
				}

				// 「とりくみの様子」
				const torikumiRoot = document.querySelector('.instructionMessageRoot__luz50:has(.result__jjiPN)');
				if (torikumiRoot) {
					const messageDiv = torikumiRoot.querySelector('.message__JrLLL');
					if (messageDiv) {
						const spans = messageDiv.querySelectorAll('span');
						const texts = [];
						for (const span of spans) {
							const t = span.textContent.trim();
							if (t) texts.push(t);
						}
						result.torikumi = texts.join('\n');
					}
				}

				// 「褒めポイント」
				const praiseRoots = document.querySelectorAll('.praiseMessageRoot__lmfJ9');
				for (const root of praiseRoots) {
					const span = root.querySelector('span');
					if (span) {
						const t = span.textContent.trim();
						if (t) result.praisePoints.push(t);
					}
				}

				return result;
			})()
		`, &reportData),
	)

	if err != nil {
		return nil, fmt.Errorf("指導レポートデータ取得エラー: %w", err)
	}

	period, _ := reportData["period"].(string)
	torikumi, _ := reportData["torikumi"].(string)

	var praisePoints []string
	if pp, ok := reportData["praisePoints"].([]interface{}); ok {
		for _, p := range pp {
			if s, ok := p.(string); ok && s != "" {
				praisePoints = append(praisePoints, s)
			}
		}
	}

	log.Printf("  📅 期間: %s", orDefault(period, "取得できませんでした"))
	if torikumi != "" {
		preview := torikumi
		if len([]rune(preview)) > 50 {
			preview = string([]rune(preview)[:50]) + "..."
		}
		log.Printf("  📝 とりくみの様子: %s", preview)
	} else {
		log.Printf("  📝 とりくみの様子: 取得できませんでした")
	}
	log.Printf("  🏅 頑張ったところ: %d件", len(praisePoints))

	return &notifier.WeeklyReport{
		Period:       period,
		Torikumi:     torikumi,
		PraisePoints: praisePoints,
	}, nil
}

// GetAllUsersWeeklyReport は全ユーザーの週間レポートを取得する。
func GetAllUsersWeeklyReport(ctx context.Context) ([]notifier.WeeklyReportEntry, error) {
	users, err := GetUserList(ctx)
	if err != nil {
		return nil, fmt.Errorf("ユーザー一覧取得失敗: %w", err)
	}

	log.Printf("✅ ユーザー一覧取得完了（%d名）", len(users))

	var results []notifier.WeeklyReportEntry

	for _, user := range users {
		log.Printf("\n👤 %s のレポートを取得中...", maskName(user.Name))

		if err := SwitchToUser(ctx, user.Name); err != nil {
			log.Printf("  ❌ ユーザー切り替え失敗: %v", err)
			continue
		}

		courseResult := CheckCourseSelection(ctx)

		if courseResult.HasCourseSelection {
			var courses []string
			if courseResult.HasJuniorHighSchool {
				courses = append(courses, JuniorHighSchoolText)
			}
			if courseResult.HasElementarySchool {
				courses = append(courses, ElementarySchoolText)
			}

			for i, courseName := range courses {
				log.Printf("  📚 %s のレポートを取得中...", courseName)

				if err := SelectCourse(ctx, courseName); err != nil {
					log.Printf("    ❌ コース選択失敗: %v", err)
					continue
				}

				if err := NavigateToGuidanceReport(ctx); err != nil {
					log.Printf("    ❌ 指導レポート遷移失敗: %v", err)
					continue
				}

				report, err := GetGuidanceReport(ctx)
				if err != nil {
					log.Printf("    ❌ レポート取得失敗: %v", err)
					continue
				}

				results = append(results, notifier.WeeklyReportEntry{
					UserName: fmt.Sprintf("%s（%s）", user.Name, courseName),
					Report:   *report,
				})

				if i < len(courses)-1 {
					if err := ReturnToCourseSelection(ctx, user.Name); err != nil {
						log.Printf("    ❌ コース選択画面への復帰失敗: %v", err)
						break
					}
				}
			}

			// タイムラインに戻る
			chromedp.Run(ctx,
				chromedp.Navigate(TimelineURL),
				chromedp.Sleep(2*time.Second),
			)

		} else {
			if err := NavigateToGuidanceReport(ctx); err != nil {
				log.Printf("  ❌ 指導レポート遷移失敗: %v", err)
				continue
			}

			report, err := GetGuidanceReport(ctx)
			if err != nil {
				log.Printf("  ❌ レポート取得失敗: %v", err)
				continue
			}

			results = append(results, notifier.WeeklyReportEntry{
				UserName: user.Name,
				Report:   *report,
			})

			// タイムラインに戻る
			chromedp.Run(ctx,
				chromedp.Navigate(TimelineURL),
				chromedp.Sleep(2*time.Second),
			)
		}
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("全ユーザーのレポート取得に失敗しました")
	}

	return results, nil
}

// orDefault はsが空の場合にデフォルト値を返す。
func orDefault(s, defaultVal string) string {
	if s == "" {
		return defaultVal
	}
	return s
}
