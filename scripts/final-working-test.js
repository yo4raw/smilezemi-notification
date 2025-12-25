#!/usr/bin/env node
/**
 * 全ユーザーのミッション数確認 - 完全動作版
 *
 * 右側の「お子さま」セクションからユーザー一覧を取得し、
 * 各ユーザーに切り替えて今日のミッション数を取得する
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

async function getUserList(page) {
  console.log('👥 ユーザー一覧を取得中...');

  try {
    // 画面右上のユーザー名エリアをクリックしてサイドバーを開く
    const userArea = page.locator('div').filter({ hasText: 'さん' }).first();
    await userArea.click();
    await page.waitForTimeout(2000);

    // 「お子さま」セクションの後に続くユーザー名を探す
    const childrenHeader = page.locator('text="お子さま"');

    if (await childrenHeader.isVisible()) {
      console.log('  ✅ 「お子さま」セクションを発見');

      // 「お子さま」の後に続く要素でユーザー名（「さん」で終わる）を探す
      const userElements = await page.locator('text=/.*さん$/').all();
      const users = [];

      for (const element of userElements) {
        const text = await element.textContent();
        const userName = text.trim();

        // 「お子さま」や「おとうさん」などを除外し、子アカウント名のみを取得
        if (userName.length < 20 &&
            userName !== 'お子さま' &&
            !userName.includes('おとう') &&
            !userName.includes('おかあ')) {
          users.push(userName);
        }
      }

      // 重複を除去
      const uniqueUsers = [...new Set(users)];
      console.log(`  ✅ 見つかったユーザー: ${uniqueUsers.join(', ')}\n`);

      return uniqueUsers;
    }
  } catch (error) {
    console.log(`  ❌ エラー: ${error.message}`);
  }

  return [];
}

async function switchToUser(page, userName) {
  console.log(`🔄 "${userName}"に切り替え中...`);

  try {
    // ユーザー名エリアをクリックしてサイドバーを開く
    const userArea = page.locator('div').filter({ hasText: 'さん' }).first();
    await userArea.click();
    await page.waitForTimeout(1500);

    // ユーザーを選択
    const targetUser = page.locator(`text="${userName}"`).first();

    if (await targetUser.isVisible()) {
      await targetUser.click({ force: true });
      console.log(`  ✅ "${userName}"をクリックしました`);
      await page.waitForTimeout(2000);

      // サイドバーを閉じる（ESCキー）
      await page.keyboard.press('Escape');
      console.log('  ✅ サイドバーを閉じました');
      await page.waitForTimeout(1000);

      // 「日々のとりくみ」タブをクリック
      const dailyTab = page.locator('text="日々のとりくみ"');
      if (await dailyTab.isVisible()) {
        await dailyTab.click();
        console.log('  ✅ "日々のとりくみ"タブをクリックしました');
        await page.waitForTimeout(3000);
      }

      return true;
    } else {
      console.log(`  ⚠️  "${userName}"が表示されていません`);
    }
  } catch (error) {
    console.log(`  ❌ エラー: ${error.message}`);
  }
  return false;
}

async function getTodayMissionCount(page, userName) {
  try {
    const today = getTodayDate();
    console.log(`  📅 今日の日付: ${today}`);

    // Playwrightのlocatorで今日の日付を含む行を探す
    // スクリーンショットから "2/25(木)" のような表記であることを確認
    const datePattern = new RegExp(`${today}.*?[月火水木金土日]`);
    const todayHeader = page.locator(`text=${datePattern}`).first();

    if (!(await todayHeader.isVisible())) {
      console.log(`  ⚠️  今日(${today})のデータが見つかりません`);
      return 0;
    }

    console.log(`  ✅ 今日(${today})のセクションを発見`);

    // 今日の日付セクション内の「ミッション」テキストを数える
    // 方法: 今日の日付要素から次の日付要素までの範囲を特定し、その中のミッション数を数える

    // まず、全ての日付要素を取得
    const allDates = await page.locator('text=/\\d+\\/\\d+/').all();
    console.log(`  全体の日付要素数: ${allDates.length}`);

    // 今日の日付のインデックスを見つける
    let todayIndex = -1;
    for (let i = 0; i < allDates.length; i++) {
      const dateText = await allDates[i].textContent();
      if (dateText.includes(today)) {
        todayIndex = i;
        break;
      }
    }

    if (todayIndex === -1) {
      console.log('  ⚠️  今日の日付のインデックスが見つかりません');
      return 0;
    }

    // より簡単な方法: ページ全体の「ミッション」要素を取得し、
    // 今日の日付の後に出現する最初の数個をカウント
    const allMissions = await page.locator('text=/ミッション/').all();
    console.log(`  全体のミッション要素数: ${allMissions.length}`);

    // 今日のセクション内のミッションのみをカウント
    // 今日の日付要素のbounding boxを取得
    const todayBox = await todayHeader.boundingBox();

    if (!todayBox) {
      console.log('  ⚠️  今日の日付のbounding boxが取得できません');
      return 0;
    }

    // 今日の日付より下で、次の日付より上にあるミッション要素を数える
    let missionCount = 0;
    const nextDateIndex = todayIndex + 1;
    let nextDateY = Infinity;

    if (nextDateIndex < allDates.length) {
      const nextDateBox = await allDates[nextDateIndex].boundingBox();
      if (nextDateBox) {
        nextDateY = nextDateBox.y;
      }
    }

    for (const mission of allMissions) {
      const missionBox = await mission.boundingBox();
      if (missionBox && missionBox.y > todayBox.y && missionBox.y < nextDateY) {
        missionCount++;
      }
    }

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

    // ユーザー一覧を取得
    const users = await getUserList(page);

    if (users.length === 0) {
      console.log('⚠️  ユーザーが見つかりませんでした');
      return;
    }

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
        const missionCount = await getTodayMissionCount(page, userName);
        results.push({ userName, missionCount });

        // スクリーンショット保存
        const safeName = userName.replace(/さん$/, '');
        await page.screenshot({
          path: `screenshots/${safeName}-final.png`,
          fullPage: true
        });
        console.log(`  📸 スクリーンショット: screenshots/${safeName}-final.png\n`);
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
      path: 'screenshots/complete-test.png',
      fullPage: true
    });
    console.log('📸 最終スクリーンショット: screenshots/complete-test.png\n');

    console.log('✅ すべての処理が完了しました！\n');

    // 結果をJSON形式でも出力
    console.log('JSON形式:');
    console.log(JSON.stringify({
      date: getTodayDate(),
      users: results,
      total: totalMissions
    }, null, 2));

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n✅ ブラウザを閉じました\n');
  }
}

main().catch(error => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
