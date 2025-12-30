#!/usr/bin/env node
/**
 * スクリーンショット付き検証スクリプト
 * 各段階でスクリーンショットを撮影しながらデータ取得を検証
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { login } = require('../src/auth');
const { getAllUsersDetailedData } = require('../src/crawler');
const { loadConfig } = require('../src/config');
const fs = require('fs');
const path = require('path');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📸 スクリーンショット付き検証開始');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

async function runVerification() {
  let browser;
  let context;
  let page;

  const screenshotsDir = path.join(__dirname, '../screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let screenshotCounter = 1;

  async function takeScreenshot(name) {
    const filename = `${timestamp}_${String(screenshotCounter).padStart(2, '0')}_${name}.png`;
    const filepath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`📸 スクリーンショット保存: ${filename}`);
    screenshotCounter++;
    return filename;
  }

  try {
    // 1. 設定読み込み
    console.log('📋 設定を読み込んでいます...');
    const config = loadConfig();
    console.log('✅ 設定読み込み完了\n');

    // 2. ブラウザ起動
    console.log('🌐 ブラウザを起動しています...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    console.log('✅ ブラウザ起動完了\n');

    // 3. ログイン
    console.log('🔐 ログイン処理を実行しています...');
    const loginResult = await login(browser, {
      username: config.SMILEZEMI_USERNAME,
      password: config.SMILEZEMI_PASSWORD
    });

    if (!loginResult.success) {
      throw new Error(`ログイン失敗: ${loginResult.error}`);
    }

    page = loginResult.page;
    context = loginResult.context;
    console.log('✅ ログイン完了\n');

    await page.waitForTimeout(2000);
    await takeScreenshot('01_login_success');

    // 4. 現在の画面（ログイン後はみまもるトーク画面）
    console.log('📊 現在のページを確認中...');
    const currentUrl = page.url();
    console.log(`   現在のURL: ${currentUrl}`);
    await page.waitForTimeout(2000);
    console.log('✅ ページ確認完了\n');

    await takeScreenshot('02_current_screen');

    // 6. 詳細データ取得
    console.log('🔍 詳細データ取得を実行しています...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const crawlResult = await getAllUsersDetailedData(page);

    if (!crawlResult.success) {
      throw new Error(`データ取得失敗: ${crawlResult.error}`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ データ取得完了\n');

    await takeScreenshot('03_after_data_collection');

    // 7. 取得データの表示
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 取得データサマリー');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    crawlResult.data.forEach((user, index) => {
      console.log(`👤 ユーザー ${index + 1}: ${user.userName}`);
      console.log(`   ⏱️  勉強時間: ${user.studyTime.hours}時間${user.studyTime.minutes}分`);
      console.log(`   ✅ 完了ミッション: ${user.missionCount}件`);
      console.log(`   💯 合計点数: ${user.totalScore}点`);
      console.log(`   📋 ミッション詳細 (${user.missions.length}件):`);

      user.missions.forEach((mission, mIndex) => {
        const status = mission.completed ? '✅' : '⏳';
        const scoreDisplay = mission.score > 0 ? `${mission.score}点` : '未実施';
        console.log(`      ${status} [${mIndex + 1}] ${mission.name}: ${scoreDisplay}`);
      });
      console.log();
    });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 検証完了');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('📸 保存されたスクリーンショット:');
    console.log(`   1. ${timestamp}_01_login_success.png - ログイン成功画面`);
    console.log(`   2. ${timestamp}_02_current_screen.png - みまもるトーク画面`);
    console.log(`   3. ${timestamp}_03_after_data_collection.png - データ取得完了後\n`);

  } catch (error) {
    console.error('❌ エラー発生:', error.message);
    console.error(error.stack);

    if (page) {
      const errorScreenshot = `${timestamp}_ERROR.png`;
      await page.screenshot({
        path: path.join(screenshotsDir, errorScreenshot),
        fullPage: true
      });
      console.log(`📸 エラー時スクリーンショット: ${errorScreenshot}`);
    }

    process.exit(1);
  } finally {
    // ブラウザクリーンアップ
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

// 実行
runVerification().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
