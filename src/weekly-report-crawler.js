/**
 * 週間レポート（指導レポート）クローラーモジュール
 * みまもるネットの指導レポートページからデータを取得する
 */

const selectors = require('./config/selectors');
const {
  getUserList,
  switchToUser,
  checkCourseSelection,
  selectCourse,
  returnToCourseSelection
} = require('./crawler');

/**
 * 名前をマスクしてログ出力用にする（最後の1文字のみ表示）
 * @param {string} name - ユーザー名
 * @returns {string} マスクされた名前
 */
function maskName(name) {
  if (!name || name.length <= 1) return name || '';
  return '*'.repeat(name.length - 1) + name.slice(-1);
}

/**
 * 指導レポートページに遷移する
 * タイムライン画面から「指導レポート」タブをクリックして遷移
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function navigateToGuidanceReport(page) {
  try {
    const reportTab = page.locator(selectors.weeklyReport.reportTab);
    const isVisible = await reportTab.isVisible({ timeout: 5000 }).catch(() => false);

    if (!isVisible) {
      // タブが見つからない場合、まず「とりくみ」タブが表示されているか確認
      const torikumiTab = page.locator('button:has-text("とりくみ")');
      const hasTorikumi = await torikumiTab.isVisible({ timeout: 3000 }).catch(() => false);

      if (hasTorikumi) {
        // 「とりくみ」タブをクリックしてサブタブを表示
        await torikumiTab.click();
        await page.waitForTimeout(2000);

        const retryVisible = await reportTab.isVisible({ timeout: 5000 }).catch(() => false);
        if (!retryVisible) {
          return { success: false, error: '指導レポートタブが見つかりません' };
        }
      } else {
        return { success: false, error: '指導レポートタブが見つかりません' };
      }
    }

    await reportTab.click();
    await page.waitForTimeout(selectors.weeklyReport.tabClickWaitTime);

    // URL確認
    const currentUrl = page.url();
    if (currentUrl.includes('guidance-report')) {
      console.log('✅ 指導レポートページに遷移しました');
      return { success: true };
    }

    // URLが変わらなくてもコンテンツが表示されていればOK
    const sectionTitle = page.locator(selectors.weeklyReport.sectionTitle).first();
    const hasSectionTitle = await sectionTitle.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasSectionTitle) {
      console.log('✅ 指導レポートのコンテンツが表示されています');
      return { success: true };
    }

    return { success: false, error: '指導レポートページへの遷移を確認できません' };
  } catch (error) {
    return { success: false, error: `指導レポートページ遷移エラー: ${error.message}` };
  }
}

/**
 * 指導レポートページからデータを抽出する
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function getGuidanceReport(page) {
  try {
    // page.evaluate()でDOMを正確にたどってデータを抽出
    // DOM構造:
    //   .detail__Mq_GO
    //     .instructionMessageRoot__luz50 (とりくみの様子)
    //       .titleArea__q_TjB.result__jjiPN > .title__jXeZJ
    //       .message__JrLLL > span (テキスト)
    //     .instructionMessageRoot__luz50 (今後の指導) ← 取得しない
    //     .caption__mUTwZ (褒めポイント)
    //     .praiseMessageRoot__lmfJ9 > span (各ポイント)
    //     .caption__mUTwZ (とりくみ時間)
    const reportData = await page.evaluate(() => {
      const result = { period: '', torikumi: '', praisePoints: [] };

      // 期間を取得（例: "3月9日～3月15日"）
      const allSpans = document.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent.trim();
        if (text.includes('～') && text.includes('月') && text.includes('日')) {
          result.period = text;
          break;
        }
      }

      // 「とりくみの様子」: .result__jjiPN を持つ instructionMessageRoot 内の .message__JrLLL のspan
      const torikumiRoot = document.querySelector('.instructionMessageRoot__luz50:has(.result__jjiPN)');
      if (torikumiRoot) {
        const messageDiv = torikumiRoot.querySelector('.message__JrLLL');
        if (messageDiv) {
          const spans = messageDiv.querySelectorAll('span');
          const texts = [];
          for (const span of spans) {
            const t = span.textContent.trim();
            if (t) texts.push(t);
          }
          result.torikumi = texts.join('\n');
        }
      }

      // 「褒めポイント」: .praiseMessageRoot__lmfJ9 内のspan
      const praiseRoots = document.querySelectorAll('.praiseMessageRoot__lmfJ9');
      for (const root of praiseRoots) {
        const span = root.querySelector('span');
        if (span) {
          const t = span.textContent.trim();
          if (t) result.praisePoints.push(t);
        }
      }

      return result;
    });

    console.log(`  📅 期間: ${reportData.period || '取得できませんでした'}`);
    console.log(`  📝 とりくみの様子: ${reportData.torikumi ? reportData.torikumi.substring(0, 50) + '...' : '取得できませんでした'}`);
    console.log(`  🏅 頑張ったところ: ${reportData.praisePoints.length}件`);

    return {
      success: true,
      data: reportData
    };
  } catch (error) {
    return { success: false, error: `指導レポートデータ取得エラー: ${error.message}` };
  }
}

/**
 * 全ユーザーの週間レポートを取得する
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
async function getAllUsersWeeklyReport(page) {
  const results = [];
  let partialFailure = false;

  try {
    // ユーザー一覧を取得
    console.log('👥 ユーザー一覧を取得しています...');
    const userListResult = await getUserList(page);

    if (!userListResult.success) {
      return { success: false, error: `ユーザー一覧取得失敗: ${userListResult.error}` };
    }

    const users = userListResult.users;
    console.log(`✅ ユーザー一覧取得完了（${users.length}名）`);

    for (const user of users) {
      console.log(`\n👤 ${maskName(user.name)} のレポートを取得中...`);

      try {
        // ユーザー切替
        const switchResult = await switchToUser(page, user.name);
        if (!switchResult.success) {
          console.error(`  ❌ ユーザー切替失敗: ${switchResult.error}`);
          partialFailure = true;
          continue;
        }

        // コース選択の確認
        const courseResult = await checkCourseSelection(page);

        if (courseResult.hasCourseSelection) {
          // コースがある場合、各コースで指導レポートを取得
          const courses = [];
          if (courseResult.hasJuniorHighSchool) courses.push('中学生コース');
          if (courseResult.hasElementarySchool) courses.push('小学生コース');

          for (let ci = 0; ci < courses.length; ci++) {
            const course = courses[ci];
            console.log(`  📚 ${course} のレポートを取得中...`);

            try {
              await selectCourse(page, course);

              // 指導レポートページに遷移
              const navResult = await navigateToGuidanceReport(page);
              if (!navResult.success) {
                console.error(`    ❌ 指導レポート遷移失敗: ${navResult.error}`);
                partialFailure = true;
              } else {
                // データ取得
                const reportResult = await getGuidanceReport(page);
                if (reportResult.success) {
                  results.push({
                    userName: `${user.name}（${course}）`,
                    report: reportResult.data
                  });
                } else {
                  console.error(`    ❌ レポート取得失敗: ${reportResult.error}`);
                  partialFailure = true;
                }
              }

              // コース選択画面に戻る（最後のコース以外）
              if (ci < courses.length - 1) {
                await returnToCourseSelection(page, user.name);
              }
            } catch (courseError) {
              console.error(`    ❌ ${course}の処理でエラー: ${courseError.message}`);
              partialFailure = true;
            }
          }

          // 次のユーザーのためにタイムラインに戻る
          await page.goto('https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await page.waitForTimeout(2000);

        } else {
          // コース選択なし - 直接指導レポートを取得
          const navResult = await navigateToGuidanceReport(page);
          if (!navResult.success) {
            console.error(`  ❌ 指導レポート遷移失敗: ${navResult.error}`);
            partialFailure = true;
          } else {
            const reportResult = await getGuidanceReport(page);
            if (reportResult.success) {
              results.push({
                userName: user.name,
                report: reportResult.data
              });
            } else {
              console.error(`  ❌ レポート取得失敗: ${reportResult.error}`);
              partialFailure = true;
            }
          }

          // 次のユーザーのためにタイムラインに戻る
          await page.goto('https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await page.waitForTimeout(2000);
        }

      } catch (userError) {
        console.error(`  ❌ ${maskName(user.name)}の処理でエラー: ${userError.message}`);
        partialFailure = true;
      }
    }

    if (results.length === 0) {
      return { success: false, error: '全ユーザーのレポート取得に失敗しました' };
    }

    return {
      success: true,
      data: results,
      partialFailure
    };

  } catch (error) {
    return { success: false, error: `週間レポート取得エラー: ${error.message}` };
  }
}

module.exports = {
  navigateToGuidanceReport,
  getGuidanceReport,
  getAllUsersWeeklyReport
};
