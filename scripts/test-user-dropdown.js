#!/usr/bin/env node
/**
 * ユーザードロップダウンの操作テスト
 */

const { chromium } = require('playwright');
const selectors = require('../src/config/selectors');

async function testUserDropdown() {
  let browser, context, page;

  try {
    console.log('🔍 ユーザードロップダウンの操作テスト\n');

    const config = {
      SMILEZEMI_USERNAME: process.env.SMILEZEMI_USERNAME,
      SMILEZEMI_PASSWORD: process.env.SMILEZEMI_PASSWORD
    };

    // ブラウザを起動
    browser = await chromium.launch({
      headless: false,
      slowMo: 800 // ゆっくり操作
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    page = await context.newPage();

    // ログイン
    console.log('🔐 ログイン中...');
    await page.goto(selectors.login.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.fill(selectors.login.usernameField, config.SMILEZEMI_USERNAME);
    await page.fill(selectors.login.passwordField, config.SMILEZEMI_PASSWORD);
    await page.click(selectors.login.submitButton);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);
    console.log('✅ ログイン完了\n');

    // 現在のユーザー名を確認
    const currentUserText = await page.locator('div:has-text("さん")').first().textContent();
    console.log(`現在のユーザー: ${currentUserText.trim().split('\n')[0]}\n`);

    // 方法1: 画面右上のユーザー名が含まれる領域全体をクリック
    console.log('=== 方法1: ユーザー名領域をクリック ===');
    try {
      // 画面右上の「吉岡光志郎さん」を含むクリック可能な要素を探す
      const userArea = page.locator('div').filter({ hasText: '吉岡光志郎さん' }).first();

      await page.screenshot({ path: 'screenshots/test-before-click.png' });
      console.log('📸 クリック前のスクリーンショット保存');

      await userArea.click();
      console.log('✅ ユーザー名領域をクリックしました');

      await page.waitForTimeout(2000);

      await page.screenshot({ path: 'screenshots/test-after-click.png', fullPage: true });
      console.log('📸 クリック後のスクリーンショット保存\n');

    } catch (error) {
      console.log(`❌ 方法1失敗: ${error.message}\n`);
    }

    // ユーザー一覧が表示されているか確認
    console.log('=== ユーザー一覧の確認 ===');
    const userNames = ['吉岡光志郎さん', '吉岡千晴さん', '吉岡祥吾さん'];

    for (const userName of userNames) {
      const elements = await page.locator(`text="${userName}"`).all();
      console.log(`"${userName}": ${elements.length}件`);

      // 最初の要素が表示されているか確認
      if (elements.length > 0) {
        const isVisible = await elements[0].isVisible();
        console.log(`  表示状態: ${isVisible ? '表示' : '非表示'}`);
      }
    }

    // 方法2: ユーザー選択を直接クリック（ドロップダウンが開いている前提）
    console.log('\n=== 方法2: ユーザーを直接クリック ===');
    try {
      const targetUser = '吉岡千晴さん';
      console.log(`"${targetUser}"に切り替えます`);

      // すべての「吉岡千晴さん」要素を取得
      const chiharuElements = await page.locator(`text="${targetUser}"`).all();
      console.log(`見つかった要素数: ${chiharuElements.length}`);

      // 表示されている要素を探す
      for (let i = 0; i < chiharuElements.length; i++) {
        const isVisible = await chiharuElements[i].isVisible();
        console.log(`  要素[${i}]: ${isVisible ? '表示' : '非表示'}`);

        if (isVisible) {
          console.log(`  要素[${i}]をクリックします`);
          await chiharuElements[i].click();
          console.log(`✅ "${targetUser}"をクリックしました`);

          await page.waitForTimeout(3000);

          await page.screenshot({ path: 'screenshots/test-after-switch.png', fullPage: true });
          console.log('📸 切り替え後のスクリーンショット保存');

          // 現在のユーザーを確認
          const newUserText = await page.locator('div:has-text("さん")').first().textContent();
          console.log(`\n切り替え後のユーザー: ${newUserText.trim().split('\n')[0]}`);

          break;
        }
      }

    } catch (error) {
      console.log(`❌ 方法2失敗: ${error.message}\n`);
    }

    // 今日のミッション数を確認
    console.log('\n=== 今日のミッション数 ===');
    const today = new Date();
    const todayStr = `${today.getMonth() + 1}/${today.getDate()}`;
    console.log(`今日の日付: ${todayStr}`);

    const pageContent = await page.content();
    const todayIndex = pageContent.indexOf(todayStr);

    if (todayIndex !== -1) {
      const restContent = pageContent.substring(todayIndex);
      const nextDatePattern = /(\d+)\/(\d+)/g;
      const matches = restContent.match(nextDatePattern);

      let sectionContent;
      if (matches && matches.length > 1) {
        const nextDateIndex = restContent.indexOf(matches[1]);
        sectionContent = restContent.substring(0, nextDateIndex);
      } else {
        sectionContent = restContent.substring(0, 2000);
      }

      const missionMatches = sectionContent.match(/ミッション/g);
      const missionCount = missionMatches ? missionMatches.length : 0;

      console.log(`ミッション数: ${missionCount}\n`);
    } else {
      console.log('今日のデータが見つかりません\n');
    }

    // 30秒待機
    console.log('⏳ 30秒待機します（ブラウザで確認してください）...');
    await page.waitForTimeout(30000);

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n✅ ブラウザを閉じました');
  }
}

testUserDropdown().catch(error => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
