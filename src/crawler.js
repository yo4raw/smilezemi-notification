/**
 * クローラーモジュール - みまもるネットデータ取得
 * Requirements: 3.1, 3.2, 3.3, 3.4
 */

const selectors = require('./config/selectors');

/**
 * ログイン後のページからユーザー一覧を取得
 *
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @returns {Promise<{success: boolean, users?: Array<{name: string, index: number}>, error?: string}>}
 */
async function getUserList(page) {
  try {
    // 画面右上のユーザー名エリアをクリックしてサイドバーを開く
    const userArea = page.locator('div').filter({ hasText: 'さん' }).first();
    await userArea.click();
    await page.waitForTimeout(2000);

    // 「お子さま」セクションの後に続くユーザー名を探す
    const childrenHeader = page.locator('text="お子さま"');

    if (!(await childrenHeader.isVisible())) {
      return {
        success: false,
        error: '「お子さま」セクションが見つかりません。画面構造が変更された可能性があります。'
      };
    }

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
        users.push({
          name: userName,
          index: users.length
        });
      }
    }

    // 重複を除去
    const uniqueUsers = users.filter((user, index, self) =>
      index === self.findIndex((u) => u.name === user.name)
    );

    // サイドバーを閉じる（ESCキー）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    if (uniqueUsers.length === 0) {
      return {
        success: false,
        error: 'ユーザーが見つかりません。'
      };
    }

    return {
      success: true,
      users: uniqueUsers
    };
  } catch (error) {
    if (error.message.includes('Timeout')) {
      return {
        success: false,
        error: `タイムアウト: ユーザー一覧の取得に時間がかかりすぎました - ${error.message}`
      };
    }

    return {
      success: false,
      error: `ユーザー一覧取得エラー: ${error.message}`
    };
  }
}

/**
 * 指定ユーザーに切り替える
 * @private
 */
async function switchToUser(page, userName) {
  try {
    // ユーザー名エリアをクリックしてサイドバーを開く
    const userArea = page.locator('div').filter({ hasText: 'さん' }).first();
    await userArea.click();
    await page.waitForTimeout(1500);

    // ユーザーを選択
    const targetUser = page.locator(`text="${userName}"`).first();

    if (!(await targetUser.isVisible())) {
      return {
        success: false,
        error: `ユーザー "${userName}" が表示されていません`
      };
    }

    await targetUser.click({ force: true });
    await page.waitForTimeout(2000);

    // サイドバーを閉じる（ESCキー）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // 「日々のとりくみ」タブをクリック
    const dailyTab = page.locator('text="日々のとりくみ"');
    if (await dailyTab.isVisible()) {
      await dailyTab.click();
      await page.waitForTimeout(3000);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `ユーザー切り替えエラー: ${error.message}`
    };
  }
}

/**
 * 今日の日付を取得（M/D形式）
 * @private
 */
function getTodayDate() {
  const today = new Date();
  return `${today.getMonth() + 1}/${today.getDate()}`;
}

/**
 * 今日のミッション数を取得
 * @private
 */
async function getTodayMissionCount(page) {
  try {
    const today = getTodayDate();

    // 今日の日付を含む要素を探す（例: "12/25(木)"）
    const datePattern = new RegExp(`${today}.*?[月火水木金土日]`);
    const todayHeader = page.locator(`text=${datePattern}`).first();

    if (!(await todayHeader.isVisible())) {
      return {
        success: false,
        error: `今日(${today})のデータが見つかりません`,
        count: 0
      };
    }

    // 全ての日付要素を取得
    const allDates = await page.locator('text=/\\d+\\/\\d+/').all();

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
      return {
        success: false,
        error: '今日の日付のインデックスが見つかりません',
        count: 0
      };
    }

    // 全ての「ミッション」要素を取得
    const allMissions = await page.locator('text=/ミッション/').all();

    // 今日の日付要素のbounding boxを取得
    const todayBox = await todayHeader.boundingBox();

    if (!todayBox) {
      return {
        success: false,
        error: '今日の日付のbounding boxが取得できません',
        count: 0
      };
    }

    // 次の日付の位置を取得
    let nextDateY = Infinity;
    const nextDateIndex = todayIndex + 1;

    if (nextDateIndex < allDates.length) {
      const nextDateBox = await allDates[nextDateIndex].boundingBox();
      if (nextDateBox) {
        nextDateY = nextDateBox.y;
      }
    }

    // 今日の日付より下で、次の日付より上にあるミッション要素を数える
    let missionCount = 0;
    for (const mission of allMissions) {
      const missionBox = await mission.boundingBox();
      if (missionBox && missionBox.y > todayBox.y && missionBox.y < nextDateY) {
        missionCount++;
      }
    }

    return {
      success: true,
      count: missionCount
    };
  } catch (error) {
    return {
      success: false,
      error: `ミッション数取得エラー: ${error.message}`,
      count: 0
    };
  }
}

/**
 * 指定ユーザーのミッション数を取得
 *
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @param {string} userName - ユーザー名
 * @returns {Promise<{success: boolean, count?: number, error?: string}>}
 */
async function getMissionCount(page, userName) {
  try {
    // ユーザーに切り替える
    const switchResult = await switchToUser(page, userName);
    if (!switchResult.success) {
      return switchResult;
    }

    // 今日のミッション数を取得
    const missionResult = await getTodayMissionCount(page);
    return missionResult;

  } catch (error) {
    if (error.message.includes('Timeout')) {
      return {
        success: false,
        error: `タイムアウト: ミッション数の取得に時間がかかりすぎました - ${error.message}`
      };
    }

    return {
      success: false,
      error: `ミッション数取得エラー: ${error.message}`
    };
  }
}

/**
 * 全ユーザーのミッション数を取得
 *
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @returns {Promise<{success: boolean, data?: Array<{userName: string, missionCount: number, date: string}>, error?: string, partialFailure?: boolean}>}
 */
async function getAllUsersMissionCounts(page) {
  try {
    // ユーザー一覧を取得
    const userListResult = await getUserList(page);

    if (!userListResult.success) {
      return {
        success: false,
        error: userListResult.error
      };
    }

    const users = userListResult.users;
    const data = [];
    let hasPartialFailure = false;

    // 当日の日付を取得（YYYY-MM-DD形式）
    const today = new Date();
    const dateString = today.toISOString().split('T')[0];

    // 各ユーザーのミッション数を取得
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const missionResult = await getMissionCount(page, user.name);

      if (missionResult.success) {
        data.push({
          userName: user.name,
          missionCount: missionResult.count,
          date: dateString
        });
      } else {
        // 一部失敗しても継続
        hasPartialFailure = true;
        console.error(
          `ユーザー "${user.name}" のミッション数取得に失敗: ${missionResult.error}`
        );
      }
    }

    // 少なくとも1件成功していれば、部分的な成功として扱う
    if (data.length > 0) {
      return {
        success: true,
        data,
        partialFailure: hasPartialFailure
      };
    }

    // 全て失敗した場合
    return {
      success: false,
      error: '全てのユーザーのミッション数取得に失敗しました。'
    };
  } catch (error) {
    return {
      success: false,
      error: `全ユーザーのミッション数取得エラー: ${error.message}`
    };
  }
}

module.exports = {
  getUserList,
  getMissionCount,
  getAllUsersMissionCounts
};
