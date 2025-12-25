#!/usr/bin/env node
/**
 * ダッシュボードのセレクタ詳細調査スクリプト
 */

const { chromium } = require('playwright');
const selectors = require('../src/config/selectors');
const fs = require('fs');

async function investigateDashboard() {
  let browser, context, page;

  try {
    console.log('🔍 ダッシュボードのセレクタ調査を開始します...\n');

    const config = {
      SMILEZEMI_USERNAME: process.env.SMILEZEMI_USERNAME,
      SMILEZEMI_PASSWORD: process.env.SMILEZEMI_PASSWORD
    };

    if (!config.SMILEZEMI_USERNAME || !config.SMILEZEMI_PASSWORD) {
      throw new Error('環境変数が設定されていません');
    }

    console.log('✅ 設定を読み込みました\n');

    // ブラウザを起動
    console.log('🌐 ブラウザを起動しています...');
    browser = await chromium.launch({
      headless: false,
      slowMo: 300
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    page = await context.newPage();

    // ログインページにアクセス
    console.log(`📍 ログインページにアクセス: ${selectors.login.url}`);
    await page.goto(selectors.login.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // ログイン
    console.log('🔐 ログイン中...');
    await page.fill(selectors.login.usernameField, config.SMILEZEMI_USERNAME);
    await page.fill(selectors.login.passwordField, config.SMILEZEMI_PASSWORD);
    await page.click(selectors.login.submitButton);

    // ログイン後のページ読み込みを待機（networkidleではなくdomcontentloadedを使用）
    console.log('⏳ ダッシュボードの読み込みを待機中...');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000); // 追加で5秒待機

    const currentUrl = page.url();
    console.log(`📍 現在のURL: ${currentUrl}\n`);

    // ダッシュボードのスクリーンショット
    await page.screenshot({ path: 'screenshots/dashboard-full.png', fullPage: true });
    console.log('📸 ダッシュボードのスクリーンショットを保存\n');

    // HTMLを保存
    const html = await page.content();
    fs.writeFileSync('screenshots/dashboard.html', html);
    console.log('💾 ダッシュボードのHTMLを保存\n');

    // ユーザー選択UI要素を調査
    console.log('=== ユーザー選択UI ===');
    const userSelectorCandidates = [
      'button:has-text("さん")',
      '[class*="user"]',
      '[class*="User"]',
      'button[class*="selector"]',
      'div:has-text("さん")',
      'span:has-text("さん")'
    ];

    for (const selector of userSelectorCandidates) {
      try {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          console.log(`✓ 見つかりました: ${selector} (${elements.length}件)`);
          const text = await elements[0].textContent();
          const attrs = await elements[0].evaluate(el => ({
            tag: el.tagName,
            id: el.id,
            className: el.className,
            textContent: el.textContent?.trim()
          }));
          console.log(`  テキスト: ${text}`);
          console.log(`  属性:`, attrs);
        }
      } catch (error) {
        // スキップ
      }
    }

    // 日付要素を調査
    console.log('\n=== 学習日付表示 ===');
    const dateCandidates = [
      'text=/12\\/25/',
      'text=/12月25日/',
      'div:has-text("12/25")',
      '[class*="date"]',
      '[class*="Date"]',
      'time'
    ];

    for (const selector of dateCandidates) {
      try {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          console.log(`✓ 見つかりました: ${selector} (${elements.length}件)`);
          const text = await elements[0].textContent();
          const attrs = await elements[0].evaluate(el => ({
            tag: el.tagName,
            className: el.className,
            textContent: el.textContent?.trim()
          }));
          console.log(`  テキスト: ${text}`);
          console.log(`  属性:`, attrs);
        }
      } catch (error) {
        // スキップ
      }
    }

    // ミッション要素を調査
    console.log('\n=== ミッション表示要素 ===');
    const missionCandidates = [
      'text=/ミッション/',
      'div:has-text("ミッション")',
      '[class*="mission"]',
      '[class*="Mission"]',
      'text=/分/',
      'div:has-text("分")'
    ];

    for (const selector of missionCandidates) {
      try {
        const elements = await page.$$(selector);
        if (elements.length > 0 && elements.length < 20) { // 多すぎる結果は除外
          console.log(`✓ 見つかりました: ${selector} (${elements.length}件)`);
          const text = await elements[0].textContent();
          const attrs = await elements[0].evaluate(el => ({
            tag: el.tagName,
            className: el.className,
            textContent: el.textContent?.trim()
          }));
          console.log(`  テキスト: ${text}`);
          console.log(`  属性:`, attrs);
        }
      } catch (error) {
        // スキップ
      }
    }

    // 今日の日付のミッション数をカウント
    console.log('\n=== 今日(12/25)のミッション数 ===');
    try {
      // 今日の日付の行を探す
      const todaySection = await page.locator('text=/12\\/25/').first();
      if (await todaySection.isVisible()) {
        console.log('✓ 今日の日付セクションが見つかりました');

        // その日付の近くにあるミッション要素を探す
        const missionElements = await page.locator('text=/ミッション/').all();
        console.log(`  全体のミッション要素数: ${missionElements.length}`);

        // 各ミッションのテキストを表示
        for (let i = 0; i < Math.min(missionElements.length, 5); i++) {
          const text = await missionElements[i].textContent();
          console.log(`  ミッション${i + 1}: ${text}`);
        }
      }
    } catch (error) {
      console.log('  今日の日付セクションが見つかりませんでした');
    }

    // 星マーク（完了済みミッション）を調査
    console.log('\n=== 星マーク（完了済み）===');
    const starCandidates = [
      'svg[class*="star"]',
      '[class*="star"]',
      'img[alt*="star"]',
      'img[alt*="完了"]'
    ];

    for (const selector of starCandidates) {
      try {
        const elements = await page.$$(selector);
        if (elements.length > 0 && elements.length < 30) {
          console.log(`✓ 見つかりました: ${selector} (${elements.length}件)`);
          const attrs = await elements[0].evaluate(el => ({
            tag: el.tagName,
            className: el.className
          }));
          console.log(`  属性:`, attrs);
        }
      } catch (error) {
        // スキップ
      }
    }

    // 20秒待機してブラウザで確認
    console.log('\n⏳ 20秒待機します（ブラウザで画面を確認してください）...');
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

investigateDashboard().catch(error => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
