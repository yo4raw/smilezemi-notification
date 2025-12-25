#!/usr/bin/env node
/**
 * セレクタ調査スクリプト
 *
 * みまもるネットのログインページとダッシュボードのDOM構造を調査し、
 * 正しいセレクタを特定するためのデバッグツール
 */

const { chromium } = require('playwright');
const selectors = require('../src/config/selectors');

async function investigateSelectors() {
  let browser, context, page;

  try {
    console.log('🔍 セレクタ調査を開始します...\n');

    // 設定を環境変数から直接読み込む
    const config = {
      SMILEZEMI_USERNAME: process.env.SMILEZEMI_USERNAME,
      SMILEZEMI_PASSWORD: process.env.SMILEZEMI_PASSWORD,
      LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_USER_ID: process.env.LINE_USER_ID
    };

    // 環境変数の存在確認
    const missing = [];
    for (const [key, value] of Object.entries(config)) {
      if (!value) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      throw new Error(`環境変数が設定されていません: ${missing.join(', ')}`);
    }

    console.log('✅ 設定を読み込みました\n');

    // ブラウザを起動（ヘッドレスモードをオフにして視覚的に確認）
    console.log('🌐 ブラウザを起動しています...');
    browser = await chromium.launch({
      headless: false,  // デバッグのため画面を表示
      slowMo: 500       // 操作を遅くして確認しやすくする
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });

    page = await context.newPage();

    // ログインページにアクセス
    console.log(`\n📍 ログインページにアクセス: ${selectors.login.url}`);
    await page.goto(selectors.login.url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // 追加の待機（ページが完全に読み込まれるまで）
    await page.waitForTimeout(3000);

    // スクリーンショットを保存
    await page.screenshot({ path: 'screenshots/debug-login-page.png', fullPage: true });
    console.log('📸 ログインページのスクリーンショットを保存: screenshots/debug-login-page.png');

    // ログインページのDOM構造を調査
    console.log('\n🔍 ログインページのフォーム要素を調査中...\n');

    // ユーザー名フィールドの調査
    console.log('=== ユーザー名フィールド ===');
    const usernameSelectors = [
      'input[name="username"]',
      'input[type="email"]',
      'input[type="text"]',
      'input[placeholder*="メール"]',
      'input[placeholder*="ユーザー"]',
      '#username',
      '#email',
      '#loginId'
    ];

    for (const selector of usernameSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const attrs = await element.evaluate(el => ({
            tag: el.tagName,
            id: el.id,
            name: el.name,
            type: el.type,
            placeholder: el.placeholder,
            className: el.className
          }));
          console.log(`✓ 見つかりました: ${selector}`);
          console.log(`  属性:`, attrs);
        }
      } catch (error) {
        // セレクタが見つからない場合は無視
      }
    }

    // パスワードフィールドの調査
    console.log('\n=== パスワードフィールド ===');
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      '#password',
      '#pass'
    ];

    for (const selector of passwordSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const attrs = await element.evaluate(el => ({
            tag: el.tagName,
            id: el.id,
            name: el.name,
            type: el.type,
            placeholder: el.placeholder,
            className: el.className
          }));
          console.log(`✓ 見つかりました: ${selector}`);
          console.log(`  属性:`, attrs);
        }
      } catch (error) {
        // セレクタが見つからない場合は無視
      }
    }

    // ログインボタンの調査
    console.log('\n=== ログインボタン ===');
    const loginButtonSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("ログイン")',
      'input[value*="ログイン"]',
      '#login-button',
      '.login-button'
    ];

    for (const selector of loginButtonSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const attrs = await element.evaluate(el => ({
            tag: el.tagName,
            id: el.id,
            type: el.type,
            value: el.value,
            textContent: el.textContent?.trim(),
            className: el.className
          }));
          console.log(`✓ 見つかりました: ${selector}`);
          console.log(`  属性:`, attrs);
        }
      } catch (error) {
        // セレクタが見つからない場合は無視
      }
    }

    // 実際にログインを試行
    console.log('\n🔐 ログインを試行します...\n');

    // ユーザー名を入力
    console.log('📝 ユーザー名を入力中...');
    await page.fill(selectors.login.usernameField, config.SMILEZEMI_USERNAME);
    console.log('✅ ユーザー名を入力しました');

    // パスワードを入力
    console.log('📝 パスワードを入力中...');
    await page.fill(selectors.login.passwordField, config.SMILEZEMI_PASSWORD);
    console.log('✅ パスワードを入力しました');

    // スクリーンショット（入力後）
    await page.screenshot({ path: 'screenshots/debug-login-filled.png', fullPage: true });
    console.log('📸 入力後のスクリーンショットを保存: screenshots/debug-login-filled.png');

    // ログインボタンをクリック
    console.log('🖱️  ログインボタンをクリック中...');
    await page.click(selectors.login.submitButton);
    console.log('✅ ログインボタンをクリックしました');

    // ページ遷移を待機
    console.log('⏳ ページ遷移を待機中...');
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // ログイン後のURLを確認
    const currentUrl = page.url();
    console.log(`📍 現在のURL: ${currentUrl}`);

    // スクリーンショット（ログイン後）
    await page.screenshot({ path: 'screenshots/debug-after-login.png', fullPage: true });
    console.log('📸 ログイン後のスクリーンショットを保存: screenshots/debug-after-login.png');

    // ログイン成功の判定
    if (currentUrl !== selectors.login.url && !currentUrl.includes('/login')) {
      console.log('✅ ログインに成功しました！\n');

      // ダッシュボードのユーザー選択要素を調査
      console.log('🔍 ダッシュボードのユーザー選択要素を調査中...\n');

      const userSelectors = [
        selectors.dashboard.userSelector,
        selectors.dashboard.userSelectorAlternative,
        'select[name="user"]',
        '.user-select',
        '#user-selector',
        'button:has-text("ユーザー")',
        '[role="button"]:has-text("ユーザー")'
      ];

      for (const selector of userSelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            console.log(`✓ 見つかりました: ${selector} (${elements.length}件)`);

            // 最初の要素の詳細を表示
            const attrs = await elements[0].evaluate(el => ({
              tag: el.tagName,
              id: el.id,
              className: el.className,
              textContent: el.textContent?.trim()
            }));
            console.log(`  属性:`, attrs);
          }
        } catch (error) {
          // セレクタが見つからない場合は無視
        }
      }

      // ミッション数要素を調査
      console.log('\n=== ミッション数要素 ===');
      const missionSelectors = [
        selectors.dashboard.missionCount,
        selectors.dashboard.missionCountAlternative,
        selectors.dashboard.missionText,
        'text=/\\d+ミッション/',
        '[class*="mission"]',
        '[class*="count"]'
      ];

      for (const selector of missionSelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            console.log(`✓ 見つかりました: ${selector} (${elements.length}件)`);

            // 最初の要素の詳細を表示
            const text = await elements[0].textContent();
            console.log(`  テキスト: ${text}`);
          }
        } catch (error) {
          // セレクタが見つからない場合は無視
        }
      }

    } else {
      console.log('❌ ログインに失敗しました');
      console.log(`   現在のURL: ${currentUrl}`);

      // エラーメッセージを探す
      console.log('\n🔍 エラーメッセージを探しています...');
      const errorSelectors = [
        '.error',
        '.error-message',
        '[role="alert"]',
        '.alert',
        '.warning'
      ];

      for (const selector of errorSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            const text = await element.textContent();
            console.log(`⚠️  エラー: ${text}`);
          }
        } catch (error) {
          // セレクタが見つからない場合は無視
        }
      }
    }

    // 10秒待機してブラウザを確認できるようにする
    console.log('\n⏳ 10秒待機します（ブラウザで画面を確認してください）...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);

    // エラー時のスクリーンショット
    if (page) {
      try {
        await page.screenshot({ path: 'screenshots/debug-error.png', fullPage: true });
        console.log('📸 エラー時のスクリーンショットを保存: screenshots/debug-error.png');
      } catch (screenshotError) {
        console.error('スクリーンショットの保存に失敗しました');
      }
    }
  } finally {
    // ブラウザをクリーンアップ
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n✅ ブラウザを閉じました');
  }
}

// スクリプトを実行
investigateSelectors().catch(error => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
