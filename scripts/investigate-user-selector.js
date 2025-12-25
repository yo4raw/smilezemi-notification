#!/usr/bin/env node
/**
 * ユーザー選択UIの詳細調査スクリプト
 */

const { chromium } = require('playwright');
const selectors = require('../src/config/selectors');

async function investigateUserSelector() {
  let browser, context, page;

  try {
    console.log('🔍 ユーザー選択UIの調査を開始します\n');

    const config = {
      SMILEZEMI_USERNAME: process.env.SMILEZEMI_USERNAME,
      SMILEZEMI_PASSWORD: process.env.SMILEZEMI_PASSWORD
    };

    if (!config.SMILEZEMI_USERNAME || !config.SMILEZEMI_PASSWORD) {
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
    console.log('🔐 ログイン中...');
    await page.goto(selectors.login.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.fill(selectors.login.usernameField, config.SMILEZEMI_USERNAME);
    await page.fill(selectors.login.passwordField, config.SMILEZEMI_PASSWORD);
    await page.click(selectors.login.submitButton);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);

    console.log('✅ ログイン完了\n');

    // 画面右上のユーザー名表示部分を調査
    console.log('=== 画面右上のユーザー表示要素 ===');

    // パターン1: ユーザー名を含むbutton要素
    console.log('\n1. button要素の調査:');
    const buttons = await page.$$('button');
    console.log(`  全体のbutton要素数: ${buttons.length}`);

    for (let i = 0; i < Math.min(buttons.length, 10); i++) {
      const text = await buttons[i].textContent();
      if (text && text.includes('さん')) {
        const attrs = await buttons[i].evaluate(el => ({
          tag: el.tagName,
          className: el.className,
          textContent: el.textContent?.trim()
        }));
        console.log(`  [${i}] テキスト: ${text.trim()}`);
        console.log(`      クラス: ${attrs.className}`);
      }
    }

    // パターン2: divやspan要素
    console.log('\n2. "さん"を含むdiv/span要素の調査:');
    const divs = await page.$$('div:has-text("さん")');
    console.log(`  "さん"を含むdiv要素数: ${divs.length}`);

    // 右上のエリアを特定
    console.log('\n3. 画面右上エリアの特定:');
    const rightTopElements = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, div, span'));
      return elements
        .filter(el => {
          const rect = el.getBoundingClientRect();
          const text = el.textContent || '';
          // 画面右上（x > 800, y < 100）でユーザー名を含む要素
          return rect.x > 800 && rect.y < 100 && text.includes('さん') && text.length < 50;
        })
        .map(el => ({
          tag: el.tagName,
          className: el.className,
          text: el.textContent?.trim(),
          x: el.getBoundingClientRect().x,
          y: el.getBoundingClientRect().y
        }));
    });

    console.log(`  見つかった要素数: ${rightTopElements.length}`);
    rightTopElements.forEach((el, i) => {
      console.log(`  [${i}] ${el.tag} (x:${Math.round(el.x)}, y:${Math.round(el.y)})`);
      console.log(`      テキスト: ${el.text}`);
      console.log(`      クラス: ${el.className}`);
    });

    // スクリーンショット（クリック前）
    await page.screenshot({ path: 'screenshots/user-selector-before-click.png' });
    console.log('\n📸 スクリーンショット保存: screenshots/user-selector-before-click.png');

    // ユーザー選択要素をクリック
    console.log('\n4. ユーザー選択要素をクリック:');

    // 方法1: 右上の「さん」を含むbutton要素を探してクリック
    try {
      const userButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
          const rect = btn.getBoundingClientRect();
          const text = btn.textContent || '';
          return rect.x > 800 && rect.y < 100 && text.includes('さん') && text.length < 50;
        });
      });

      if (userButton) {
        const element = userButton.asElement();
        if (element) {
          console.log('  ✅ ユーザー選択ボタンを発見');
          const text = await element.textContent();
          console.log(`  テキスト: ${text}`);

          await element.click();
          console.log('  ✅ クリックしました');
          await page.waitForTimeout(2000);

          // スクリーンショット（クリック後）
          await page.screenshot({ path: 'screenshots/user-selector-after-click.png' });
          console.log('  📸 スクリーンショット保存: screenshots/user-selector-after-click.png');

          // ドロップダウンメニューの要素を調査
          console.log('\n5. ドロップダウンメニューの調査:');

          // メニュー内の「さん」を含む要素を探す
          const menuItems = await page.$$('div:has-text("さん"), button:has-text("さん"), li:has-text("さん")');
          console.log(`  "さん"を含む要素数: ${menuItems.length}`);

          for (let i = 0; i < Math.min(menuItems.length, 20); i++) {
            const text = await menuItems[i].textContent();
            const trimmedText = text.trim();

            // 短いテキスト（50文字以下）で「さん」で終わる要素のみ表示
            if (trimmedText.length < 50 && trimmedText.endsWith('さん')) {
              const attrs = await menuItems[i].evaluate(el => ({
                tag: el.tagName,
                className: el.className,
                visible: el.offsetParent !== null
              }));

              if (attrs.visible) {
                console.log(`  [${i}] "${trimmedText}"`);
                console.log(`      タグ: ${attrs.tag}`);
                console.log(`      クラス: ${attrs.className}`);
              }
            }
          }

          // 特定のユーザーをクリックしてみる
          console.log('\n6. ユーザーの切り替えテスト:');

          // ページ内の「吉岡千晴さん」を探す
          const targetUser = '吉岡千晴さん';
          const userElements = await page.$$(`text="${targetUser}"`);

          console.log(`  "${targetUser}"の要素数: ${userElements.length}`);

          if (userElements.length > 0) {
            // 最初の要素をクリック
            try {
              await userElements[0].click();
              console.log(`  ✅ "${targetUser}"をクリックしました`);

              await page.waitForTimeout(3000);

              // スクリーンショット（切り替え後）
              await page.screenshot({ path: 'screenshots/user-switched.png' });
              console.log('  📸 スクリーンショット保存: screenshots/user-switched.png');

              // 現在のユーザー名を確認
              const currentUserButton = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(btn => {
                  const rect = btn.getBoundingClientRect();
                  const text = btn.textContent || '';
                  return rect.x > 800 && rect.y < 100 && text.includes('さん');
                });
              });

              if (currentUserButton) {
                const element = currentUserButton.asElement();
                const text = await element.textContent();
                console.log(`  現在のユーザー: ${text.trim()}`);
              }
            } catch (error) {
              console.log(`  ❌ クリックエラー: ${error.message}`);
            }
          }
        }
      }
    } catch (error) {
      console.error('  ❌ エラー:', error.message);
    }

    // 20秒待機
    console.log('\n⏳ 20秒待機します（ブラウザで確認してください）...');
    await page.waitForTimeout(20000);

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n✅ ブラウザを閉じました');
  }
}

investigateUserSelector().catch(error => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
