#!/usr/bin/env node
/**
 * 全ユーザーのミッション数確認 - 最終版
 */

const { chromium } = require('playwright');
const selectors = require('../src/config/selectors');

function getTodayDate() {
  const today = new Date();
  return `${today.getMonth() + 1}/${today.getDate()}`;
}

async function login(page, username, password) {
  console.log('🔐 ログイン中...');
  await page.goto(selectors.login.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.fill(selectors.login.usernameField, username);
  await page.fill(selectors.login.passwordField, password);
  await page.click(selectors.login.submitButton);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);

  if (page.url().includes('/study/s/timeline')) {
    console.log('✅ ログイン成功\n');
    return true;
  }
  return false;
}

async function switchToUser(page, userName) {
  console.log(`🔄 "${userName}"に切り替え中...`);

  try {
    // ユーザー名が含まれる領域をクリックしてドロップダウンを開く
    const userArea = page.locator('div').filter({ hasText: 'さん' }).first();
    await userArea.click();
    await page.waitForTimeout(1500);

    // ユーザーを選択
    const targetUser = page.locator(`text="${userName}"`).first();
    if (await targetUser.isVisible()) {
      await targetUser.click();
      console.log(`  ✅ "${userName}"をクリックしました`);
      await page.waitForTimeout(3000);

      // 「日々のとりくみ」タブをクリック
      const dailyTab = page.locator('text="日々のとりくみ"');
      if (await dailyTab.isVisible()) {
        await dailyTab.click();
        console.log('  ✅ "日々のとりくみ"タブをクリックしました');
        await page.waitForTimeout(3000);
      }

      return true;
    }
  } catch (error) {
    console.log(`  ❌ エラー: ${error.message}`);
  }
  return false;
}

async function getTodayMissionCount(page) {
  try {
    const today = getTodayDate();
    console.log(`  📅 今日の日付: ${today}`);

    // 今日の日付セクションを探す
    const datePattern = new RegExp(today.replace('/', '\\/'));
    const dateLocator = page.locator(`text=${datePattern}`).first();

    if (!(await dateLocator.isVisible())) {
      console.log(`  ⚠️  今日(${today})のデータが見つかりません`);
      return 0;
    }

    console.log(`  ✅ 今日(${today})のセクションを発見`);

    // ページ全体のHTMLを取得
    const pageContent = await page.content();

    // 今日の日付の位置を特定
    const todayIndex = pageContent.indexOf(today);
    if (todayIndex === -1) {
      return 0;
    }

    // 今日の日付から次の日付までの範囲を抽出
    const restContent = pageContent.substring(todayIndex);

    // 次の日付を探す（MM/DD形式）
    const nextDatePattern = /(\d+)\/(\d+)/g;
    const matches = [...restContent.matchAll(nextDatePattern)];

    let sectionContent;
    if (matches.length > 1) {
      // 2番目のマッチ（次の日付）までを対象範囲とする
      const secondMatchIndex = restContent.indexOf(matches[1][0]);
      sectionContent = restContent.substring(0, secondMatchIndex);
    } else {
      // 次の日付がない場合は、適当な範囲を切り出す
      sectionContent = restContent.substring(0, 3000);
    }

    // セクション内の「ミッション」の出現回数を数える
    const missionMatches = sectionContent.match(/ミッション/g);
    const missionCount = missionMatches ? missionMatches.length : 0;

    console.log(`  📊 ミッション数: ${missionCount}\n`);
    return missionCount;

  } catch (error) {
    console.error(`  ❌ エラー: ${error.message}`);
    return 0;
  }
}

async function main() {
  let browser, context, page;

  try {
    console.log('🚀 全ユーザーのミッション数確認を開始します\n');
    console.log('='.repeat(60) + '\n');

    const username = process.env.SMILEZEMI_USERNAME;
    const password = process.env.SMILEZEMI_PASSWORD;

    if (!username || !password) {
      throw new Error('環境変数が設定されていません');
    }

    // ブラウザを起動
    console.log('🌐 ブラウザを起動中...');
    browser = await chromium.launch({
      headless: false,
      slowMo: 500
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    page = await context.newPage();

    // ログイン
    const loginSuccess = await login(page, username, password);
    if (!loginSuccess) {
      throw new Error('ログインに失敗しました');
    }

    // ユーザー一覧
    const users = ['吉岡光志郎さん', '吉岡千晴さん', '吉岡祥吾さん'];

    console.log('='.repeat(60));
    console.log('📊 各ユーザーのミッション数を取得します');
    console.log('='.repeat(60) + '\n');

    const results = [];

    for (const userName of users) {
      console.log(`--- ${userName} ---`);

      // ユーザーに切り替え
      const switched = await switchToUser(page, userName);

      if (switched) {
        // ミッション数を取得
        const missionCount = await getTodayMissionCount(page);
        results.push({ userName, missionCount });

        // スクリーンショット保存
        const safeName = userName.replace(/さん/, '');
        await page.screenshot({
          path: `screenshots/${safeName}-missions.png`,
          fullPage: true
        });
        console.log(`  📸 スクリーンショット: screenshots/${safeName}-missions.png\n`);
      } else {
        results.push({ userName, missionCount: -1, error: '切り替え失敗' });
      }

      // 次のユーザーに移る前に待機
      await page.waitForTimeout(2000);
    }

    // 結果サマリー
    console.log('\n' + '='.repeat(60));
    console.log('📊 結果サマリー');
    console.log('='.repeat(60));
    console.log(`\n📅 今日の日付: ${getTodayDate()}\n`);

    let totalMissions = 0;
    results.forEach(result => {
      if (result.error) {
        console.log(`❌ ${result.userName}: ${result.error}`);
      } else {
        console.log(`✅ ${result.userName}: ${result.missionCount}ミッション`);
        totalMissions += result.missionCount;
      }
    });

    console.log(`\n📊 合計: ${totalMissions}ミッション`);
    console.log('\n' + '='.repeat(60) + '\n');

    // 最終スクリーンショット
    await page.screenshot({
      path: 'screenshots/final-result.png',
      fullPage: true
    });
    console.log('📸 最終スクリーンショット: screenshots/final-result.png\n');

    // 10秒待機
    console.log('⏳ 10秒待機します（ブラウザで確認できます）...');
    await page.waitForTimeout(10000);

    console.log('✅ すべての処理が完了しました！\n');

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('✅ ブラウザを閉じました\n');
  }
}

main().catch(error => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
