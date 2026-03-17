package data

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadPreviousData_ValidFile(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "mission_data.json")

	testData := MissionData{
		Version:   "2.0",
		Timestamp: "2025-12-24T09:00:00.000Z",
		Users: []UserData{
			{UserName: "太郎", MissionCount: 5, Date: "2025-12-24"},
			{UserName: "花子", MissionCount: 3, Date: "2025-12-24"},
		},
	}
	raw, _ := json.MarshalIndent(testData, "", "  ")
	os.WriteFile(dataFile, raw, 0644)

	users, err := LoadPreviousData(dataFile)
	if err != nil {
		t.Fatalf("LoadPreviousData() returned error: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("expected 2 users, got %d", len(users))
	}
	if users[0].UserName != "太郎" {
		t.Errorf("expected 太郎, got %s", users[0].UserName)
	}
	if users[0].MissionCount != 5 {
		t.Errorf("expected missionCount 5, got %d", users[0].MissionCount)
	}
}

func TestLoadPreviousData_FileNotExist(t *testing.T) {
	users, err := LoadPreviousData("/tmp/nonexistent_test_file.json")
	if err != nil {
		t.Fatalf("LoadPreviousData() should not error for missing file: %v", err)
	}
	if len(users) != 0 {
		t.Errorf("expected empty slice, got %d users", len(users))
	}
}

func TestLoadPreviousData_V1Migration(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "mission_data.json")

	v1Data := map[string]interface{}{
		"version":   "1.0",
		"timestamp": "2025-12-24T09:00:00.000Z",
		"users": []map[string]interface{}{
			{"userName": "太郎", "missionCount": 5, "date": "2025-12-24"},
		},
	}
	raw, _ := json.MarshalIndent(v1Data, "", "  ")
	os.WriteFile(dataFile, raw, 0644)

	users, err := LoadPreviousData(dataFile)
	if err != nil {
		t.Fatalf("LoadPreviousData() returned error: %v", err)
	}
	if len(users) != 1 {
		t.Fatalf("expected 1 user, got %d", len(users))
	}
	// v1→v2移行でstudyTime, totalScore, missionsが初期化される
	if users[0].StudyTime.Hours != 0 || users[0].StudyTime.Minutes != 0 {
		t.Errorf("studyTime should be zeroed after migration")
	}
	if users[0].TotalScore != 0 {
		t.Errorf("totalScore should be 0 after migration")
	}
	if len(users[0].Missions) != 0 {
		t.Errorf("missions should be empty after migration")
	}
}

func TestLoadPreviousData_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "mission_data.json")
	os.WriteFile(dataFile, []byte("{ invalid json }"), 0644)

	_, err := LoadPreviousData(dataFile)
	if err == nil {
		t.Fatal("LoadPreviousData() should return error for invalid JSON")
	}
}

func TestLoadPreviousData_UnknownVersion(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "mission_data.json")

	unknownData := map[string]interface{}{
		"version": "99.0",
		"users":   []interface{}{},
	}
	raw, _ := json.MarshalIndent(unknownData, "", "  ")
	os.WriteFile(dataFile, raw, 0644)

	_, err := LoadPreviousData(dataFile)
	if err == nil {
		t.Fatal("LoadPreviousData() should return error for unknown version")
	}
}

func TestCompareData_Increase(t *testing.T) {
	prev := []UserData{{UserName: "太郎", MissionCount: 5}}
	curr := []UserData{{UserName: "太郎", MissionCount: 8}}

	changes := CompareData(prev, curr)
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}
	if changes[0].Type != "increase" {
		t.Errorf("expected type increase, got %s", changes[0].Type)
	}
	if changes[0].Diff != 3 {
		t.Errorf("expected diff 3, got %d", changes[0].Diff)
	}
}

func TestCompareData_Decrease(t *testing.T) {
	prev := []UserData{{UserName: "花子", MissionCount: 10}}
	curr := []UserData{{UserName: "花子", MissionCount: 7}}

	changes := CompareData(prev, curr)
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}
	if changes[0].Type != "decrease" {
		t.Errorf("expected type decrease, got %s", changes[0].Type)
	}
	if changes[0].Diff != -3 {
		t.Errorf("expected diff -3, got %d", changes[0].Diff)
	}
}

func TestCompareData_NoChange(t *testing.T) {
	prev := []UserData{
		{UserName: "太郎", MissionCount: 5},
		{UserName: "花子", MissionCount: 3},
	}
	curr := []UserData{
		{UserName: "太郎", MissionCount: 5},
		{UserName: "花子", MissionCount: 3},
	}

	changes := CompareData(prev, curr)
	if len(changes) != 0 {
		t.Errorf("expected no changes, got %d", len(changes))
	}
}

func TestCompareData_NewUser(t *testing.T) {
	prev := []UserData{{UserName: "太郎", MissionCount: 5}}
	curr := []UserData{
		{UserName: "太郎", MissionCount: 5},
		{UserName: "次郎", MissionCount: 2},
	}

	changes := CompareData(prev, curr)
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}
	if changes[0].UserName != "次郎" {
		t.Errorf("expected userName 次郎, got %s", changes[0].UserName)
	}
	if changes[0].Type != "new" {
		t.Errorf("expected type new, got %s", changes[0].Type)
	}
	if changes[0].PreviousCount != 0 {
		t.Errorf("expected previousCount 0, got %d", changes[0].PreviousCount)
	}
}

func TestCompareData_EmptyPrevious(t *testing.T) {
	prev := []UserData{}
	curr := []UserData{{UserName: "太郎", MissionCount: 5}}

	changes := CompareData(prev, curr)
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}
	if changes[0].Type != "new" {
		t.Errorf("expected type new, got %s", changes[0].Type)
	}
}

func TestCompareData_MultipleChanges(t *testing.T) {
	prev := []UserData{
		{UserName: "太郎", MissionCount: 5},
		{UserName: "花子", MissionCount: 3},
	}
	curr := []UserData{
		{UserName: "太郎", MissionCount: 8},
		{UserName: "花子", MissionCount: 2},
	}

	changes := CompareData(prev, curr)
	if len(changes) != 2 {
		t.Errorf("expected 2 changes, got %d", len(changes))
	}
}

func TestCompareMissionDetails_NewUser(t *testing.T) {
	prev := []UserData{}
	curr := []UserData{
		{
			UserName: "太郎",
			Missions: []Mission{
				{Name: "算数", Score: 100, Completed: true},
			},
		},
	}

	result := CompareMissionDetails(prev, curr)
	if len(result.UserChanges) != 1 {
		t.Fatalf("expected 1 user change, got %d", len(result.UserChanges))
	}
	if result.UserChanges[0].MissionChanges[0].Type != "new_mission" {
		t.Errorf("expected new_mission, got %s", result.UserChanges[0].MissionChanges[0].Type)
	}
}

func TestCompareMissionDetails_ScoreChange(t *testing.T) {
	prev := []UserData{
		{
			UserName: "太郎",
			Missions: []Mission{{Name: "算数", Score: 80, Completed: true}},
		},
	}
	curr := []UserData{
		{
			UserName: "太郎",
			Missions: []Mission{{Name: "算数", Score: 100, Completed: true}},
		},
	}

	result := CompareMissionDetails(prev, curr)
	if len(result.UserChanges) != 1 {
		t.Fatalf("expected 1 user change, got %d", len(result.UserChanges))
	}
	mc := result.UserChanges[0].MissionChanges[0]
	if mc.Type != "score_change" {
		t.Errorf("expected score_change, got %s", mc.Type)
	}
	if mc.PreviousScore != 80 {
		t.Errorf("expected previousScore 80, got %d", mc.PreviousScore)
	}
	if mc.CurrentScore != 100 {
		t.Errorf("expected currentScore 100, got %d", mc.CurrentScore)
	}
	if mc.ScoreChange != 20 {
		t.Errorf("expected scoreChange 20, got %d", mc.ScoreChange)
	}
}

func TestCompareMissionDetails_NoChange(t *testing.T) {
	prev := []UserData{
		{
			UserName: "太郎",
			Missions: []Mission{{Name: "算数", Score: 100, Completed: true}},
		},
	}
	curr := []UserData{
		{
			UserName: "太郎",
			Missions: []Mission{{Name: "算数", Score: 100, Completed: true}},
		},
	}

	result := CompareMissionDetails(prev, curr)
	if len(result.UserChanges) != 1 {
		t.Fatalf("expected 1 user change, got %d", len(result.UserChanges))
	}
	if result.UserChanges[0].MissionChanges[0].Type != "no_change" {
		t.Errorf("expected no_change, got %s", result.UserChanges[0].MissionChanges[0].Type)
	}
}

func TestSaveData(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "data", "mission_data.json")

	users := []UserData{
		{UserName: "太郎", MissionCount: 5, Date: "2025-12-25"},
		{UserName: "花子", MissionCount: 3, Date: "2025-12-25"},
	}

	err := SaveData(dataFile, users)
	if err != nil {
		t.Fatalf("SaveData() returned error: %v", err)
	}

	// ファイルを読み込んで検証
	raw, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("failed to read saved file: %v", err)
	}

	var saved MissionData
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatalf("failed to unmarshal saved data: %v", err)
	}

	if saved.Version != "2.0" {
		t.Errorf("expected version 2.0, got %s", saved.Version)
	}
	if saved.Timestamp == "" {
		t.Error("timestamp should not be empty")
	}
	if len(saved.Users) != 2 {
		t.Errorf("expected 2 users, got %d", len(saved.Users))
	}
	if saved.Users[0].UserName != "太郎" {
		t.Errorf("expected 太郎, got %s", saved.Users[0].UserName)
	}
}

func TestSaveData_EmptySlice(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "mission_data.json")

	err := SaveData(dataFile, []UserData{})
	if err != nil {
		t.Fatalf("SaveData() returned error: %v", err)
	}

	raw, _ := os.ReadFile(dataFile)
	var saved MissionData
	json.Unmarshal(raw, &saved)

	if len(saved.Users) != 0 {
		t.Errorf("expected 0 users, got %d", len(saved.Users))
	}
}

// LoadPreviousData: バージョンフィールドが存在するが文字列でない場合（Unmarshal失敗→フォールバック）
func TestLoadPreviousData_NonStringVersion(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "mission_data.json")

	// versionフィールドに数値を入れるとjson.Unmarshal(&version)が失敗し、
	// コードはフォールバックとして"1.0"扱いになる
	raw := []byte(`{"version": 123, "users": [{"userName": "太郎", "missionCount": 2, "date": "2025-12-24"}]}`)
	os.WriteFile(dataFile, raw, 0644)

	users, err := LoadPreviousData(dataFile)
	if err != nil {
		t.Fatalf("LoadPreviousData() should not error when version unmarshal fails: %v", err)
	}
	// バージョン"1.0"扱いでv1→v2マイグレーションが走る
	if len(users) != 1 {
		t.Fatalf("expected 1 user, got %d", len(users))
	}
	if users[0].UserName != "太郎" {
		t.Errorf("expected 太郎, got %s", users[0].UserName)
	}
}

// LoadPreviousData: JSONに"users"キーが存在しない場合
func TestLoadPreviousData_MissingUsersKey(t *testing.T) {
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "mission_data.json")

	raw := []byte(`{"version": "2.0", "timestamp": "2025-12-24T09:00:00Z"}`)
	os.WriteFile(dataFile, raw, 0644)

	users, err := LoadPreviousData(dataFile)
	if err != nil {
		t.Fatalf("LoadPreviousData() should not error when users key is missing: %v", err)
	}
	if len(users) != 0 {
		t.Errorf("expected empty slice, got %d users", len(users))
	}
}

// SaveData: MkdirAllが失敗するケース（ファイルをディレクトリとして使おうとする）
func TestSaveData_MkdirAllFails(t *testing.T) {
	dir := t.TempDir()
	// 通常のファイルを先に作成し、そのパスをディレクトリとして使おうとさせる
	blockingFile := filepath.Join(dir, "not_a_dir")
	if err := os.WriteFile(blockingFile, []byte("block"), 0644); err != nil {
		t.Fatalf("setup failed: %v", err)
	}

	// blockingFileをディレクトリとして扱うパスを指定 → MkdirAllが失敗するはず
	dataFile := filepath.Join(blockingFile, "mission_data.json")
	err := SaveData(dataFile, []UserData{})
	if err == nil {
		t.Fatal("SaveData() should return error when MkdirAll fails")
	}
}

// CompareMissionDetails: currentUser.Missionsがnilのユーザーはスキップされる
func TestCompareMissionDetails_NilMissionsSkipped(t *testing.T) {
	prev := []UserData{}
	curr := []UserData{
		{
			UserName: "太郎",
			Missions: nil, // nilはスキップ対象
		},
		{
			UserName: "花子",
			Missions: []Mission{{Name: "算数", Score: 90, Completed: true}},
		},
	}

	result := CompareMissionDetails(prev, curr)
	// 太郎はスキップされ、花子のみ結果に含まれる
	if len(result.UserChanges) != 1 {
		t.Fatalf("expected 1 user change (nil missions skipped), got %d", len(result.UserChanges))
	}
	if result.UserChanges[0].UserName != "花子" {
		t.Errorf("expected 花子, got %s", result.UserChanges[0].UserName)
	}
}

// CompareMissionDetails: 前回もミッションがあり、現在は変更なし（missionChangesが空になるケース）
func TestCompareMissionDetails_NoMissionChanges(t *testing.T) {
	prev := []UserData{
		{
			UserName: "太郎",
			Missions: []Mission{
				{Name: "算数", Score: 100, Completed: true},
				{Name: "国語", Score: 85, Completed: true},
			},
		},
	}
	// currentのミッションリストが空 → missionChangesは0件 → userChangesにも追加されない
	curr := []UserData{
		{
			UserName: "太郎",
			Missions: []Mission{},
		},
	}

	result := CompareMissionDetails(prev, curr)
	if len(result.UserChanges) != 0 {
		t.Fatalf("expected 0 user changes when current missions are empty, got %d", len(result.UserChanges))
	}
}
