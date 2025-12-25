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
    // ユーザー名エリアをクリックしてサイドバーを開く（既に開いているかもしれないが念のため）
    const userArea = page.locator('div').filter({ hasText: 'さん' }).first();
    await userArea.click();
    await page.waitForTimeout(1500);

    // ユーザーを選択（正確に一致する要素を探す）
    const targetUser = page.locator(`text="${userName}"`).first();

    if (await targetUser.isVisible()) {
      await targetUser.click({ force: true });  // force: true で確実にクリック
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

    // Playwrightのlocatorを使って今日の日付を探す
    const dateElements = await page.locator(`text=/${today.replace('/', '\\/')}/`).all();

    if (dateElements.length === 0) {
      console.log(`  ⚠️  今日(${today})のデータが見つかりません`);
      return 0;
    }

    console.log(`  ✅ 今日(${today})のセクションを発見`);

    // 今日の日付要素の親要素を取得し、その配下のミッションを数える
    // より確実な方法: 画面に表示されている全ての「ミッション」テキストを探し、
    // 日付セクション内に含まれるものだけをカウント

    // まず、今日の日付が含まれる行を特定
    const todayRow = page.locator(`text=/${today.replace('/', '\\/')}/`).first();

    // スクリーンショットから確認すると、各ミッションには「ミッション」というテキストがある
    // 今日のセクション（12/25から次の日付12/24まで）のミッション数を数える

    // 簡略版: ページ内の今日のセクションのHTMLを取得してカウント
    const pageContent = await page.content();

    // HTMLから今日の日付の位置を特定
    // 注意: HTMLでは "2/25" という表記になっている
    const todayPattern = new RegExp(`>${today}`, 'g');
    const matches = pageContent.match(todayPattern);

    if (!matches) {
      console.log('  ⚠️  HTML内に今日の日付が見つかりません');
      return 0;
    }

    const todayIndex = pageContent.indexOf(`>${today}`);

    // 今日の日付から次の日付までのセクションを抽出
    // 次の日付パターン: >数字/数字<
    const nextDatePattern = />(\d+)\/(\d+)</g;
    const restContent = pageContent.substring(todayIndex + today.length + 1);
    const nextDateMatch = nextDatePattern.exec(restContent);

    let sectionContent;
    if (nextDateMatch) {
      sectionContent = pageContent.substring(todayIndex, todayIndex + nextDateMatch.index + 50);
    } else {
      // 次の日付がない場合は、適当な長さを切り出す
      sectionContent = pageContent.substring(todayIndex, todayIndex + 3000);
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
