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
    // ユーザー選択UIの要素を取得
    const userElements = await page.locator(selectors.dashboard.userSelector).all();

    // 代替セレクタも試行
    if (userElements.length === 0) {
      const alternativeElements = await page
        .locator(selectors.dashboard.userSelectorAlternative)
        .all();

      if (alternativeElements.length === 0) {
        return {
          success: false,
          error: 'ユーザー要素が見つかりません。画面構造が変更された可能性があります。'
        };
      }

      // 代替セレクタで取得
      const users = [];
      for (let i = 0; i < alternativeElements.length; i++) {
        const name = await alternativeElements[i].textContent();
        users.push({
          name: name.trim(),
          index: i
        });
      }

      return {
        success: true,
        users
      };
    }

    // ユーザー一覧を構築
    const users = [];
    for (let i = 0; i < userElements.length; i++) {
      const name = await userElements[i].textContent();
      users.push({
        name: name.trim(),
        index: i
      });
    }

    if (users.length === 0) {
      return {
        success: false,
        error: 'ユーザーが見つかりません。'
      };
    }

    return {
      success: true,
      users
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
 * 指定ユーザーのミッション数を取得
 *
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @param {number} userIndex - ユーザーのインデックス（0から始まる）
 * @returns {Promise<{success: boolean, count?: number, error?: string}>}
 */
async function getMissionCount(page, userIndex) {
  try {
    // パラメータ検証
    if (userIndex < 0 || !Number.isInteger(userIndex)) {
      return {
        success: false,
        error: '無効なユーザーインデックスです。0以上の整数を指定してください。'
      };
    }

    // ユーザーを選択（クリック）
    const userElements = await page.locator(selectors.dashboard.userSelector).all();

    // 代替セレクタも試行
    let targetElement;
    if (userElements.length > userIndex) {
      targetElement = userElements[userIndex];
    } else {
      const alternativeElements = await page
        .locator(selectors.dashboard.userSelectorAlternative)
        .all();

      if (alternativeElements.length > userIndex) {
        targetElement = alternativeElements[userIndex];
      } else {
        return {
          success: false,
          error: `ユーザーインデックス ${userIndex} が範囲外です。`
        };
      }
    }

    // ユーザーをクリック
    await targetElement.click();

    // ページの安定化を待機
    await page.waitForTimeout(selectors.waitStrategies.userSwitchDelay);

    // ミッション数要素を取得
    let missionElements = await page.locator(selectors.dashboard.missionCount).all();

    // 代替セレクタも試行
    if (missionElements.length === 0) {
      missionElements = await page
        .locator(selectors.dashboard.missionCountAlternative)
        .all();
    }

    // テキストベースのセレクタも試行
    if (missionElements.length === 0) {
      missionElements = await page.locator(selectors.dashboard.missionText).all();
    }

    if (missionElements.length === 0) {
      return {
        success: false,
        error: 'ミッション数要素が見つかりません。画面構造が変更された可能性があります。'
      };
    }

    // 最初の要素からテキストを取得
    const missionText = await missionElements[0].textContent();

    // ミッション数をパース（例: "5ミッション" → 5）
    const match = missionText.match(/(\d+)/);

    if (!match) {
      return {
        success: false,
        error: `ミッション数のパースに失敗しました。テキスト: "${missionText}"`
      };
    }

    const count = parseInt(match[1], 10);

    return {
      success: true,
      count
    };
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
      const missionResult = await getMissionCount(page, user.index);

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
