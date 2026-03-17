// スマイルゼミ クローラー - 日次通知エントリポイント
package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/yo4raw/smilezemi-notification/internal/auth"
	"github.com/yo4raw/smilezemi-notification/internal/browser"
	"github.com/yo4raw/smilezemi-notification/internal/config"
	"github.com/yo4raw/smilezemi-notification/internal/crawler"
	"github.com/yo4raw/smilezemi-notification/internal/data"
	"github.com/yo4raw/smilezemi-notification/internal/notifier"
)

func main() {
	exitCode := run()
	os.Exit(exitCode)
}

func run() int {
	log.Println("🚀 スマイルゼミ クローラー開始")

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

	// 4. 前回データの読み込み
	log.Println("📊 前回データを読み込んでいます...")
	const dataPath = "mission_data.json"
	previousData, err := data.LoadPreviousData(dataPath)
	if err != nil {
		log.Printf("⚠️ 前回データの読み込みに失敗しました: %v", err)
		log.Println("ℹ️ 初回実行として続行します")
		previousData = nil
	} else {
		log.Printf("✅ 前回データの読み込みが完了しました（%d件）", len(previousData))
	}

	// 5. 詳細データ取得
	log.Println("🔍 詳細データを取得しています...")
	currentData, err := crawler.GetAllUsersDetailedData(ctx)
	if err != nil {
		log.Printf("❌ クローリングに失敗しました: %v", err)

		// グレースフルデグラデーション: 基本通知のみ送信
		sendErrorNotification(cfg)
		return 1
	}
	log.Printf("✅ 詳細データの取得が完了しました（%d件）", len(currentData))

	// 6. データ比較
	log.Println("🔄 データを比較しています...")
	missionChanges := data.CompareMissionDetails(previousData, currentData)

	// 7. メッセージフォーマットとLINE通知
	log.Println("📤 LINE通知を送信しています...")
	message := notifier.FormatDetailedMessage(currentData, &missionChanges)
	message = notifier.TruncateToLimit(message)

	lineClient := notifier.NewLineClient(cfg.LineChannelAccessToken, cfg.LineUserID)
	sendOpts := notifier.DefaultSendOptions()
	if err := lineClient.Send(message, sendOpts); err != nil {
		log.Printf("❌ LINE通知の送信に失敗しました: %v", err)
		log.Println("⚠️ 通知失敗のため、データ保存をスキップします（次回再送のため差分を保持）")
		return 1
	}
	log.Println("✅ 詳細モードでのLINE通知が完了しました")

	// 8. データ保存（通知成功時のみ）
	log.Println("💾 データを保存しています...")
	if err := data.SaveData(dataPath, currentData); err != nil {
		log.Printf("❌ データの保存に失敗しました: %v", err)
	} else {
		log.Println("✅ データの保存が完了しました")
	}

	log.Println("🎉 処理が正常に完了しました")
	return 0
}

// sendErrorNotification はエラー時に簡易通知を送信する。
func sendErrorNotification(cfg *config.Config) {
	lineClient := notifier.NewLineClient(cfg.LineChannelAccessToken, cfg.LineUserID)
	sendOpts := notifier.DefaultSendOptions()

	msg := fmt.Sprintf("⚠️ スマイルゼミクローラーでエラーが発生しました\n日時: %s", time.Now().Format("2006-01-02 15:04:05"))
	if err := lineClient.Send(msg, sendOpts); err != nil {
		log.Printf("❌ エラー通知の送信にも失敗しました: %v", err)
	}
}
