/**
 * コース選択DOM構造調査スクリプト
 * ユーザー選択後のコース選択画面を調査する
 */

const { chromium } = require('playwright');
const auth = require('../src/auth');
const { getUserList } = require('../src/crawler');

async function investigateCourseSelection() {
  let browser = null;

  try {
    console.log('🔍 コース選択DOM構造調査を開始します...\n');

    // ブラウザを起動（ヘッドレスモード）
    browser = await chromium.launch({ headless: true });

    // みまもるネットにログイン
    console.log('📝 ログイン中...');

    // 環境変数から認証情報を取得
    const credentials = {
      username: process.env.SMILEZEMI_USERNAME,
      password: process.env.SMILEZEMI_PASSWORD
    };

    if (!credentials.username || !credentials.password) {
      console.error('❌ 環境変数 SMILEZEMI_USERNAME と SMILEZEMI_PASSWORD が必要です');
      return;
    }

    const authResult = await auth.login(browser, credentials);

    if (!authResult.success) {
      console.error(`❌ 認証失敗: ${authResult.error}`);
      return;
    }

    console.log('✅ ログイン成功\n');

    // ユーザー一覧を取得
    console.log('👥 ユーザー一覧を取得中...');
    const userListResult = await getUserList(authResult.page);

    if (!userListResult.success) {
      console.error(`❌ ユーザー一覧取得失敗: ${userListResult.error}`);
      return;
    }

    console.log(`✅ ${userListResult.users.length}人のユーザーを検出\n`);

    // 最初のユーザーでコース選択画面を調査
    const firstUser = userListResult.users[0];
    console.log(`👤 ${firstUser.name}で調査します...\n`);

    // ユーザー選択前のスクリーンショット
    await authResult.page.screenshot({
      path: 'screenshots/before-user-selection.png',
      fullPage: true
    });
    console.log('📸 ユーザー選択前のスクリーンショット: screenshots/before-user-selection.png');

    // サイドバーを開く
    console.log('\n🔍 サイドバーを開いてユーザーを選択...');
    const viewport = authResult.page.viewportSize();
    const rightHalfX = viewport.width * 0.5;
    const topAreaY = viewport.height * 0.2;

    const userNameCandidates = await authResult.page.locator('div').filter({ hasText: 'さん' }).all();
    let userArea = null;

    for (const candidate of userNameCandidates) {
      const box = await candidate.boundingBox().catch(() => null);
      const text = await candidate.innerText().catch(() => '');
      const isVisible = await candidate.isVisible().catch(() => false);

      if (box &&
          box.x >= rightHalfX &&
          box.y <= topAreaY &&
          isVisible &&
          text.trim().length > 0 &&
          text.trim().length < 20 &&
          text.trim().endsWith('さん')) {
        userArea = candidate;
        break;
      }
    }

    if (!userArea) {
      console.error('❌ 右上のユーザーエリアが見つかりません');
      return;
    }

    // サイドバーを開く
    await userArea.click();
    await authResult.page.waitForTimeout(3000);

    // サイドバー内のスクリーンショット
    await authResult.page.screenshot({
      path: 'screenshots/sidebar-opened.png',
      fullPage: true
    });
    console.log('📸 サイドバーを開いた状態: screenshots/sidebar-opened.png');

    // ユーザー名をクリック
    const allUserElements = await authResult.page.locator(`text="${firstUser.name}"`).all();
    let targetElement = null;

    for (let i = 0; i < allUserElements.length; i++) {
      const box = await allUserElements[i].boundingBox().catch(() => null);
      if (box) {
        const viewport = authResult.page.viewportSize();
        if (!(box.x >= viewport.width * 0.5 && box.y <= viewport.height * 0.2)) {
          targetElement = allUserElements[i];
          break;
        }
      }
    }

    if (!targetElement) {
      console.error(`❌ サイドバー内に${firstUser.name}が見つかりません`);
      return;
    }

    console.log(`✅ ${firstUser.name}をクリック`);
    await targetElement.click();
    await authResult.page.waitForTimeout(3000);

    // ユーザー選択後のスクリーンショット
    await authResult.page.screenshot({
      path: 'screenshots/after-user-selection.png',
      fullPage: true
    });
    console.log('📸 ユーザー選択後: screenshots/after-user-selection.png');

    // コース選択要素を探す
    console.log('\n🔍 コース選択要素を探索中...');

    // 「中学生コース」「小学生コース」というテキストを含む要素を探す
    const courseTexts = ['中学生コース', '小学生コース', 'コース'];

    for (const courseText of courseTexts) {
      const elements = await authResult.page.locator(`text="${courseText}"`).all();
      console.log(`\n📋 "${courseText}" を含む要素: ${elements.length}件`);

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const text = await el.textContent().catch(() => '');
        const isVisible = await el.isVisible().catch(() => false);
        const box = await el.boundingBox().catch(() => null);

        if (isVisible) {
          console.log(`  [${i}] テキスト: "${text.trim()}"`);
          if (box) {
            console.log(`      位置: x=${Math.round(box.x)}, y=${Math.round(box.y)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}`);
          }

          // クラス名を取得
          const className = await el.getAttribute('class').catch(() => '');
          if (className) {
            console.log(`      クラス: ${className}`);
          }

          // タグ名を取得
          const tagName = await el.evaluate(node => node.tagName).catch(() => '');
          if (tagName) {
            console.log(`      タグ: ${tagName}`);
          }
        }
      }
    }

    // すべての「コース」を含む要素を探索
    console.log('\n🔍 すべてのボタン・リンク要素を探索...');
    const buttonElements = await authResult.page.locator('button, a, div[role="button"]').all();

    for (const btn of buttonElements) {
      const text = await btn.textContent().catch(() => '');
      const isVisible = await btn.isVisible().catch(() => false);

      if (isVisible && text.includes('コース')) {
        const box = await btn.boundingBox().catch(() => null);
        console.log(`\n  ボタン/リンク: "${text.trim()}"`);
        if (box) {
          console.log(`  位置: x=${Math.round(box.x)}, y=${Math.round(box.y)}`);
        }

        const className = await btn.getAttribute('class').catch(() => '');
        if (className) {
          console.log(`  クラス: ${className}`);
        }
      }
    }

    // ページのHTML構造をファイルに保存
    const htmlContent = await authResult.page.content();
    const fs = require('fs');
    fs.writeFileSync('screenshots/after-user-selection.html', htmlContent);
    console.log('\n📄 HTML保存: screenshots/after-user-selection.html');

    console.log('\n✅ 調査完了！');
    console.log('\n💡 次のファイルを確認してください:');
    console.log('   - screenshots/before-user-selection.png');
    console.log('   - screenshots/sidebar-opened.png');
    console.log('   - screenshots/after-user-selection.png');
    console.log('   - screenshots/after-user-selection.html');

  } catch (error) {
    console.error(`❌ エラー: ${error.message}`);
    console.error(error.stack);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// 実行
investigateCourseSelection();
