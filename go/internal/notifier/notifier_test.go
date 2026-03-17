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

	"github.com/yaoko/smilezemi-notification/internal/data"
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
