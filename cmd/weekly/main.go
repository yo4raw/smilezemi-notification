// スマイルゼミ 週間レポート通知エントリポイント
package main

import (
	"log"
	"os"
	"time"

	"github.com/yo4raw/smilezemi-notification/internal/auth"
	"github.com/yo4raw/smilezemi-notification/internal/browser"
	"github.com/yo4raw/smilezemi-notification/internal/config"
	"github.com/yo4raw/smilezemi-notification/internal/crawler"
	"github.com/yo4raw/smilezemi-notification/internal/notifier"
)

func main() {
	exitCode := run()
	os.Exit(exitCode)
}

func run() int {
	log.Println("🚀 スマイルゼミ 週間レポート通知 開始")

	// 1. 設定の読み込み
	log.Println("📋 設定を読み込んでいます...")
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Printf("❌ 設定の読み込みに失敗しました: %v", err)
		return 1
	}
	log.Println("✅ 設定の読み込みが完了しました")

	// 2. chromedpブラウザの起動
	log.Println("🌐 ブラウザを起動しています...")
	ctx, cancel := browser.NewContext(5 * time.Minute)
	defer cancel()
	log.Println("✅ ブラウザの起動が完了しました")

	// 3. ログイン
	log.Println("🔐 ログインしています...")
	loginOpts := auth.DefaultLoginOptions()
	if err := auth.Login(ctx, cfg, loginOpts); err != nil {
		log.Printf("❌ ログインに失敗しました: %v", err)
		return 1
	}
	log.Println("✅ ログインが完了しました")

	// 4. 全ユーザーの週間レポート取得
	log.Println("📊 週間レポートを取得しています...")
	reports, err := crawler.GetAllUsersWeeklyReport(ctx)
	if err != nil {
		log.Printf("❌ 週間レポートの取得に失敗しました: %v", err)
		return 1
	}
	log.Printf("✅ 週間レポートの取得が完了しました（%d件）", len(reports))

	// 5. ドライラン確認
	if os.Getenv("DRY_RUN") == "true" {
		message := notifier.FormatWeeklyReport(reports)
		log.Println("\n📋 === 通知メッセージプレビュー ===")
		log.Println(message)
		log.Println("=== プレビュー終了 ===")
		log.Println("ℹ️ ドライランモード: LINE通知はスキップしました")
		log.Println("🎉 処理が正常に完了しました")
		return 0
	}

	// 6. メッセージフォーマットとLINE通知
	log.Println("📤 LINE通知を送信しています...")
	message := notifier.FormatWeeklyReport(reports)

	lineClient := notifier.NewLineClient(cfg.LineChannelAccessToken, cfg.LineUserID)
	sendOpts := notifier.DefaultSendOptions()
	if err := lineClient.Send(message, sendOpts); err != nil {
		log.Printf("❌ LINE通知の送信に失敗しました: %v", err)
		return 1
	}
	log.Println("✅ 週間レポートのLINE通知が完了しました")

	log.Println("🎉 処理が正常に完了しました")
	return 0
}
