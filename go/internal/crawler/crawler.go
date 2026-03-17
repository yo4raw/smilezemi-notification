package crawler

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/chromedp/chromedp"

	"github.com/yaoko/smilezemi-notification/internal/data"
)

// User はサイドバーから取得したユーザー情報。
type User struct {
	Name  string
	Index int
}

// maskName はユーザー名をログ用にマスクする。
func maskName(name string) string {
	runes := []rune(name)
	if len(runes) <= 1 {
		return name
	}
	masked := strings.Repeat("*", len(runes)-1) + string(runes[len(runes)-1:])
	return masked
}

// GetUserList はログイン後のページからユーザー一覧を取得する。
func GetUserList(ctx context.Context) ([]User, error) {
	// 右上のユーザー名エリアをクリックしてサイドバーを開く
	if err := chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const divs = document.querySelectorAll('div');
				for (const div of divs) {
					if (div.textContent.includes('さん') && div.textContent.trim().length < 20) {
						div.click();
						return true;
					}
				}
				return false;
			})()
		`, nil),
		chromedp.Sleep(2*time.Second),
	); err != nil {
		return nil, fmt.Errorf("ユーザーエリアクリックエラー: %w", err)
	}

	// 「お子さま」セクションの確認
	var childSectionVisible bool
	if err := chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const els = document.querySelectorAll('*');
				for (const el of els) {
					if (el.textContent.trim() === 'お子さま' && el.offsetParent !== null) {
						return true;
					}
				}
				return false;
			})()
		`, &childSectionVisible),
	); err != nil {
		return nil, fmt.Errorf("お子さまセクション確認エラー: %w", err)
	}

	if !childSectionVisible {
		return nil, fmt.Errorf("「お子さま」セクションが見つかりません。画面構造が変更された可能性があります。")
	}

	// ユーザー名を取得（「さん」で終わる要素）
	var userNames []string
	if err := chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const results = [];
				const elements = document.querySelectorAll('*');
				for (const el of elements) {
					const text = el.textContent.trim();
					if (text.endsWith('さん') &&
						text.length < 20 &&
						text !== 'お子さま' &&
						!text.includes('おとう') &&
						!text.includes('おかあ') &&
						!text.includes('コース') &&
						el.children.length === 0) {
						results.push(text);
					}
				}
				return [...new Set(results)];
			})()
		`, &userNames),
	); err != nil {
		return nil, fmt.Errorf("ユーザー名取得エラー: %w", err)
	}

	// ESCキーでサイドバーを閉じる
	chromedp.Run(ctx,
		chromedp.KeyEvent("\x1b"), // Escape
		chromedp.Sleep(1*time.Second),
	)

	if len(userNames) == 0 {
		return nil, fmt.Errorf("ユーザーが見つかりません。")
	}

	users := make([]User, len(userNames))
	for i, name := range userNames {
		users[i] = User{Name: name, Index: i}
	}

	return users, nil
}

// SwitchToUser は指定ユーザーに切り替える。
func SwitchToUser(ctx context.Context, userName string) error {
	log.Printf("  ユーザーを %s に切り替え中...", maskName(userName))

	// 現在のユーザー名を確認
	currentUser, _ := getCurrentUserName(ctx)
	if currentUser == userName {
		log.Printf("  ✅ 既に %s です（切り替え不要）", maskName(userName))
		return nil
	}

	// 方法1: MENUボタンからユーザー切り替え
	var menuFound bool
	chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const els = document.querySelectorAll('*');
				for (const el of els) {
					if (el.textContent.trim() === 'MENU' && el.offsetParent !== null) {
						el.click();
						return true;
					}
				}
				return false;
			})()
		`, &menuFound),
	)

	if menuFound {
		chromedp.Run(ctx, chromedp.Sleep(2*time.Second))

		var userClicked bool
		chromedp.Run(ctx,
			chromedp.Evaluate(fmt.Sprintf(`
				(() => {
					const els = document.querySelectorAll('*');
					for (const el of els) {
						if (el.textContent.trim() === '%s' && el.offsetParent !== null && el.children.length === 0) {
							el.click();
							return true;
						}
					}
					return false;
				})()
			`, escapeJS(userName)), &userClicked),
		)

		if userClicked {
			chromedp.Run(ctx, chromedp.Sleep(3*time.Second))

			afterUser, err := getCurrentUserName(ctx)
			if err == nil && afterUser == userName {
				log.Printf("  ✅ ユーザー切り替え成功: %s", maskName(userName))
				return nil
			}
		}

		// メニューを閉じる
		chromedp.Run(ctx, chromedp.KeyEvent("\x1b"), chromedp.Sleep(1*time.Second))
	}

	// 方法2: 右上ユーザーエリアからサイドバーを開く
	var areaClicked bool
	chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const divs = document.querySelectorAll('div');
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				for (const div of divs) {
					const rect = div.getBoundingClientRect();
					const text = div.textContent.trim();
					if (text.endsWith('さん') &&
						text.length < 20 &&
						rect.x >= vw * 0.5 &&
						rect.y <= vh * 0.2 &&
						div.offsetParent !== null) {
						div.click();
						return true;
					}
				}
				return false;
			})()
		`, &areaClicked),
	)

	if !areaClicked {
		return fmt.Errorf("右上のユーザーエリアが見つかりません")
	}

	chromedp.Run(ctx, chromedp.Sleep(3*time.Second))

	// サイドバー内でユーザーをクリック
	var sidebarUserClicked bool
	chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				const els = document.querySelectorAll('*');
				for (const el of els) {
					const text = el.textContent.trim();
					if (text === '%s' && el.offsetParent !== null && el.children.length === 0) {
						const rect = el.getBoundingClientRect();
						// 右上エリア以外の要素を選択
						if (!(rect.x >= vw * 0.5 && rect.y <= vh * 0.2)) {
							el.click();
							return true;
						}
					}
				}
				return false;
			})()
		`, escapeJS(userName)), &sidebarUserClicked),
	)

	if !sidebarUserClicked {
		return fmt.Errorf("サイドバー内にユーザー \"%s\" が見つかりません", maskName(userName))
	}

	chromedp.Run(ctx,
		chromedp.Sleep(3*time.Second),
		chromedp.KeyEvent("\x1b"),
		chromedp.Sleep(1*time.Second),
	)

	// 切り替え検証
	afterUser, err := getCurrentUserName(ctx)
	if err != nil {
		return fmt.Errorf("ユーザー切り替え検証エラー: %w", err)
	}
	if afterUser != userName {
		return fmt.Errorf("ユーザー切り替え検証失敗: 期待=%s, 実際=%s", maskName(userName), maskName(afterUser))
	}

	log.Printf("  ✅ ユーザー切り替え成功: %s", maskName(userName))
	return nil
}

// getCurrentUserName は右上に表示されている現在のユーザー名を取得する。
func getCurrentUserName(ctx context.Context) (string, error) {
	var userName string
	err := chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				const divs = document.querySelectorAll('div');
				for (const div of divs) {
					const rect = div.getBoundingClientRect();
					const text = div.textContent.trim();
					if (text.endsWith('さん') &&
						text.length > 0 &&
						text.length < 20 &&
						rect.x >= vw * 0.5 &&
						rect.y <= vh * 0.2 &&
						div.offsetParent !== null &&
						div.children.length === 0) {
						return text;
					}
				}
				return '';
			})()
		`, &userName),
	)
	if err != nil {
		return "", fmt.Errorf("現在のユーザー名取得エラー: %w", err)
	}
	if userName == "" {
		return "", fmt.Errorf("右上のユーザー名が見つかりません")
	}
	return userName, nil
}

// CheckCourseSelection はコース選択画面が表示されているかチェックする。
type CourseSelectionResult struct {
	HasCourseSelection  bool
	HasJuniorHighSchool bool
	HasElementarySchool bool
}

func CheckCourseSelection(ctx context.Context) CourseSelectionResult {
	var result CourseSelectionResult

	chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const els = document.querySelectorAll('*');
				let junior = false, elementary = false;
				for (const el of els) {
					const text = el.textContent.trim();
					if (text === '中学生コース' && el.offsetParent !== null) junior = true;
					if (text === '小学生コース' && el.offsetParent !== null) elementary = true;
				}
				return {junior, elementary};
			})()
		`, &result),
	)

	// resultの中身をパース（chromedpはmap[string]interface{}で返す）
	var juniorHS, elemS bool
	chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const els = document.querySelectorAll('*');
				for (const el of els) {
					if (el.textContent.trim() === '中学生コース' && el.offsetParent !== null && el.children.length === 0) return true;
				}
				return false;
			})()
		`, &juniorHS),
	)
	chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const els = document.querySelectorAll('*');
				for (const el of els) {
					if (el.textContent.trim() === '小学生コース' && el.offsetParent !== null && el.children.length === 0) return true;
				}
				return false;
			})()
		`, &elemS),
	)

	return CourseSelectionResult{
		HasCourseSelection:  juniorHS || elemS,
		HasJuniorHighSchool: juniorHS,
		HasElementarySchool: elemS,
	}
}

// SelectCourse はコースを選択する。
func SelectCourse(ctx context.Context, courseName string) error {
	log.Printf("  📚 コース選択: %s", courseName)

	var clicked bool
	err := chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const els = document.querySelectorAll('*');
				for (const el of els) {
					if (el.textContent.trim() === '%s' && el.offsetParent !== null && el.children.length === 0) {
						el.click();
						return true;
					}
				}
				return false;
			})()
		`, escapeJS(courseName)), &clicked),
		chromedp.Sleep(3*time.Second),
	)

	if err != nil {
		return fmt.Errorf("コース選択エラー: %w", err)
	}
	if !clicked {
		return fmt.Errorf("コース \"%s\" が見つかりません", courseName)
	}

	log.Printf("  ✅ %sを選択しました", courseName)
	return nil
}

// ReturnToCourseSelection はコース選択画面に戻る。
func ReturnToCourseSelection(ctx context.Context, userName string) error {
	log.Printf("    🔙 コース選択画面に戻ります...")

	// サイドバーが開いていれば閉じる
	chromedp.Run(ctx, chromedp.KeyEvent("\x1b"), chromedp.Sleep(1*time.Second))

	// 右上ユーザーエリアをクリック
	var clicked bool
	chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				const divs = document.querySelectorAll('div');
				for (const div of divs) {
					const rect = div.getBoundingClientRect();
					const text = div.textContent.trim();
					if (text.endsWith('さん') && text.length < 20 &&
						rect.x >= vw * 0.5 && rect.y <= vh * 0.2 &&
						div.offsetParent !== null) {
						div.click();
						return true;
					}
				}
				return false;
			})()
		`, &clicked),
		chromedp.Sleep(3*time.Second),
	)

	if !clicked {
		return fmt.Errorf("右上のユーザー名エリアが見つかりません")
	}

	// サイドバー内で同じユーザーをクリック
	var userClicked bool
	chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				const els = document.querySelectorAll('*');
				for (const el of els) {
					const text = el.textContent.trim();
					if (text === '%s' && el.offsetParent !== null && el.children.length === 0) {
						const rect = el.getBoundingClientRect();
						if (!(rect.x >= vw * 0.5 && rect.y <= vh * 0.2)) {
							el.click();
							return true;
						}
					}
				}
				return false;
			})()
		`, escapeJS(userName)), &userClicked),
		chromedp.Sleep(3*time.Second),
	)

	if !userClicked {
		return fmt.Errorf("サイドバー内にユーザー \"%s\" が見つかりません", maskName(userName))
	}

	// コース選択画面が表示されているか確認
	result := CheckCourseSelection(ctx)
	if result.HasCourseSelection {
		log.Printf("    ✅ コース選択画面に戻りました")
		return nil
	}

	return fmt.Errorf("コース選択画面が表示されませんでした")
}

// getTodayDate は今日の日付をMM/DD形式で返す。
func getTodayDate() (withPadding, withoutPadding string) {
	now := time.Now()
	month := int(now.Month())
	day := now.Day()
	withPadding = fmt.Sprintf("%02d/%02d", month, day)
	withoutPadding = fmt.Sprintf("%d/%d", month, day)
	return
}

// GetStudyTime は勉強時間を取得する。
func GetStudyTime(ctx context.Context) (hours, minutes int, err error) {
	withPadding, withoutPadding := getTodayDate()

	// 今日の日付が存在するか確認
	var todayExists bool
	chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const patterns = ['%s', '%s'];
				for (const p of patterns) {
					const regex = new RegExp(p.replace('/', '\\/') + '.*?[月火水木金土日]');
					const els = document.querySelectorAll('*');
					for (const el of els) {
						if (regex.test(el.textContent) && el.offsetParent !== null) return true;
					}
				}
				return false;
			})()
		`, withPadding, withoutPadding), &todayExists),
	)

	if !todayExists {
		return 0, 0, nil
	}

	// 勉強時間テキストを取得
	var timeText string
	chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const regex = /\d+時間\d+分|\d+分|\d+時間/;
				const els = document.querySelectorAll('*');
				for (const el of els) {
					const text = el.textContent.trim();
					if (regex.test(text) && el.children.length === 0 && el.offsetParent !== null) {
						return text;
					}
				}
				return '';
			})()
		`, &timeText),
	)

	if timeText == "" {
		return 0, 0, nil
	}

	return parseStudyTime(timeText)
}

// parseStudyTime は勉強時間テキストをパースする。
func parseStudyTime(text string) (hours, minutes int, err error) {
	// "X時間Y分" 形式
	re := regexp.MustCompile(`(\d+)時間(\d+)分`)
	if m := re.FindStringSubmatch(text); m != nil {
		hours, _ = strconv.Atoi(m[1])
		minutes, _ = strconv.Atoi(m[2])
	} else {
		// "Y分" のみ
		reMin := regexp.MustCompile(`(\d+)分`)
		if m := reMin.FindStringSubmatch(text); m != nil {
			minutes, _ = strconv.Atoi(m[1])
		} else {
			// "X時間" のみ
			reHour := regexp.MustCompile(`(\d+)時間`)
			if m := reHour.FindStringSubmatch(text); m != nil {
				hours, _ = strconv.Atoi(m[1])
			}
		}
	}

	// 分が60以上の場合は時間に変換
	if minutes >= 60 {
		hours += minutes / 60
		minutes = minutes % 60
	}

	return hours, minutes, nil
}

// GetMissionDetails は今日のミッション詳細を取得する。
func GetMissionDetails(ctx context.Context) ([]data.Mission, error) {
	withPadding, withoutPadding := getTodayDate()

	// JavaScript内でDOM操作してミッション情報を取得
	var missions []map[string]interface{}
	err := chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				// ページを上部にスクロール
				window.scrollTo(0, 0);

				const patterns = ['%s', '%s'];
				let targetDate = null;
				let todayHeader = null;

				for (const pattern of patterns) {
					const regex = new RegExp(pattern.replace('/', '\\/') + '.*?[月火水木金土日]');
					const els = document.querySelectorAll('*');
					for (const el of els) {
						if (regex.test(el.textContent.trim()) && el.offsetParent !== null && el.children.length === 0) {
							targetDate = pattern;
							todayHeader = el;
							break;
						}
					}
					if (todayHeader) break;
				}

				if (!todayHeader) return [];

				const todayRect = todayHeader.getBoundingClientRect();

				// 次の日付要素を探す
				const allDateEls = [];
				const dateRegex = /\d+\/\d+/;
				document.querySelectorAll('*').forEach(el => {
					if (dateRegex.test(el.textContent.trim()) && el.offsetParent !== null && el.children.length === 0) {
						const rect = el.getBoundingClientRect();
						if (rect.x < 250) {
							allDateEls.push({el, rect});
						}
					}
				});

				// 今日のインデックスを見つける
				let todayIndex = -1;
				for (let i = 0; i < allDateEls.length; i++) {
					if (allDateEls[i].el.textContent.includes(targetDate)) {
						todayIndex = i;
						break;
					}
				}

				let nextDateY = Infinity;
				if (todayIndex >= 0 && todayIndex + 1 < allDateEls.length) {
					nextDateY = allDateEls[todayIndex + 1].rect.y;
				}

				// ミッションアイコンを取得
				const missionIcons = document.querySelectorAll('.missionIcon__i6nW8');
				const results = [];

				for (const icon of missionIcons) {
					const rect = icon.getBoundingClientRect();
					if (rect.y <= todayRect.y || rect.y >= nextDateY) continue;

					const parent = icon.parentElement;
					if (!parent) continue;

					// NEWラベル判定
					const hasNew = parent.textContent.includes('NEW');
					const completed = !hasNew;

					// ミッション名
					const grandparent = parent.parentElement;
					let name = 'ミッション';
					if (grandparent) {
						const titleEl = grandparent.querySelector('.title__C3bzF');
						if (titleEl) {
							name = titleEl.textContent.trim();
						} else {
							const cleanText = parent.textContent.replace(/NEW/g, '').replace(/\d+点/g, '').replace(/前回/g, '').trim();
							if (cleanText.length > 0 && cleanText.length < 100) name = cleanText;
						}
					}

					// 点数
					let score = 0;
					const searchEls = [grandparent, grandparent?.parentElement, grandparent?.parentElement?.parentElement].filter(Boolean);
					for (const searchEl of searchEls) {
						const scoreEls = searchEl.querySelectorAll('*');
						const scores = [];
						for (const se of scoreEls) {
							const t = se.textContent.trim();
							if (/\d+点/.test(t) && !t.includes('前回') && se.children.length === 0) {
								const m = t.match(/(\d+)点/);
								if (m) scores.push(parseInt(m[1]));
							}
						}
						if (scores.length > 0) {
							score = Math.max(...scores);
							break;
						}
					}

					results.push({name, score, completed});
					if (results.length >= 10) break;
				}

				return results;
			})()
		`, withPadding, withoutPadding), &missions),
	)

	if err != nil {
		return nil, fmt.Errorf("ミッション詳細取得エラー: %w", err)
	}

	result := make([]data.Mission, 0, len(missions))
	for _, m := range missions {
		name, _ := m["name"].(string)
		if name == "" {
			name = DefaultMissionName
		}
		scoreF, _ := m["score"].(float64)
		completed, _ := m["completed"].(bool)
		result = append(result, data.Mission{
			Name:      name,
			Score:     int(scoreF),
			Completed: completed,
		})
	}

	return result, nil
}

// GetTodayMissionCount は今日の完了したミッション数を取得する。
func GetTodayMissionCount(ctx context.Context) (int, error) {
	withPadding, withoutPadding := getTodayDate()

	var count int
	err := chromedp.Run(ctx,
		chromedp.Evaluate(fmt.Sprintf(`
			(() => {
				const patterns = ['%s', '%s'];
				let todayHeader = null;
				let targetDate = null;

				for (const pattern of patterns) {
					const regex = new RegExp(pattern.replace('/', '\\/') + '.*?[月火水木金土日]');
					const els = document.querySelectorAll('*');
					for (const el of els) {
						if (regex.test(el.textContent.trim()) && el.offsetParent !== null) {
							targetDate = pattern;
							todayHeader = el;
							break;
						}
					}
					if (todayHeader) break;
				}

				if (!todayHeader) return 0;

				const todayRect = todayHeader.getBoundingClientRect();

				// 次の日付
				const dateRegex = /\d+\/\d+/;
				const allDateEls = [];
				document.querySelectorAll('*').forEach(el => {
					if (dateRegex.test(el.textContent.trim()) && el.offsetParent !== null && el.children.length === 0) {
						const rect = el.getBoundingClientRect();
						if (rect.x < 250) allDateEls.push({el, rect});
					}
				});

				let todayIndex = -1;
				for (let i = 0; i < allDateEls.length; i++) {
					if (allDateEls[i].el.textContent.includes(targetDate)) {
						todayIndex = i;
						break;
					}
				}

				let nextDateY = Infinity;
				if (todayIndex >= 0 && todayIndex + 1 < allDateEls.length) {
					nextDateY = allDateEls[todayIndex + 1].rect.y;
				}

				const missionIcons = document.querySelectorAll('.missionIcon__i6nW8');
				let completedCount = 0;

				for (const icon of missionIcons) {
					const rect = icon.getBoundingClientRect();
					if (rect.y > todayRect.y && rect.y < nextDateY) {
						const parent = icon.parentElement;
						if (parent && !parent.textContent.includes('NEW')) {
							completedCount++;
						}
					}
				}

				return completedCount;
			})()
		`, withPadding, withoutPadding), &count),
	)

	if err != nil {
		return 0, fmt.Errorf("ミッション数取得エラー: %w", err)
	}

	return count, nil
}

// GetTotalScore はミッション配列から合計点数を計算する。
func GetTotalScore(missions []data.Mission) int {
	total := 0
	for _, m := range missions {
		total += m.Score
	}
	return total
}

// getCourseData はコースのデータを取得する。
func getCourseData(ctx context.Context, userName, courseName string) (*data.UserData, error) {
	dateString := time.Now().Format("2006-01-02")

	hours, minutes, _ := GetStudyTime(ctx)
	missionCount, _ := GetTodayMissionCount(ctx)
	missions, _ := GetMissionDetails(ctx)
	if missions == nil {
		missions = []data.Mission{}
	}
	totalScore := GetTotalScore(missions)

	displayName := userName
	if courseName != "" {
		displayName = fmt.Sprintf("%s (%s)", userName, courseName)
	}

	return &data.UserData{
		UserName:     displayName,
		MissionCount: missionCount,
		Date:         dateString,
		StudyTime:    data.StudyTime{Hours: hours, Minutes: minutes},
		TotalScore:   totalScore,
		Missions:     missions,
	}, nil
}

// GetAllUsersDetailedData は全ユーザーの詳細データを取得する。
func GetAllUsersDetailedData(ctx context.Context) ([]data.UserData, error) {
	users, err := GetUserList(ctx)
	if err != nil {
		return nil, err
	}

	var allData []data.UserData

	for _, user := range users {
		log.Printf("\n👤 %s のデータを取得中...", maskName(user.Name))

		if err := SwitchToUser(ctx, user.Name); err != nil {
			log.Printf("  ❌ ユーザー切り替え失敗: %v", err)
			continue
		}

		courseResult := CheckCourseSelection(ctx)

		if courseResult.HasCourseSelection {
			log.Printf("  📚 コース選択画面が表示されています")

			var courses []string
			if courseResult.HasJuniorHighSchool {
				courses = append(courses, JuniorHighSchoolText)
			}
			if courseResult.HasElementarySchool {
				courses = append(courses, ElementarySchoolText)
			}

			for i, courseName := range courses {
				log.Printf("\n  📖 %s のデータを取得中...", courseName)

				if err := SelectCourse(ctx, courseName); err != nil {
					log.Printf("    ❌ コース選択失敗: %v", err)
					continue
				}

				userData, err := getCourseData(ctx, user.Name, courseName)
				if err != nil {
					log.Printf("    ❌ データ取得失敗: %v", err)
					continue
				}

				allData = append(allData, *userData)

				if i < len(courses)-1 {
					if err := ReturnToCourseSelection(ctx, user.Name); err != nil {
						log.Printf("    ❌ コース選択画面への復帰失敗: %v", err)
						break
					}
				}
			}
		} else {
			userData, err := getCourseData(ctx, user.Name, "")
			if err != nil {
				log.Printf("  ❌ データ取得失敗: %v", err)
				continue
			}
			allData = append(allData, *userData)
		}
	}

	if len(allData) == 0 {
		return nil, fmt.Errorf("全てのユーザーのデータ取得に失敗しました。")
	}

	return allData, nil
}

// SaveScreenshot はスクリーンショットを保存する。
func SaveScreenshot(ctx context.Context, filename string) error {
	var buf []byte
	if err := chromedp.Run(ctx, chromedp.FullScreenshot(&buf, 90)); err != nil {
		return err
	}

	// os.WriteFileはmainから呼び出す
	_ = buf
	return nil
}

// escapeJS はJavaScript文字列リテラル用にエスケープする。
func escapeJS(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `'`, `\'`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

