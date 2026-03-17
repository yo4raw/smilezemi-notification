package config

import (
	"os"
	"testing"
)

func TestLoadConfig_AllEnvVarsSet(t *testing.T) {
	t.Setenv("SMILEZEMI_USERNAME", "testuser")
	t.Setenv("SMILEZEMI_PASSWORD", "testpass")
	t.Setenv("LINE_CHANNEL_ACCESS_TOKEN", "test_token")
	t.Setenv("LINE_USER_ID", "U1234567890")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() returned error: %v", err)
	}

	if cfg.SmilezemiUsername != "testuser" {
		t.Errorf("SmilezemiUsername = %q, want %q", cfg.SmilezemiUsername, "testuser")
	}
	if cfg.SmilezemiPassword != "testpass" {
		t.Errorf("SmilezemiPassword = %q, want %q", cfg.SmilezemiPassword, "testpass")
	}
	if cfg.LineChannelAccessToken != "test_token" {
		t.Errorf("LineChannelAccessToken = %q, want %q", cfg.LineChannelAccessToken, "test_token")
	}
	if cfg.LineUserID != "U1234567890" {
		t.Errorf("LineUserID = %q, want %q", cfg.LineUserID, "U1234567890")
	}
}

func TestLoadConfig_MissingEnvVars(t *testing.T) {
	// 環境変数をクリア
	os.Unsetenv("SMILEZEMI_USERNAME")
	os.Unsetenv("SMILEZEMI_PASSWORD")
	os.Unsetenv("LINE_CHANNEL_ACCESS_TOKEN")
	os.Unsetenv("LINE_USER_ID")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("LoadConfig() should return error when env vars are missing")
	}
}

func TestLoadConfig_PartialEnvVars(t *testing.T) {
	t.Setenv("SMILEZEMI_USERNAME", "testuser")
	os.Unsetenv("SMILEZEMI_PASSWORD")
	os.Unsetenv("LINE_CHANNEL_ACCESS_TOKEN")
	os.Unsetenv("LINE_USER_ID")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("LoadConfig() should return error when some env vars are missing")
	}

	// エラーメッセージに欠落した変数名が含まれることを確認
	errMsg := err.Error()
	if !contains(errMsg, "SMILEZEMI_PASSWORD") {
		t.Errorf("error message should contain SMILEZEMI_PASSWORD, got: %s", errMsg)
	}
}

func TestLoadConfig_TrimWhitespace(t *testing.T) {
	t.Setenv("SMILEZEMI_USERNAME", "  testuser  ")
	t.Setenv("SMILEZEMI_PASSWORD", "  testpass  ")
	t.Setenv("LINE_CHANNEL_ACCESS_TOKEN", "  test_token  ")
	t.Setenv("LINE_USER_ID", "  U123  ")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() returned error: %v", err)
	}

	if cfg.SmilezemiUsername != "testuser" {
		t.Errorf("SmilezemiUsername should be trimmed, got %q", cfg.SmilezemiUsername)
	}
}

func TestValidateSecrets_AllValid(t *testing.T) {
	secrets := map[string]string{
		"SMILEZEMI_USERNAME":       "testuser",
		"SMILEZEMI_PASSWORD":       "testpass",
		"LINE_CHANNEL_ACCESS_TOKEN": "token",
		"LINE_USER_ID":             "userid",
	}

	result := ValidateSecrets(secrets)
	if !result.Valid {
		t.Errorf("ValidateSecrets should be valid, missing: %v", result.Missing)
	}
	if len(result.Missing) != 0 {
		t.Errorf("Missing should be empty, got: %v", result.Missing)
	}
}

func TestValidateSecrets_MissingSecrets(t *testing.T) {
	secrets := map[string]string{
		"SMILEZEMI_USERNAME": "testuser",
	}

	result := ValidateSecrets(secrets)
	if result.Valid {
		t.Error("ValidateSecrets should be invalid")
	}
	if !containsStr(result.Missing, "SMILEZEMI_PASSWORD") {
		t.Error("Missing should contain SMILEZEMI_PASSWORD")
	}
	if !containsStr(result.Missing, "LINE_CHANNEL_ACCESS_TOKEN") {
		t.Error("Missing should contain LINE_CHANNEL_ACCESS_TOKEN")
	}
	if !containsStr(result.Missing, "LINE_USER_ID") {
		t.Error("Missing should contain LINE_USER_ID")
	}
}

func TestValidateSecrets_EmptyString(t *testing.T) {
	secrets := map[string]string{
		"SMILEZEMI_USERNAME":       "",
		"SMILEZEMI_PASSWORD":       "testpass",
		"LINE_CHANNEL_ACCESS_TOKEN": "token",
		"LINE_USER_ID":             "userid",
	}

	result := ValidateSecrets(secrets)
	if result.Valid {
		t.Error("ValidateSecrets should be invalid for empty string")
	}
	if !containsStr(result.Missing, "SMILEZEMI_USERNAME") {
		t.Error("Missing should contain SMILEZEMI_USERNAME")
	}
}

func TestMaskSensitiveString(t *testing.T) {
	tests := []struct {
		name  string
		input string
		check func(string) bool
	}{
		{
			name:  "パスワードをマスキング",
			input: "Logging in with password=secretpass123",
			check: func(s string) bool {
				return !contains(s, "secretpass123") && contains(s, "***")
			},
		},
		{
			name:  "トークンをマスキング",
			input: "Using token=mytoken456",
			check: func(s string) bool {
				return !contains(s, "mytoken456") && contains(s, "***")
			},
		},
		{
			name:  "センシティブでない文字列はそのまま",
			input: "Hello world",
			check: func(s string) bool {
				return s == "Hello world"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := MaskSensitiveString(tt.input)
			if !tt.check(result) {
				t.Errorf("MaskSensitiveString(%q) = %q", tt.input, result)
			}
		})
	}
}

func TestMaskSensitiveMap(t *testing.T) {
	data := map[string]string{
		"username":           "testuser",
		"password":           "pass123",
		"channelAccessToken": "token456",
		"userId":             "U123",
	}

	masked := MaskSensitiveMap(data)

	if masked["username"] != "testuser" {
		t.Errorf("username should not be masked, got %q", masked["username"])
	}
	if masked["password"] != "***" {
		t.Errorf("password should be masked, got %q", masked["password"])
	}
	if masked["channelAccessToken"] != "***" {
		t.Errorf("channelAccessToken should be masked, got %q", masked["channelAccessToken"])
	}
	if masked["userId"] != "U123" {
		t.Errorf("userId should not be masked, got %q", masked["userId"])
	}
}

// ヘルパー関数
func contains(s, substr string) bool {
	return len(s) >= len(substr) && containsSubstring(s, substr)
}

func containsSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func containsStr(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}
