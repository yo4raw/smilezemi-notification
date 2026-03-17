// Package browser はchromedpブラウザの初期化と共通設定を提供する。
package browser

import (
	"context"
	"time"

	"github.com/chromedp/chromedp"
)

// NewContext はヘッドレスChromiumブラウザのコンテキストを生成する。
// 返されるcancelFuncを必ずdeferで呼び出すこと。
func NewContext(timeout time.Duration) (context.Context, context.CancelFunc) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-setuid-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("headless", true),
		chromedp.Flag("ignore-certificate-errors", true),
	)

	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)

	ctx, ctxCancel := chromedp.NewContext(allocCtx)

	ctx, timeoutCancel := context.WithTimeout(ctx, timeout)

	cancel := func() {
		timeoutCancel()
		ctxCancel()
		allocCancel()
	}

	return ctx, cancel
}
