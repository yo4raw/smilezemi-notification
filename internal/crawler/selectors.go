// Package crawler はみまもるネットのデータ取得機能を提供する。
package crawler

import "time"

// セレクタ定数とタイムアウト設定

// ログインページ
const (
	LoginURL           = "https://smile-zemi.jp/mimamoru-net/ui/login"
	UsernameField      = `input[name="userId"]`
	PasswordField      = `input[name="password"]`
	SubmitButtonText   = "ログイン"
	TimelineURL        = "https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline"
)

// 待機時間
const (
	PageLoadTimeout      = 60 * time.Second
	ElementTimeout       = 30 * time.Second
	UserSwitchDelay      = 3 * time.Second
	StabilizationDelay   = 1 * time.Second
	CourseSelectionWait  = 2 * time.Second
	TabClickWait        = 5 * time.Second
)

// ミッション詳細
const (
	MissionIconSelector  = ".missionIcon__i6nW8"
	MissionTitleSelector = ".title__C3bzF"
	ScoreLabelSelector   = ".scoreLabel__LpVbL"
	DefaultMissionName   = "ミッション"
	DefaultScore         = 0
	MaxMissionsPerDay    = 10
)

// コース選択
const (
	JuniorHighSchoolText = "中学生コース"
	ElementarySchoolText = "小学生コース"
)

// 週間レポート
const (
	ReportTabText          = "指導レポート"
	SectionTitleSelector   = ".title__jXeZJ"
	TorikumiRootSelector   = ".instructionMessageRoot__luz50"
	ResultClassSelector    = ".result__jjiPN"
	MessageSelector        = ".message__JrLLL"
	PraiseRootSelector     = ".praiseMessageRoot__lmfJ9"
)

// ユーザー識別用
const (
	ChildSectionText = "お子さま"
	SanSuffix        = "さん"
	MaxUserNameLen   = 20
)

// 除外対象ユーザー名パターン
var excludedUserPatterns = []string{
	"お子さま",
	"おとう",
	"おかあ",
	"コース",
}
