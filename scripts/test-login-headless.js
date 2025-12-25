#!/usr/bin/env node
/**
 * ヘッドレスモードでのログインテスト
 * GitHub Actions環境をシミュレート
 */

const { chromium } = require('playwright');
const { login } = require('../src/auth');

async function testLogin() {
  let browser;

  try {
    console.log('🔍 ヘッドレスモードでログインテストを開始...\n');

    // 環境変数の確認
    const username = process.env.SMILEZEMI_USERNAME;
    const password = process.env.SMILEZEMI_PASSWORD;

    if (!username || !password) {
      throw new Error('環境変数が設定されていません');
    }

    console.log(`📧 ユーザー名: ${username.substring(0, 5)}...`);
    console.log('');

    // ブラウザを起動（ヘッドレスモード）
    console.log('🌐 ブラウザを起動（ヘッドレスモード）...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log('✅ ブラウザを起動しました\n');

    // ログインを試行
    console.log('🔐 ログインを試行...');
    const startTime = Date.now();

    const result = await login(browser, {
      username,
      password
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️  所要時間: ${elapsed}秒\n`);

    if (result.success) {
      console.log('✅ ログインに成功しました！\n');
      console.log('📍 ページ情報:');
      console.log(`   URL: ${result.page.url()}`);
      console.log('');

      // スクリーンショットを保存
      await result.page.screenshot({
        path: 'screenshots/test-login-success.png',
        fullPage: true
      });
      console.log('📸 スクリーンショットを保存: screenshots/test-login-success.png\n');

      // クリーンアップ
      await result.context.close();

      return 0;
    } else {
      console.log('❌ ログインに失敗しました\n');
      console.log(`エラー: ${result.error}\n`);

      return 1;
    }

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
    return 1;

  } finally {
    if (browser) {
      await browser.close();
      console.log('✅ ブラウザを閉じました');
    }
  }
}

// スクリプトを実行
testLogin()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error('予期しないエラー:', error);
    process.exit(1);
  });
