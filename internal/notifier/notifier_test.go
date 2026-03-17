package notifier

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/yo4raw/smilezemi-notification/internal/data"
)

func TestSend_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer test_token" {
			t.Errorf("unexpected Authorization header: %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected Content-Type: %s", r.Header.Get("Content-Type"))
		}

		var req lineRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.To != "test_user" {
			t.Errorf("expected to=test_user, got %s", req.To)
		}
		if len(req.Messages) != 1 || req.Messages[0].Type != "text" {
			t.Error("unexpected message format")
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewLineClient("test_token", "test_user")
	client.Endpoint = server.URL

	err := client.Send("テストメッセージ", DefaultSendOptions())
	if err != nil {
		t.Fatalf("Send() returned error: %v", err)
	}
}

func TestSend_AuthError_NoRetry(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewLineClient("invalid_token", "test_user")
	client.Endpoint = server.URL

	err := client.Send("test", DefaultSendOptions())
	if err == nil {
		t.Fatal("Send() should return error for 401")
	}
	if callCount != 1 {
		t.Errorf("expected 1 call (no retry for 401), got %d", callCount)
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error should mention 401: %s", err.Error())
	}
}

func TestSend_ServerError_Retry(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := NewLineClient("test_token", "test_user")
	client.Endpoint = server.URL

	opts := SendOptions{MaxRetries: 3, RetryDelay: 10 * time.Millisecond}
	err := client.Send("test", opts)
	if err == nil {
		t.Fatal("Send() should return error after retries")
	}
	if callCount != 3 {
		t.Errorf("expected 3 retries, got %d", callCount)
	}
}

func TestSend_MissingParams(t *testing.T) {
	client := NewLineClient("", "test_user")
	err := client.Send("test", DefaultSendOptions())
	if err == nil {
		t.Fatal("Send() should return error when accessToken is empty")
	}

	client = NewLineClient("test_token", "")
	err = client.Send("test", DefaultSendOptions())
	if err == nil {
		t.Fatal("Send() should return error when userID is empty")
	}
}

func TestSend_ExponentialBackoff(t *testing.T) {
	var callTimes []time.Time
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callTimes = append(callTimes, time.Now())
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := NewLineClient("test_token", "test_user")
	client.Endpoint = server.URL

	opts := SendOptions{MaxRetries: 3, RetryDelay: 50 * time.Millisecond}
	client.Send("test", opts)

	if len(callTimes) >= 2 {
		interval1 := callTimes[1].Sub(callTimes[0])
		if interval1 < 40*time.Millisecond || interval1 > 100*time.Millisecond {
			t.Errorf("1st retry interval should be ~50ms, got %v", interval1)
		}
	}
	if len(callTimes) >= 3 {
		interval2 := callTimes[2].Sub(callTimes[1])
		if interval2 < 80*time.Millisecond || interval2 > 200*time.Millisecond {
			t.Errorf("2nd retry interval should be ~100ms, got %v", interval2)
		}
	}
}

func TestSend_TokenMaskedInError(t *testing.T) {
	// サーバーなしで接続エラーを発生させる
	client := NewLineClient("secret_token_12345", "test_user")
	client.Endpoint = "http://localhost:1" // 接続不可

	opts := SendOptions{MaxRetries: 1, RetryDelay: 1 * time.Millisecond}
	err := client.Send("test", opts)
	if err == nil {
		t.Fatal("Send() should return error")
	}
	if strings.Contains(err.Error(), "secret_token_12345") {
		t.Error("error message should not contain the actual token")
	}
}

func TestFormatMessage_WithChanges(t *testing.T) {
	changes := []data.Change{
		{UserName: "太郎", PreviousCount: 5, CurrentCount: 8, Diff: 3, Type: "increase"},
	}

	msg := FormatMessage(changes)
	if !strings.Contains(msg, "太郎") {
		t.Error("message should contain user name")
	}
	if !strings.Contains(msg, "+3") {
		t.Error("message should contain diff")
	}
}

func TestFormatMessage_NoChanges(t *testing.T) {
	msg := FormatMessage([]data.Change{})
	if !strings.Contains(msg, "変更ありませんでした") {
		t.Errorf("message should indicate no changes: %s", msg)
	}
}

func TestFormatMessage_MultipleChangeTypes(t *testing.T) {
	changes := []data.Change{
		{UserName: "太郎", PreviousCount: 5, CurrentCount: 8, Diff: 3, Type: "increase"},
		{UserName: "花子", PreviousCount: 10, CurrentCount: 7, Diff: -3, Type: "decrease"},
		{UserName: "次郎", PreviousCount: 0, CurrentCount: 2, Diff: 2, Type: "new"},
	}

	msg := FormatMessage(changes)
	if !strings.Contains(msg, "太郎") || !strings.Contains(msg, "花子") || !strings.Contains(msg, "次郎") {
		t.Error("message should contain all user names")
	}
	if !strings.Contains(msg, "新規") {
		t.Error("message should contain '新規' for new users")
	}
}

func TestFormatMessage_LengthLimit(t *testing.T) {
	var changes []data.Change
	for i := 0; i < 100; i++ {
		changes = append(changes, data.Change{
			UserName:      fmt.Sprintf("ユーザー%d", i),
			PreviousCount: 0,
			CurrentCount:  5,
			Diff:          5,
			Type:          "new",
		})
	}

	msg := FormatMessage(changes)
	if utf8.RuneCountInString(msg) > MaxMessageLength {
		t.Errorf("message length %d exceeds limit %d", utf8.RuneCountInString(msg), MaxMessageLength)
	}
}

func TestFormatDetailedMessage_Basic(t *testing.T) {
	userData := []data.UserData{
		{
			UserName:  "太郎",
			StudyTime: data.StudyTime{Hours: 1, Minutes: 30},
			Missions: []data.Mission{
				{Name: "算数", Score: 100, Completed: true},
				{Name: "国語", Score: 85, Completed: true},
			},
		},
	}

	msg := FormatDetailedMessage(userData, nil)
	if !strings.Contains(msg, "太郎") {
		t.Error("should contain user name")
	}
	if !strings.Contains(msg, "01:30") {
		t.Error("should contain study time")
	}
	if !strings.Contains(msg, "算数") || !strings.Contains(msg, "国語") {
		t.Error("should contain mission names")
	}
	if !strings.Contains(msg, "100点") || !strings.Contains(msg, "85点") {
		t.Error("should contain scores")
	}
}

func TestFormatDetailedMessage_Empty(t *testing.T) {
	msg := FormatDetailedMessage([]data.UserData{}, nil)
	if !strings.Contains(msg, "データはありません") {
		t.Error("should indicate no data")
	}
}

func TestFormatDetailedMessage_WithMissionChanges(t *testing.T) {
	userData := []data.UserData{
		{
			UserName:  "太郎",
			StudyTime: data.StudyTime{Hours: 0, Minutes: 45},
			Missions: []data.Mission{
				{Name: "算数", Score: 100, Completed: true},
				{Name: "理科", Score: 90, Completed: true},
			},
		},
	}

	missionChanges := &data.MissionDetailChanges{
		UserChanges: []data.UserMissionChanges{
			{
				UserName: "太郎",
				MissionChanges: []data.MissionChange{
					{MissionName: "算数", Type: "score_change", PreviousScore: 80, CurrentScore: 100, ScoreChange: 20},
					{MissionName: "理科", Type: "new_mission", CurrentScore: 90},
				},
			},
		},
	}

	msg := FormatDetailedMessage(userData, missionChanges)
	if !strings.Contains(msg, "80→100点") {
		t.Error("should show score change")
	}
	if !strings.Contains(msg, "📈") {
		t.Error("should show increase icon for score improvement")
	}
	if !strings.Contains(msg, "NEW") {
		t.Error("should show NEW for new missions")
	}
	if !strings.Contains(msg, "✨") {
		t.Error("should show sparkle icon for new missions")
	}
}

func TestFormatDetailedMessage_NoMissions(t *testing.T) {
	userData := []data.UserData{
		{
			UserName:  "太郎",
			StudyTime: data.StudyTime{Hours: 0, Minutes: 0},
			Missions:  []data.Mission{},
		},
	}

	msg := FormatDetailedMessage(userData, nil)
	if !strings.Contains(msg, "ミッション詳細なし") {
		t.Error("should indicate no missions")
	}
}

func TestTruncateToLimit_Short(t *testing.T) {
	msg := "短いメッセージ"
	result := TruncateToLimit(msg)
	if result != msg {
		t.Errorf("short message should not be truncated")
	}
}

func TestTruncateToLimit_Long(t *testing.T) {
	// 5000文字を超えるメッセージを作成
	runes := make([]rune, 6000)
	for i := range runes {
		runes[i] = 'あ'
	}
	msg := string(runes)

	result := TruncateToLimit(msg)
	if utf8.RuneCountInString(result) > MaxMessageLength {
		t.Errorf("truncated message should be within limit, got %d runes", utf8.RuneCountInString(result))
	}
	if !strings.Contains(result, "省略") {
		t.Error("truncated message should contain truncation indicator")
	}
}

func TestFormatMessage_DefaultChangeType(t *testing.T) {
	// defaultケース（increaseでもdecreaseでもnewでもない型）
	changes := []data.Change{
		{UserName: "太郎", PreviousCount: 5, CurrentCount: 5, Diff: 0, Type: "unknown"},
	}

	msg := FormatMessage(changes)
	if !strings.Contains(msg, "太郎") {
		t.Error("message should contain user name")
	}
	// defaultケースは "5 → 5" 形式（アイコンは📊）
	if !strings.Contains(msg, "📊") {
		t.Error("message should contain 📊 icon for default change type")
	}
}

func TestFormatMessage_ExceedsMaxMessageLength(t *testing.T) {
	// 各エントリが非常に長いユーザー名を持つ変更を大量に作り、
	// utf8.RuneCountInString(result) > MaxMessageLength の分岐を通過させる
	var changes []data.Change
	// MaxMessageLength (5000) を超えるよう、長いユーザー名で大量のエントリを作成
	longName := strings.Repeat("あ", 200) // 200文字のユーザー名
	for i := 0; i < 30; i++ {
		changes = append(changes, data.Change{
			UserName:      fmt.Sprintf("%s%d", longName, i),
			PreviousCount: 0,
			CurrentCount:  5,
			Diff:          5,
			Type:          "new",
		})
	}

	msg := FormatMessage(changes)
	// utf8 truncation が走った場合、末尾に省略メッセージが含まれる
	// または sb.Len() > MaxMessageLength-100 の早期break で「他N件」が含まれる
	// どちらにせよ、最終的に MaxMessageLength 以内に収まること
	if utf8.RuneCountInString(msg) > MaxMessageLength {
		t.Errorf("message length %d exceeds MaxMessageLength %d", utf8.RuneCountInString(msg), MaxMessageLength)
	}
}

func TestMaskTokenInError_EmptyToken(t *testing.T) {
	errMsg := "some error with secret info"
	// トークンが空の場合、メッセージはそのまま返る
	result := maskTokenInError(errMsg, "")
	if result != errMsg {
		t.Errorf("empty token: expected original message %q, got %q", errMsg, result)
	}
}

func TestMaskTokenInError_NonEmptyToken(t *testing.T) {
	token := "mysecrettoken"
	errMsg := fmt.Sprintf("connection failed with token %s in URL", token)
	result := maskTokenInError(errMsg, token)
	if strings.Contains(result, token) {
		t.Errorf("token should be masked in error message, got: %s", result)
	}
}

func TestFormatDetailedMessage_GroupedMissions(t *testing.T) {
	// 同名ミッションが複数あり、スコアが異なる場合（増加・減少）
	userData := []data.UserData{
		{
			UserName:  "太郎",
			StudyTime: data.StudyTime{Hours: 0, Minutes: 30},
			Missions: []data.Mission{
				{Name: "算数", Score: 70, Completed: true},
				{Name: "算数", Score: 90, Completed: true}, // スコア増加
				{Name: "国語", Score: 80, Completed: true},
				{Name: "国語", Score: 60, Completed: true}, // スコア減少
			},
		},
	}

	msg := FormatDetailedMessage(userData, nil)
	// 増加: 70→90点 + 📈
	if !strings.Contains(msg, "70→90点") {
		t.Error("should show grouped score increase: 70→90点")
	}
	if !strings.Contains(msg, "📈") {
		t.Error("should show 📈 for score increase in grouped missions")
	}
	// 減少: 80→60点 + 📉
	if !strings.Contains(msg, "80→60点") {
		t.Error("should show grouped score decrease: 80→60点")
	}
	if !strings.Contains(msg, "📉") {
		t.Error("should show 📉 for score decrease in grouped missions")
	}
}

func TestFormatDetailedMessage_GroupedMissions_SameScore(t *testing.T) {
	// 同名ミッションが複数あり、first.Score == last.Score の場合
	userData := []data.UserData{
		{
			UserName:  "太郎",
			StudyTime: data.StudyTime{Hours: 0, Minutes: 20},
			Missions: []data.Mission{
				{Name: "算数", Score: 85, Completed: true},
				{Name: "算数", Score: 85, Completed: true}, // 同スコア
			},
		},
	}

	msg := FormatDetailedMessage(userData, nil)
	// スコアが同じなら "85点" と表示（"→" なし）
	if !strings.Contains(msg, "85点") {
		t.Error("should show single score when grouped scores are equal: 85点")
	}
	if strings.Contains(msg, "85→85") {
		t.Error("should not show arrow when scores are equal")
	}
}

func TestFormatDetailedMessage_GroupedMissions_NotCompleted(t *testing.T) {
	// 同名ミッションのグループで last.Completed が false の場合 → ✨ が付く
	userData := []data.UserData{
		{
			UserName:  "太郎",
			StudyTime: data.StudyTime{Hours: 0, Minutes: 15},
			Missions: []data.Mission{
				{Name: "算数", Score: 50, Completed: true},
				{Name: "算数", Score: 50, Completed: false}, // 未完了
			},
		},
	}

	msg := FormatDetailedMessage(userData, nil)
	if !strings.Contains(msg, "✨") {
		t.Error("should show ✨ when last mission in group is not completed")
	}
}

func TestFormatDetailedMessage_MissionNotInChangesMap_Completed(t *testing.T) {
	// userChangesMap が存在するが、そのミッションが changesMap に含まれず、
	// かつ mission.Completed == true の場合 → ✨ は付かない
	userData := []data.UserData{
		{
			UserName:  "太郎",
			StudyTime: data.StudyTime{Hours: 0, Minutes: 10},
			Missions: []data.Mission{
				{Name: "算数", Score: 90, Completed: true},
			},
		},
	}

	// missionChanges は存在するが "算数" は含まない（別のミッションのみ）
	missionChanges := &data.MissionDetailChanges{
		UserChanges: []data.UserMissionChanges{
			{
				UserName: "太郎",
				MissionChanges: []data.MissionChange{
					{MissionName: "理科", Type: "new_mission", CurrentScore: 80},
				},
			},
		},
	}

	msg := FormatDetailedMessage(userData, missionChanges)
	if !strings.Contains(msg, "算数") {
		t.Error("should contain mission name 算数")
	}
	if !strings.Contains(msg, "90点") {
		t.Error("should show score 90点")
	}
	// Completed==true かつ changesMap に存在しないので ✨ は付かない
	if strings.Contains(msg, "✨") {
		t.Error("should not show ✨ when mission is completed and not in changes map")
	}
}
