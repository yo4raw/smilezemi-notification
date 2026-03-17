// Package config は環境変数管理とシークレット処理を提供する。
package config

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// requiredSecrets は必須環境変数のリスト。
var requiredSecrets = []string{
	"SMILEZEMI_USERNAME",
	"SMILEZEMI_PASSWORD",
	"LINE_CHANNEL_ACCESS_TOKEN",
	"LINE_USER_ID",
}

// マスキング用の正規表現（パッケージレベルで一度だけコンパイル）
var (
	rePassword = regexp.MustCompile(`(?i)password=[\w]+`)
	reToken    = regexp.MustCompile(`(?i)token=[\w]+`)
)

// sensitiveFields はマスキング対象のフィールド名パターン。
var sensitiveFields = []string{
	"password",
	"token",
	"channelaccesstoken",
	"accesstoken",
	"secret",
	"key",
}

// Config はアプリケーション設定を保持する。
type Config struct {
	SmilezemiUsername     string
	SmilezemiPassword     string
	LineChannelAccessToken string
	LineUserID            string
}

// ValidationResult はシークレット検証の結果を表す。
type ValidationResult struct {
	Valid   bool
	Missing []string
}

// LoadConfig は環境変数から設定をロードする。
// 必須環境変数が欠落している場合はエラーを返す。
func LoadConfig() (*Config, error) {
	secrets := map[string]string{
		"SMILEZEMI_USERNAME":       strings.TrimSpace(os.Getenv("SMILEZEMI_USERNAME")),
		"SMILEZEMI_PASSWORD":       strings.TrimSpace(os.Getenv("SMILEZEMI_PASSWORD")),
		"LINE_CHANNEL_ACCESS_TOKEN": strings.TrimSpace(os.Getenv("LINE_CHANNEL_ACCESS_TOKEN")),
		"LINE_USER_ID":             strings.TrimSpace(os.Getenv("LINE_USER_ID")),
	}

	result := ValidateSecrets(secrets)
	if !result.Valid {
		return nil, fmt.Errorf("必須環境変数が設定されていません: %s", strings.Join(result.Missing, ", "))
	}

	return &Config{
		SmilezemiUsername:      secrets["SMILEZEMI_USERNAME"],
		SmilezemiPassword:      secrets["SMILEZEMI_PASSWORD"],
		LineChannelAccessToken: secrets["LINE_CHANNEL_ACCESS_TOKEN"],
		LineUserID:             secrets["LINE_USER_ID"],
	}, nil
}

// ValidateSecrets はシークレットの存在を検証する。
func ValidateSecrets(secrets map[string]string) ValidationResult {
	var missing []string

	for _, key := range requiredSecrets {
		val, ok := secrets[key]
		if !ok || strings.TrimSpace(val) == "" {
			missing = append(missing, key)
		}
	}

	return ValidationResult{
		Valid:   len(missing) == 0,
		Missing: missing,
	}
}

// MaskSensitiveString は文字列中のパスワード・トークンパターンをマスキングする。
func MaskSensitiveString(data string) string {
	masked := data
	masked = rePassword.ReplaceAllString(masked, "password=***")
	masked = reToken.ReplaceAllString(masked, "token=***")
	return masked
}

// MaskSensitiveMap はマップ中のセンシティブフィールドをマスキングする。
func MaskSensitiveMap(data map[string]string) map[string]string {
	masked := make(map[string]string, len(data))
	for k, v := range data {
		lowerKey := strings.ToLower(k)
		isSensitive := false
		for _, field := range sensitiveFields {
			if strings.Contains(lowerKey, field) {
				isSensitive = true
				break
			}
		}
		if isSensitive {
			masked[k] = "***"
		} else {
			masked[k] = v
		}
	}
	return masked
}
