// Package notifier はLINE Messaging API統合による通知機能を提供する。
package notifier

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yo4raw/smilezemi-notification/internal/config"
	"github.com/yo4raw/smilezemi-notification/internal/data"
)

const (
	// LineAPIEndpoint はLINE Push Message APIのエンドポイント。
	LineAPIEndpoint = "https://api.line.me/v2/bot/message/push"

	// MaxMessageLength はLINE APIのメッセージ最大長。
	MaxMessageLength = 5000
)

// lineMessage はLINE APIのメッセージ構造体。
type lineMessage struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// lineRequest はLINE Push Message APIのリクエスト構造体。
type lineRequest struct {
	To       string        `json:"to"`
	Messages []lineMessage `json:"messages"`
}

// LineClient はLINE通知クライアント。
type LineClient struct {
	AccessToken string
	UserID      string
	HTTPClient  *http.Client
	Endpoint    string
}

// NewLineClient は新しいLineClientを生成する。
func NewLineClient(accessToken, userID string) *LineClient {
	return &LineClient{
		AccessToken: accessToken,
		UserID:      userID,
		HTTPClient:  &http.Client{Timeout: 30 * time.Second},
		Endpoint:    LineAPIEndpoint,
	}
}

// SendOptions は送信オプション。
type SendOptions struct {
	MaxRetries int
	RetryDelay time.Duration
}

// DefaultSendOptions はデフォルトの送信オプション。
func DefaultSendOptions() SendOptions {
	return SendOptions{
		MaxRetries: 3,
		RetryDelay: 1 * time.Second,
	}
}

// Send はLINE Push Message APIを使ってメッセージを送信する。
func (c *LineClient) Send(message string, opts SendOptions) error {
	if c.AccessToken == "" || c.UserID == "" {
		return fmt.Errorf("必須パラメータが欠けています: accessToken と userId が必要です")
	}

	reqBody := lineRequest{
		To: c.UserID,
		Messages: []lineMessage{
			{Type: "text", Text: message},
		},
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("リクエスト構築エラー: %w", err)
	}

	var lastErr error
	for attempt := 1; attempt <= opts.MaxRetries; attempt++ {
		err := c.attemptSend(bodyBytes)
		if err == nil {
			return nil
		}

		lastErr = err

		// 認証エラーはリトライしない
		if strings.Contains(err.Error(), "401") {
			return err
		}

		// 最後の試行でなければリトライ
		if attempt < opts.MaxRetries {
			delay := time.Duration(math.Pow(2, float64(attempt-1))) * opts.RetryDelay
			time.Sleep(delay)
		}
	}

	return fmt.Errorf("通知送信失敗（%d回試行）: %w", opts.MaxRetries, lastErr)
}

// attemptSend は1回の送信を試みる。
func (c *LineClient) attemptSend(bodyBytes []byte) error {
	req, err := http.NewRequest("POST", c.Endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("リクエスト作成エラー: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.AccessToken)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("ネットワークエラー: %s", maskTokenInError(err.Error(), c.AccessToken))
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("認証エラー: アクセストークンが無効です (401 Unauthorized)")
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("LINE API エラー: %d %s", resp.StatusCode, resp.Status)
	}

	return nil
}

// maskTokenInError はエラーメッセージからトークンを除去する。
func maskTokenInError(errMsg, token string) string {
	if token == "" {
		return errMsg
	}
	masked := strings.ReplaceAll(errMsg, token, "***")
	masked = config.MaskSensitiveString(masked)
	return masked
}

// FormatMessage は変更情報をLINE通知用のメッセージにフォーマットする。
func FormatMessage(changes []data.Change) string {
	if len(changes) == 0 {
		return "📊 スマイルゼミ ミッション数\n\n本日は変更ありませんでした。"
	}

	var sb strings.Builder
	sb.WriteString("📊 スマイルゼミ ミッション数\n\n")
	sb.WriteString(fmt.Sprintf("🔔 %d件の変更がありました\n\n", len(changes)))

	for i, change := range changes {
		var icon, text string

		switch change.Type {
		case "increase":
			icon = "📈"
			text = fmt.Sprintf("%d → %d (+%d)", change.PreviousCount, change.CurrentCount, change.Diff)
		case "decrease":
			icon = "📉"
			text = fmt.Sprintf("%d → %d (%d)", change.PreviousCount, change.CurrentCount, change.Diff)
		case "new":
			icon = "✨"
			text = fmt.Sprintf("新規: %dミッション", change.CurrentCount)
		default:
			icon = "📊"
			text = fmt.Sprintf("%d → %d", change.PreviousCount, change.CurrentCount)
		}

		sb.WriteString(fmt.Sprintf("%s %s\n%s\n\n", icon, change.UserName, text))

		// メッセージ長チェック
		if sb.Len() > MaxMessageLength-100 {
			remaining := len(changes) - i - 1
			if remaining > 0 {
				sb.WriteString(fmt.Sprintf("... 他%d件の変更があります", remaining))
			}
			break
		}
	}

	result := sb.String()
	if utf8.RuneCountInString(result) > MaxMessageLength {
		runes := []rune(result)
		result = string(runes[:MaxMessageLength-20]) + "\n\n（メッセージが長すぎたため省略されました）"
	}

	return strings.TrimSpace(result)
}

// FormatDetailedMessage は詳細データをLINE通知用のメッセージにフォーマットする。
func FormatDetailedMessage(userData []data.UserData, missionChanges *data.MissionDetailChanges) string {
	var sb strings.Builder
	sb.WriteString("📊 スマイルゼミ 学習状況\n\n")

	if len(userData) == 0 {
		sb.WriteString("本日のデータはありません。")
		return strings.TrimSpace(sb.String())
	}

	// ミッション変化情報をユーザー名でマッピング
	changesMap := make(map[string]map[string]data.MissionChange)
	if missionChanges != nil {
		for _, uc := range missionChanges.UserChanges {
			mMap := make(map[string]data.MissionChange)
			for _, mc := range uc.MissionChanges {
				mMap[mc.MissionName] = mc
			}
			changesMap[uc.UserName] = mMap
		}
	}

	for i, user := range userData {
		sb.WriteString(fmt.Sprintf("👤 %s\n", user.UserName))
		sb.WriteString(fmt.Sprintf("⏱️ 勉強時間: %02d:%02d\n", user.StudyTime.Hours, user.StudyTime.Minutes))

		missions := user.Missions
		if len(missions) > 0 {
			sb.WriteString("\n📋 ミッション詳細:\n")

			userChangesMap := changesMap[user.UserName]

			// 同名ミッションを集約
			type missionGroup struct {
				name     string
				missions []data.Mission
			}
			groupOrder := []string{}
			groups := make(map[string][]data.Mission)
			for _, m := range missions {
				if _, exists := groups[m.Name]; !exists {
					groupOrder = append(groupOrder, m.Name)
				}
				groups[m.Name] = append(groups[m.Name], m)
			}

			for _, missionName := range groupOrder {
				group := groups[missionName]
				var scoreDisplay, changeIcon string

				if len(group) == 1 {
					mission := group[0]

					if userChangesMap != nil {
						change, hasChange := userChangesMap[mission.Name]
						if hasChange {
							switch change.Type {
							case "score_change":
								scoreDisplay = fmt.Sprintf("%d→%d点", change.PreviousScore, change.CurrentScore)
								if change.ScoreChange > 0 {
									changeIcon = " 📈"
								} else {
									changeIcon = " 📉"
								}
							case "new_mission":
								scoreDisplay = fmt.Sprintf("%d点（NEW）", change.CurrentScore)
								changeIcon = " ✨"
							default:
								scoreDisplay = fmt.Sprintf("%d点", change.CurrentScore)
							}
						} else {
							scoreDisplay = fmt.Sprintf("%d点", mission.Score)
							if !mission.Completed {
								changeIcon = " ✨"
							}
						}
					} else {
						scoreDisplay = fmt.Sprintf("%d点", mission.Score)
						if !mission.Completed {
							changeIcon = " ✨"
						}
					}
				} else {
					first := group[0]
					last := group[len(group)-1]

					if first.Score != last.Score {
						scoreDisplay = fmt.Sprintf("%d→%d点", first.Score, last.Score)
						if last.Score > first.Score {
							changeIcon = " 📈"
						} else {
							changeIcon = " 📉"
						}
					} else {
						scoreDisplay = fmt.Sprintf("%d点", last.Score)
					}

					if !last.Completed {
						changeIcon += " ✨"
					}
				}

				sb.WriteString(fmt.Sprintf("  ・%s: %s%s\n", missionName, scoreDisplay, changeIcon))
			}
		} else {
			sb.WriteString("\n📋 ミッション詳細なし\n")
		}

		// ユーザー間セパレータ
		if i < len(userData)-1 {
			sb.WriteString("\n")
		}
	}

	return strings.TrimSpace(sb.String())
}

// TruncateToLimit はメッセージを5000文字以内に切り詰める。
func TruncateToLimit(message string) string {
	if utf8.RuneCountInString(message) <= MaxMessageLength {
		return message
	}

	runes := []rune(message)
	truncated := string(runes[:4950])
	return truncated + "\n\n...（メッセージが長すぎるため省略）"
}
