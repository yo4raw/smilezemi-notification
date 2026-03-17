// Package data はミッションデータの保存・取得・比較を提供する。
package data

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Mission は個々のミッション情報を表す。
type Mission struct {
	Name      string `json:"name"`
	Score     int    `json:"score"`
	Completed bool   `json:"completed"`
}

// StudyTime は勉強時間を表す。
type StudyTime struct {
	Hours   int `json:"hours"`
	Minutes int `json:"minutes"`
}

// UserData はユーザーごとのデータを表す。
type UserData struct {
	UserName     string    `json:"userName"`
	MissionCount int       `json:"missionCount"`
	Date         string    `json:"date"`
	StudyTime    StudyTime `json:"studyTime"`
	TotalScore   int       `json:"totalScore"`
	Missions     []Mission `json:"missions"`
}

// MissionData はJSON保存用のトップレベル構造体。
type MissionData struct {
	Version   string     `json:"version"`
	Timestamp string     `json:"timestamp"`
	Users     []UserData `json:"users"`
}

// Change はミッション数の変更情報を表す。
type Change struct {
	UserName      string `json:"userName"`
	PreviousCount int    `json:"previousCount"`
	CurrentCount  int    `json:"currentCount"`
	Diff          int    `json:"diff"`
	Type          string `json:"type"` // "new", "increase", "decrease"
}

// MissionChange はミッション詳細レベルの変更を表す。
type MissionChange struct {
	MissionName   string `json:"missionName"`
	Type          string `json:"type"` // "score_change", "new_mission", "no_change"
	PreviousScore int    `json:"previousScore,omitempty"`
	CurrentScore  int    `json:"currentScore"`
	ScoreChange   int    `json:"scoreChange,omitempty"`
	Completed     bool   `json:"completed"`
}

// UserMissionChanges はユーザーごとのミッション変更情報を表す。
type UserMissionChanges struct {
	UserName       string          `json:"userName"`
	MissionChanges []MissionChange `json:"missionChanges"`
}

// MissionDetailChanges はミッション詳細比較の結果を表す。
type MissionDetailChanges struct {
	UserChanges []UserMissionChanges `json:"userChanges"`
}

// LoadPreviousData は前回実行時のデータを読み込む。
// ファイルが存在しない場合は空のスライスを返す。
func LoadPreviousData(dataFile string) ([]UserData, error) {
	raw, err := os.ReadFile(dataFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []UserData{}, nil
		}
		return nil, fmt.Errorf("データ読み込みエラー: %w", err)
	}

	// まずバージョンを確認するためにraw JSONをパース
	var rawJSON map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rawJSON); err != nil {
		return nil, fmt.Errorf("JSONパースエラー: %w", err)
	}

	// バージョン判定
	version := "1.0"
	if v, ok := rawJSON["version"]; ok {
		if err := json.Unmarshal(v, &version); err != nil {
			version = "1.0"
		}
	}

	var users []UserData
	usersRaw, ok := rawJSON["users"]
	if !ok {
		return []UserData{}, nil
	}

	if err := json.Unmarshal(usersRaw, &users); err != nil {
		return nil, fmt.Errorf("ユーザーデータパースエラー: %w", err)
	}

	switch version {
	case "1.0":
		users = migrateDataV1toV2(users)
	case "2.0":
		// そのまま使用
	default:
		return nil, fmt.Errorf("未知のデータバージョン: %s", version)
	}

	return users, nil
}

// migrateDataV1toV2 はv1.0データをv2.0形式に移行する。
func migrateDataV1toV2(v1Data []UserData) []UserData {
	result := make([]UserData, len(v1Data))
	for i, user := range v1Data {
		result[i] = UserData{
			UserName:     user.UserName,
			MissionCount: user.MissionCount,
			Date:         user.Date,
			StudyTime:    StudyTime{Hours: 0, Minutes: 0},
			TotalScore:   0,
			Missions:     []Mission{},
		}
	}
	return result
}

// CompareData は新旧データを比較して変更を検出する。
func CompareData(previousData, currentData []UserData) []Change {
	previousMap := make(map[string]int)
	for _, user := range previousData {
		previousMap[user.UserName] = user.MissionCount
	}

	var changes []Change

	for _, current := range currentData {
		prevCount, exists := previousMap[current.UserName]

		if !exists {
			changes = append(changes, Change{
				UserName:      current.UserName,
				PreviousCount: 0,
				CurrentCount:  current.MissionCount,
				Diff:          current.MissionCount,
				Type:          "new",
			})
		} else if current.MissionCount > prevCount {
			changes = append(changes, Change{
				UserName:      current.UserName,
				PreviousCount: prevCount,
				CurrentCount:  current.MissionCount,
				Diff:          current.MissionCount - prevCount,
				Type:          "increase",
			})
		} else if current.MissionCount < prevCount {
			changes = append(changes, Change{
				UserName:      current.UserName,
				PreviousCount: prevCount,
				CurrentCount:  current.MissionCount,
				Diff:          current.MissionCount - prevCount,
				Type:          "decrease",
			})
		}
	}

	return changes
}

// CompareMissionDetails はミッション詳細レベルの変更を検出する。
func CompareMissionDetails(previousData, currentData []UserData) MissionDetailChanges {
	previousMap := make(map[string][]Mission)
	for _, user := range previousData {
		if user.Missions != nil {
			previousMap[user.UserName] = user.Missions
		}
	}

	var userChanges []UserMissionChanges

	for _, currentUser := range currentData {
		if currentUser.Missions == nil {
			continue
		}

		prevMissions, hasPrev := previousMap[currentUser.UserName]

		var missionChanges []MissionChange

		if !hasPrev {
			// 全て新規ミッション
			for _, m := range currentUser.Missions {
				missionChanges = append(missionChanges, MissionChange{
					MissionName:  m.Name,
					Type:         "new_mission",
					CurrentScore: m.Score,
					Completed:    m.Completed,
				})
			}
		} else {
			// 前回のミッションを名前でマッピング
			prevMissionMap := make(map[string]Mission)
			for _, m := range prevMissions {
				if _, exists := prevMissionMap[m.Name]; !exists {
					prevMissionMap[m.Name] = m
				}
			}

			for _, currentMission := range currentUser.Missions {
				prevMission, exists := prevMissionMap[currentMission.Name]

				if !exists {
					missionChanges = append(missionChanges, MissionChange{
						MissionName:  currentMission.Name,
						Type:         "new_mission",
						CurrentScore: currentMission.Score,
						Completed:    currentMission.Completed,
					})
				} else if currentMission.Score != prevMission.Score {
					missionChanges = append(missionChanges, MissionChange{
						MissionName:   currentMission.Name,
						Type:          "score_change",
						PreviousScore: prevMission.Score,
						CurrentScore:  currentMission.Score,
						ScoreChange:   currentMission.Score - prevMission.Score,
						Completed:     currentMission.Completed,
					})
				} else {
					missionChanges = append(missionChanges, MissionChange{
						MissionName:  currentMission.Name,
						Type:         "no_change",
						CurrentScore: currentMission.Score,
						Completed:    currentMission.Completed,
					})
				}
			}
		}

		if len(missionChanges) > 0 {
			userChanges = append(userChanges, UserMissionChanges{
				UserName:       currentUser.UserName,
				MissionChanges: missionChanges,
			})
		}
	}

	return MissionDetailChanges{UserChanges: userChanges}
}

// SaveData はユーザーデータをJSON形式で保存する。
func SaveData(dataFile string, users []UserData) error {
	dir := filepath.Dir(dataFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("データディレクトリ作成エラー: %w", err)
	}

	saveObj := MissionData{
		Version:   "2.0",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Users:     users,
	}

	raw, err := json.MarshalIndent(saveObj, "", "  ")
	if err != nil {
		return fmt.Errorf("JSONシリアライズエラー: %w", err)
	}

	if err := os.WriteFile(dataFile, raw, 0644); err != nil {
		return fmt.Errorf("データ保存エラー: %w", err)
	}

	return nil
}
