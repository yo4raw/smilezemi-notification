/**
 * コース切り替えと日付ロジックのデバッグスクリプト
 */

const { chromium } = require('playwright');
const { login } = require('../src/auth');
const { getAllUsersDetailedData } = require('../src/crawler');

async function debugCourseSwitchAndDate() {
  let browser;
  let page;

  try {
    console.log('🚀 デバッグスクリプト開始\n');

    // ブラウザ起動
    browser = await chromium.launch({
      headless: true, // Docker環境ではヘッドレスモード必須
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    page = await context.newPage();

    // ログイン
    console.log('🔐 ログイン中...');
    const loginResult = await login(page);

    if (!loginResult.success) {
      console.error(`❌ ログイン失敗: ${loginResult.error}`);
      return;
    }

    console.log('✅ ログイン成功\n');

    // 初期画面のスクリーンショット
    await page.screenshot({
      path: 'screenshots/debug-01-initial.png',
      fullPage: true
    });
    console.log('📸 スクリーンショット: debug-01-initial.png\n');

    // 全ユーザーのデータ取得（詳細デバッグログ付き）
    console.log('👥 全ユーザーのデータ取得開始...\n');
    const result = await getAllUsersDetailedData(page);

    // 結果表示
    console.log('\n📊 取得結果:');
    console.log('Success:', result.success);
    console.log('Details Available:', result.detailsAvailable);
    console.log('Partial Failure:', result.partialFailure);

    if (result.success && result.data) {
      console.log('\n📋 取得データ:');
      result.data.forEach((user, index) => {
        console.log(`\n  [${index + 1}] ${user.userName}`);
        console.log(`      日付: ${user.date}`);
        console.log(`      ミッション数: ${user.missionCount}`);
        console.log(`      勉強時間: ${user.studyTime.hours}h${user.studyTime.minutes}m`);
        console.log(`      合計点数: ${user.totalScore}点`);
        console.log(`      ミッション詳細: ${user.missions.length}件`);

        if (user.missions.length > 0) {
          user.missions.forEach((mission, mIdx) => {
            console.log(`        [${mIdx + 1}] ${mission.name}: ${mission.score}点 (${mission.completed ? '完了' : '未完了'})`);
          });
        }
      });
    }

    // 最終画面のスクリーンショット
    await page.screenshot({
      path: 'screenshots/debug-99-final.png',
      fullPage: true
    });
    console.log('\n📸 スクリーンショット: debug-99-final.png');

    console.log('\n✅ デバッグスクリプト完了');

    // 結果確認のため10秒待機
    console.log('\n⏱️  10秒後にブラウザを閉じます...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('\n❌ エラー発生:', error);

    // エラー時のスクリーンショット
    if (page) {
      await page.screenshot({
        path: 'screenshots/debug-error.png',
        fullPage: true
      }).catch(() => {});
      console.log('📸 エラースクリーンショット: debug-error.png');
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// 実行
debugCourseSwitchAndDate().catch(console.error);
