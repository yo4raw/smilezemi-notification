#!/usr/bin/env node
/**
 * 全ユーザーのミッション数確認スクリプト
 * ログインして各ユーザーに切り替え、今日のミッション数を取得する
 */

const { chromium } = require('playwright');
const selectors = require('../src/config/selectors');

/**
 * 今日の日付をMM/DD形式で取得
 */
function getTodayDate() {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  return `${month}/${day}`;
}

/**
 * ログイン処理
 */
async function login(page, username, password) {
  console.log('🔐 ログイン処理を開始...');

  // ログインページにアクセス
  console.log(`📍 ログインページにアクセス: ${selectors.login.url}`);
  await page.goto(selectors.login.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // ログイン情報を入力
  console.log('📝 ログイン情報を入力中...');
  await page.fill(selectors.login.usernameField, username);
  await page.fill(selectors.login.passwordField, password);

  // ログインボタンをクリック
  console.log('🖱️  ログインボタンをクリック...');
  await page.click(selectors.login.submitButton);

  // ページ読み込み待機
  console.log('⏳ ページ読み込み待機中...');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000); // 追加待機

  const currentUrl = page.url();
  console.log(`📍 現在のURL: ${currentUrl}`);

  if (currentUrl.includes('/study/s/timeline')) {
    console.log('✅ ログイン成功\n');
    return true;
  } else {
    console.log('❌ ログイン失敗\n');
    return false;
  }
}

/**
 * 現在表示されているユーザー名を取得
 */
async function getCurrentUsername(page) {
  try {
    // 画面右上のユーザー名を取得
    const userButton = await page.locator('button:has-text("さん")').first();
    if (await userButton.isVisible()) {
      const text = await userButton.textContent();
      return text.trim();
    }
  } catch (error) {
    console.error('ユーザー名取得エラー:', error.message);
  }
  return null;
}

/**
 * ユーザー一覧を取得
 */
async function getUserList(page) {
  try {
    console.log('👥 ユーザー一覧を取得中...');

    // ユーザー選択ボタンをクリック
    const userButton = await page.locator('button:has-text("さん")').first();
    if (await userButton.isVisible()) {
      await userButton.click();
      console.log('  ユーザー選択メニューを開きました');
      await page.waitForTimeout(1000);

      // スクリーンショットを保存
      await page.screenshot({ path: 'screenshots/user-menu-opened.png' });
      console.log('  📸 スクリーンショット保存: screenshots/user-menu-opened.png');

      // ユーザー一覧を探す
      // パターン1: "〇〇さん"というテキストを持つ要素
      const userItems = await page.locator('text=/.*さん/').all();
      console.log(`  見つかった候補: ${userItems.length}件`);

      const users = [];
      for (const item of userItems) {
        const text = await item.textContent();
        const userName = text.trim();
        // "おとうさん"などの親アカウントを除外
        if (userName.length > 3 && userName.endsWith('さん') && !userName.includes('おとうさん')) {
          users.push(userName);
        }
      }

      // 重複を除去
      const uniqueUsers = [...new Set(users)];
      console.log(`  ✅ ユーザー一覧: ${uniqueUsers.join(', ')}\n`);

      // メニューを閉じる（ESCキー）
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      return uniqueUsers;
    }
  } catch (error) {
    console.error('❌ ユーザー一覧取得エラー:', error.message);
  }
  return [];
}

/**
 * 特定のユーザーに切り替え
 */
async function switchToUser(page, userName) {
  try {
    console.log(`🔄 "${userName}"に切り替え中...`);

    // ユーザー選択ボタンをクリック
    const userButton = await page.locator('button:has-text("さん")').first();
    await userButton.click();
    await page.waitForTimeout(1000);

    // ユーザーをクリック
    const targetUser = await page.locator(`text="${userName}"`).first();
    if (await targetUser.isVisible()) {
      await targetUser.click();
      console.log(`  ✅ "${userName}"をクリックしました`);

      // ページ更新待機
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);

      // 日付要素が表示されるまで待機
      await page.waitForSelector('text=/\\d+\\/\\d+/', { timeout: 10000 });
      console.log(`  ✅ "${userName}"のデータを読み込みました\n`);
      return true;
    } else {
      console.log(`  ❌ "${userName}"が見つかりませんでした\n`);
      return false;
    }
  } catch (error) {
    console.error(`❌ ユーザー切り替えエラー (${userName}):`, error.message);
    return false;
  }
}

/**
 * 今日のミッション数を取得
 */
async function getTodayMissionCount(page) {
  try {
    const today = getTodayDate();
    console.log(`📅 今日の日付: ${today}`);

    // 今日の日付セクションを探す
    const dateLocator = page.locator(`text=/${today.replace('/', '\\/')}/`).first();

    if (!(await dateLocator.isVisible())) {
      console.log(`  ⚠️  今日(${today})のデータが見つかりません`);
      return 0;
    }

    console.log(`  ✅ 今日(${today})のセクションを発見`);

    // スクリーンショットを保存
    const currentUser = await getCurrentUsername(page);
    const safeName = currentUser ? currentUser.replace(/さん/, '') : 'user';
    await page.screenshot({
      path: `screenshots/missions-${safeName}-${today.replace('/', '-')}.png`,
      fullPage: true
    });

    // 日付の親要素を取得
    const dateElement = await dateLocator.elementHandle();
    let parentElement = dateElement;

    // 親要素を3階層上まで遡る
    for (let i = 0; i < 3; i++) {
      const parent = await parentElement.evaluateHandle(el => el.parentElement);
      parentElement = parent;
    }

    // その親要素内の「ミッション」テキストを数える
    const missionElements = await page.locator('text=/ミッション/').all();
    console.log(`  全体のミッション要素数: ${missionElements.length}`);

    // より正確なカウント: 今日のセクション内のミッションのみをカウント
    // 日付の後ろに続く要素で、次の日付までの範囲を対象とする
    let missionCount = 0;

    // 簡易版: 最初の数件のミッション要素のみをカウント
    // (実装を簡略化するため、ここでは固定値を使用)
    // より正確には、DOM構造を詳しく解析する必要があります

    // スクリーンショットから手動で確認した値を返す
    // 実際の実装では、DOM構造を解析してカウントします

    // 暫定的な実装: 画面上のミッション数を数える
    const pageContent = await page.content();
    const todayIndex = pageContent.indexOf(today);

    if (todayIndex === -1) {
      console.log('  ⚠️  今日の日付がページ内に見つかりません');
      return 0;
    }

    // 今日の日付から次の日付までのセクションを抽出
    const nextDatePattern = /\d+\/\d+/g;
    const restContent = pageContent.substring(todayIndex + today.length);
    const nextDateMatch = restContent.match(nextDatePattern);

    let sectionContent;
    if (nextDateMatch) {
      const nextDateIndex = restContent.indexOf(nextDateMatch[0]);
      sectionContent = restContent.substring(0, nextDateIndex);
    } else {
      sectionContent = restContent.substring(0, 1000); // 最初の1000文字
    }

    // セクション内の「ミッション」の出現回数を数える
    const missionMatches = sectionContent.match(/ミッション/g);
    missionCount = missionMatches ? missionMatches.length : 0;

    console.log(`  📊 今日のミッション数: ${missionCount}\n`);
    return missionCount;

  } catch (error) {
    console.error('❌ ミッション数取得エラー:', error.message);
    return 0;
  }
}

/**
 * メイン処理
 */
async function main() {
  let browser, context, page;

  try {
    console.log('🚀 全ユーザーのミッション数確認を開始します\n');

    // 環境変数から認証情報を取得
    const username = process.env.SMILEZEMI_USERNAME;
    const password = process.env.SMILEZEMI_PASSWORD;

    if (!username || !password) {
      throw new Error('環境変数が設定されていません');
    }

    // ブラウザを起動
    console.log('🌐 ブラウザを起動中...');
    browser = await chromium.launch({
      headless: false,
      slowMo: 300
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

      // 現在のユーザーのミッション数だけ取得
      const currentUser = await getCurrentUsername(page);
      if (currentUser) {
        console.log(`📊 現在のユーザー: ${currentUser}`);
        const missionCount = await getTodayMissionCount(page);
        console.log(`\n=== 結果 ===`);
        console.log(`${currentUser}: ${missionCount}ミッション\n`);
      }
    } else {
      // 各ユーザーのミッション数を取得
      console.log('='.repeat(50));
      console.log('📊 各ユーザーのミッション数を取得します');
      console.log('='.repeat(50) + '\n');

      const results = [];

      for (const userName of users) {
        // ユーザーに切り替え
        const switched = await switchToUser(page, userName);

        if (switched) {
          // ミッション数を取得
          const missionCount = await getTodayMissionCount(page);
          results.push({ userName, missionCount });
        } else {
          results.push({ userName, missionCount: -1, error: '切り替え失敗' });
        }

        // 次のユーザーに移る前に少し待機
        await page.waitForTimeout(2000);
      }

      // 結果を表示
      console.log('='.repeat(50));
      console.log('📊 結果サマリー');
      console.log('='.repeat(50));
      console.log(`\n今日の日付: ${getTodayDate()}\n`);

      results.forEach(result => {
        if (result.error) {
          console.log(`❌ ${result.userName}: ${result.error}`);
        } else {
          console.log(`✅ ${result.userName}: ${result.missionCount}ミッション`);
        }
      });

      console.log('\n' + '='.repeat(50) + '\n');
    }

    // 最終スクリーンショット
    await page.screenshot({
      path: 'screenshots/final-state.png',
      fullPage: true
    });
    console.log('📸 最終状態のスクリーンショット保存: screenshots/final-state.png');

    // 10秒待機
    console.log('\n⏳ 10秒待機します（ブラウザで確認できます）...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n✅ ブラウザを閉じました');
  }
}

// スクリプトを実行
main().catch(error => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
