package auth

import (
	"strings"
	"testing"
	"time"
)

func TestMaskPasswordInError_NonEmptyPassword(t *testing.T) {
	password := "mysecretpass"
	errMsg := "ログインエラー: mysecretpass が一致しません"

	result := maskPasswordInError(errMsg, password)
	if strings.Contains(result, password) {
		t.Errorf("password should be masked, got: %s", result)
	}
	if !strings.Contains(result, "***") {
		t.Errorf("masked message should contain ***, got: %s", result)
	}
}

func TestMaskPasswordInError_EmptyPassword(t *testing.T) {
	errMsg := "何らかのエラーが発生しました"

	result := maskPasswordInError(errMsg, "")
	if result != errMsg {
		t.Errorf("empty password: expected original message %q, got %q", errMsg, result)
	}
}

func TestDefaultLoginOptions(t *testing.T) {
	opts := DefaultLoginOptions()

	if opts.MaxRetries != 3 {
		t.Errorf("expected MaxRetries=3, got %d", opts.MaxRetries)
	}
	if opts.RetryDelay != 2*time.Second {
		t.Errorf("expected RetryDelay=2s, got %v", opts.RetryDelay)
	}
}
