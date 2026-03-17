// Package auth はみまもるネットの認証（ログイン）機能を提供する。
package auth

import (
	"context"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"github.com/chromedp/chromedp"

	"github.com/yo4raw/smilezemi-notification/internal/config"
	"github.com/yo4raw/smilezemi-notification/internal/crawler"
)

// LoginOptions はログインオプション。
type LoginOptions struct {
	MaxRetries int
	RetryDelay time.Duration
}

// DefaultLoginOptions はデフォルトのログインオプション。
func DefaultLoginOptions() LoginOptions {
	return LoginOptions{
		MaxRetries: 3,
		RetryDelay: 2 * time.Second,
	}
}

// Login はみまもるネットにログインする。
// 成功時はchromedpコンテキストをそのまま使い続ける。
func Login(ctx context.Context, cfg *config.Config, opts LoginOptions) error {
	if cfg.SmilezemiUsername == "" || cfg.SmilezemiPassword == "" {
		return fmt.Errorf("必須パラメータが欠けています: username と password が必要です")
	}

	var lastErr error
	for attempt := 1; attempt <= opts.MaxRetries; attempt++ {
		err := attemptLogin(ctx, cfg)
		if err == nil {
			return nil
		}

		lastErr = err
		maskedErr := maskPasswordInError(err.Error(), cfg.SmilezemiPassword)

		// 認証失敗はリトライしない
		if strings.Contains(err.Error(), "認証失敗") {
			return fmt.Errorf("%s", maskedErr)
		}

		log.Printf("ログイン試行 %d/%d 失敗: %s", attempt, opts.MaxRetries, maskedErr)

		if attempt < opts.MaxRetries {
			delay := time.Duration(math.Pow(2, float64(attempt-1))) * opts.RetryDelay
			time.Sleep(delay)
		}
	}

	maskedErr := maskPasswordInError(lastErr.Error(), cfg.SmilezemiPassword)
	return fmt.Errorf("ログイン失敗（%d回試行）: %s", opts.MaxRetries, maskedErr)
}

// attemptLogin は1回のログイン試行を行う。
func attemptLogin(ctx context.Context, cfg *config.Config) error {
	// ログインページにアクセス
	if err := chromedp.Run(ctx,
		chromedp.Navigate(crawler.LoginURL),
		chromedp.Sleep(crawler.StabilizationDelay),
	); err != nil {
		if strings.Contains(err.Error(), "Timeout") || strings.Contains(err.Error(), "timeout") {
			return fmt.Errorf("タイムアウトエラー: ページの読み込みに時間がかかりすぎました - %w", err)
		}
		if strings.Contains(err.Error(), "net::") || strings.Contains(err.Error(), "connection") {
			return fmt.Errorf("ネットワークエラー: サーバーに接続できません - %w", err)
		}
		return fmt.Errorf("ログインページアクセスエラー: %w", err)
	}

	// フォーム入力してログイン
	if err := chromedp.Run(ctx,
		// ユーザー名入力
		chromedp.WaitVisible(crawler.UsernameField),
		chromedp.Clear(crawler.UsernameField),
		chromedp.SendKeys(crawler.UsernameField, cfg.SmilezemiUsername),
		// パスワード入力
		chromedp.Clear(crawler.PasswordField),
		chromedp.SendKeys(crawler.PasswordField, cfg.SmilezemiPassword),
		// ログインボタンをクリック（テキストベースで検索）
		chromedp.Click(`button`, chromedp.ByQuery, chromedp.NodeVisible),
	); err != nil {
		return fmt.Errorf("フォーム入力エラー: %w", err)
	}

	// ログインボタンをJavaScriptで特定してクリック
	if err := chromedp.Run(ctx,
		chromedp.Evaluate(`
			(() => {
				const buttons = document.querySelectorAll('button');
				for (const btn of buttons) {
					if (btn.textContent.includes('ログイン')) {
						btn.click();
						return true;
					}
				}
				// フォームをsubmit
				const form = document.querySelector('form');
				if (form) {
					form.submit();
					return true;
				}
				return false;
			})()
		`, nil),
		chromedp.Sleep(crawler.UserSwitchDelay),
	); err != nil {
		return fmt.Errorf("ログインボタンクリックエラー: %w", err)
	}

	// ページ遷移を待機
	if err := chromedp.Run(ctx,
		chromedp.WaitReady("body"),
		chromedp.Sleep(crawler.StabilizationDelay),
	); err != nil {
		return fmt.Errorf("ページ遷移待機エラー: %w", err)
	}

	// ログイン成功判定: URLが /login を含まなければ成功
	var currentURL string
	if err := chromedp.Run(ctx, chromedp.Location(&currentURL)); err != nil {
		return fmt.Errorf("URL取得エラー: %w", err)
	}

	if strings.Contains(currentURL, "/login") {
		return fmt.Errorf("認証失敗: ログイン情報が正しくありません")
	}

	log.Printf("✅ ログイン成功: %s", currentURL)
	return nil
}

// maskPasswordInError はエラーメッセージからパスワードを除去する。
func maskPasswordInError(errMsg, password string) string {
	if password == "" {
		return errMsg
	}
	masked := strings.ReplaceAll(errMsg, password, "***")
	masked = config.MaskSensitiveString(masked)
	return masked
}
