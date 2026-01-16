/**
 * コース選択機能テストスクリプト
 */

const { chromium } = require('playwright');
const auth = require('../src/auth');
const { getUserList, checkCourseSelection, selectCourse, getCourseData } = require('../src/crawler');

async function testCourseSelection() {
  let browser = null;

  try {
    console.log('🔍 コース選択機能テストを開始します...\n');

    // ブラウザを起動
    browser = await chromium.launch({ headless: true });

    // ログイン
    console.log('📝 ログイン中...');
    const credentials = {
      username: process.env.SMILEZEMI_USERNAME,
      password: process.env.SMILEZEMI_PASSWORD
    };

    if (!credentials.username || !credentials.password) {
      console.error('❌ 環境変数が設定されていません');
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

    // 最初のユーザーでテスト
    const firstUser = userListResult.users[0];
    console.log(`👤 ${firstUser.name}でテスト...\n`);

    // サイドバーを開いてユーザーを選択
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

    await userArea.click();
    await authResult.page.waitForTimeout(3000);

    // スクリーンショット
    await authResult.page.screenshot({
      path: 'screenshots/test-sidebar-opened.png',
      fullPage: true
    });
    console.log('📸 サイドバー: screenshots/test-sidebar-opened.png');

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

    await targetElement.click();
    await authResult.page.waitForTimeout(3000);

    // スクリーンショット
    await authResult.page.screenshot({
      path: 'screenshots/test-after-user-selection.png',
      fullPage: true
    });
    console.log('📸 ユーザー選択後: screenshots/test-after-user-selection.png\n');

    // コース選択画面をチェック
    console.log('🔍 コース選択画面をチェック中...');
    const courseSelectionResult = await checkCourseSelection(authResult.page);

    console.log(`  コース選択画面: ${courseSelectionResult.hasCourseSelection ? 'あり' : 'なし'}`);
    console.log(`  中学生コース: ${courseSelectionResult.hasJuniorHighSchool ? 'あり' : 'なし'}`);
    console.log(`  小学生コース: ${courseSelectionResult.hasElementarySchool ? 'あり' : 'なし'}\n`);

    if (courseSelectionResult.hasCourseSelection) {
      // 中学生コースを選択
      if (courseSelectionResult.hasJuniorHighSchool) {
        console.log('📚 中学生コースを選択中...');
        const selectResult = await selectCourse(authResult.page, '中学生コース');

        if (selectResult.success) {
          console.log('✅ 中学生コース選択成功\n');

          // スクリーンショット
          await authResult.page.screenshot({
            path: 'screenshots/test-junior-high-school-course.png',
            fullPage: true
          });
          console.log('📸 中学生コース: screenshots/test-junior-high-school-course.png\n');
        } else {
          console.error(`❌ 中学生コース選択失敗: ${selectResult.error}`);
        }
      }

      // 小学生コースを選択（ユーザー選択画面に戻ってから）
      if (courseSelectionResult.hasElementarySchool) {
        console.log('🔙 ユーザー選択画面に戻ります...');

        // 再度ユーザーを選択
        await userArea.click();
        await authResult.page.waitForTimeout(2000);

        const allUserElements2 = await authResult.page.locator(`text="${firstUser.name}"`).all();
        let targetElement2 = null;

        for (let i = 0; i < allUserElements2.length; i++) {
          const box = await allUserElements2[i].boundingBox().catch(() => null);
          if (box) {
            const viewport = authResult.page.viewportSize();
            if (!(box.x >= viewport.width * 0.5 && box.y <= viewport.height * 0.2)) {
              targetElement2 = allUserElements2[i];
              break;
            }
          }
        }

        if (targetElement2) {
          await targetElement2.click();
          await authResult.page.waitForTimeout(3000);

          console.log('📚 小学生コースを選択中...');
          const selectResult2 = await selectCourse(authResult.page, '小学生コース');

          if (selectResult2.success) {
            console.log('✅ 小学生コース選択成功\n');

            // スクリーンショット
            await authResult.page.screenshot({
              path: 'screenshots/test-elementary-school-course.png',
              fullPage: true
            });
            console.log('📸 小学生コース: screenshots/test-elementary-school-course.png\n');
          } else {
            console.error(`❌ 小学生コース選択失敗: ${selectResult2.error}`);
          }
        }
      }
    } else {
      console.log('ℹ️ コース選択画面は表示されませんでした');
    }

    console.log('\n✅ テスト完了！');
    console.log('\n💡 次のファイルを確認してください:');
    console.log('   - screenshots/test-sidebar-opened.png');
    console.log('   - screenshots/test-after-user-selection.png');
    if (courseSelectionResult.hasCourseSelection) {
      if (courseSelectionResult.hasJuniorHighSchool) {
        console.log('   - screenshots/test-junior-high-school-course.png');
      }
      if (courseSelectionResult.hasElementarySchool) {
        console.log('   - screenshots/test-elementary-school-course.png');
      }
    }

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
testCourseSelection();
