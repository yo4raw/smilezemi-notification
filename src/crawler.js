/**
 * クローラーモジュール - みまもるネットデータ取得
 * Requirements: 3.1, 3.2, 3.3, 3.4, 1.1, 1.2, 2.1, 2.2, 3.1
 */

const selectors = require('./config/selectors');

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
    // サイドバー（「お子さま」セクション）の表示を待つ
    await page.waitForSelector(selectors.sidebar.childrenHeader, {
      state: 'visible',
      timeout: selectors.sidebar.openTimeout
    }).catch(() => {});

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

      // 「お子さま」や「おとうさん」、「コース」などを除外し、子アカウント名のみを取得
      if (userName.length < 20 &&
          userName !== 'お子さま' &&
          !userName.includes('おとう') &&
          !userName.includes('おかあ') &&
          !userName.includes('コース')) {
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
 * 右上に表示されている現在のユーザー名を取得
 * @private
 */
async function getCurrentUserName(page) {
  try {
    const viewport = page.viewportSize();
    const rightHalfX = viewport.width * 0.5; // 画面の右半分
    const topAreaY = viewport.height * 0.2; // 画面の上部20%

    const candidates = await page.locator('div').filter({ hasText: 'さん' }).all();

    for (const candidate of candidates) {
      const box = await candidate.boundingBox().catch(() => null);
      const text = await candidate.innerText().catch(() => '');
      const isVisible = await candidate.isVisible().catch(() => false);

      // 右上エリアに位置し、短いテキスト（ユーザー名）で、可視であること
      if (box &&
          box.x >= rightHalfX &&
          box.y <= topAreaY &&
          isVisible &&
          text.trim().length > 0 &&
          text.trim().length < 20 &&
          text.trim().endsWith('さん')) {
        return text.trim();
      }
    }

    throw new Error('右上のユーザー名が見つかりません');
  } catch (error) {
    throw new Error(`現在のユーザー名取得エラー: ${error.message}`);
  }
}

/**
 * コース選択画面が表示されているかチェック
 * @private
 */
async function checkCourseSelection(page) {
  try {
    const { courseSelection } = selectors;
    const viewport = page.viewportSize();

    // サイドバー内のコース切替ボタンは画面外(x >= viewport.width)に transform で押し出されているが
    // display:block / visibility:visible のまま残っているため isVisible() は true を返す。
    // 本物のコース選択画面のボタンのみを検出するため、boundingBox の中心が viewport 内に
    // 収まっているかで絞り込む。
    const isActuallyVisible = async (selector) => {
      const locator = page.locator(selector).first();
      const visible = await locator
        .isVisible({ timeout: courseSelection.courseSelectionWaitTime })
        .catch(() => false);
      if (!visible) return false;
      if (!viewport) return true;
      const box = await locator.boundingBox().catch(() => null);
      if (!box) return false;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      return cx >= 0 && cy >= 0 && cx < viewport.width && cy < viewport.height;
    };

    const juniorHighSchoolVisible = await isActuallyVisible(courseSelection.juniorHighSchool);
    const elementarySchoolVisible = await isActuallyVisible(courseSelection.elementarySchool);

    return {
      hasCourseSelection: juniorHighSchoolVisible || elementarySchoolVisible,
      hasJuniorHighSchool: juniorHighSchoolVisible,
      hasElementarySchool: elementarySchoolVisible
    };
  } catch (error) {
    return {
      hasCourseSelection: false,
      hasJuniorHighSchool: false,
      hasElementarySchool: false
    };
  }
}

/**
 * コースを選択する
 * @private
 */
async function selectCourse(page, courseName) {
  try {
    const { courseSelection } = selectors;

    console.log(`  📚 コース選択: ${courseName}`);

    let courseLocator;
    if (courseName === '中学生コース') {
      courseLocator = page.locator(courseSelection.juniorHighSchool).first();
    } else if (courseName === '小学生コース') {
      courseLocator = page.locator(courseSelection.elementarySchool).first();
    } else {
      return {
        success: false,
        error: `不明なコース名: ${courseName}`
      };
    }

    // コース要素が表示されているか確認
    const isVisible = await courseLocator.isVisible({ timeout: 5000 }).catch(() => false);

    if (!isVisible) {
      return {
        success: false,
        error: `コース "${courseName}" が見つかりません`
      };
    }

    // コースをクリック
    await courseLocator.click();
    await page.waitForTimeout(3000);

    // ページ遷移を待機
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log(`  ✅ ${courseName}を選択しました`);

    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error: `コース選択エラー: ${error.message}`
    };
  }
}

/**
 * 指定ユーザーに切り替える
 * @private
 */
async function switchToUser(page, userName) {
  try {
    console.log(`\n  ユーザーを ${maskName(userName)} に切り替え中...`);

    // 切り替え前の右上のユーザー名を確認
    const beforeUserName = await getCurrentUserName(page);
    console.log(`  切り替え前の右上表示ユーザー: ${maskName(beforeUserName)}`);

    // 既に目的のユーザーであればスキップ
    if (beforeUserName === userName) {
      console.log(`  ✅ 既に ${maskName(userName)} です（切り替え不要）`);
      return { success: true };
    }

    // 既にサイドバーが開いている場合は閉じる
    const sidebarOpenCheck = await page.locator('text="お子さま"').isVisible().catch(() => false);
    if (sidebarOpenCheck) {
      console.log(`  既にサイドバーが開いているため、閉じます`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    }

    // 方法1: 左上のMENUボタンからユーザー切り替えを試みる
    console.log(`  [方法1] 左上のMENUボタンをクリック...`);
    const menuButton = page.locator('text="MENU"').first();
    const menuVisible = await menuButton.isVisible().catch(() => false);

    if (menuVisible) {
      await menuButton.click();
      // メニュー内に対象ユーザー名が表示されるのを待つ
      await page.waitForSelector(`text="${userName}"`, {
        state: 'visible',
        timeout: selectors.sidebar.menuItemTimeout
      }).catch(() => {});

      // メニュー/サイドバー内でユーザー名を探す
      const userInMenu = await page.locator(`text="${userName}"`).first().isVisible({ timeout: 3000 }).catch(() => false);

      if (userInMenu) {
        console.log(`  ✅ メニュー内にユーザー名 "${maskName(userName)}" を発見`);
        await page.locator(`text="${userName}"`).first().click();
        await page.waitForTimeout(3000);

        // 切り替え成功確認
        await page.waitForLoadState('networkidle').catch(() => {});

        // 切り替え後の右上のユーザー名を確認
        const afterUserName = await getCurrentUserName(page);
        console.log(`  切り替え後の右上表示ユーザー: ${maskName(afterUserName)}`);

        if (afterUserName !== userName) {
          throw new Error(`ユーザー切り替え検証失敗: 期待=${maskName(userName)}, 実際=${maskName(afterUserName)}`);
        }

        console.log(`  ✅ ユーザー切り替え成功: ${maskName(userName)}`);
        return { success: true };
      } else {
        console.log(`  ⚠️ メニュー内にユーザー名が見つかりません、メニューを閉じます`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      }
    } else {
      console.log(`  ⚠️ MENUボタンが見つかりません`);
    }

    // 方法2: 右上のユーザーエリアをクリックしてサイドバーを開く
    console.log(`  [方法2] 右上のユーザーエリアを探索...`);

    // 右上のユーザー名エリアを位置基準で探す
    const viewport = page.viewportSize();
    const rightHalfX = viewport.width * 0.5;
    const topAreaY = viewport.height * 0.2;

    const userNameCandidates = await page.locator('div').filter({ hasText: 'さん' }).all();
    let userArea = null;

    for (const candidate of userNameCandidates) {
      const box = await candidate.boundingBox().catch(() => null);
      const text = await candidate.innerText().catch(() => '');
      const isVisible = await candidate.isVisible().catch(() => false);

      // 右上エリアに位置し、短いテキスト（ユーザー名）で、可視であること
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
      throw new Error('右上のユーザーエリアが見つかりません');
    }

    console.log(`  右上のユーザーエリアをクリック...`);

    // クリックしてサイドバーまたはメニューを開く
    await userArea.click({ timeout: 5000 });
    // サイドバー表示 or プロフィールページ遷移のどちらかを待つ
    await Promise.race([
      page.waitForSelector(selectors.sidebar.childrenHeader, {
        state: 'visible',
        timeout: selectors.sidebar.openTimeout
      }).catch(() => {}),
      page.waitForSelector(selectors.sidebar.profileSettings, {
        state: 'visible',
        timeout: selectors.sidebar.openTimeout
      }).catch(() => {})
    ]);

    // プロフィールページに遷移した場合は戻る（ここではユーザー切り替えできない）
    const isProfilePage = await page.locator('text="プロフィール設定"').isVisible().catch(() => false);
    if (isProfilePage) {
      console.log(`  ⚠️ プロフィール設定ページに遷移しました（ユーザー切り替えには使えません）`);
      await page.goBack();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      throw new Error('プロフィールページではユーザー切り替えができません。別の方法を探す必要があります。');
    }

    // サイドバーが開いたか確認
    const sidebarOpened = await page.locator('text="お子さま"').isVisible().catch(() => false);
    if (sidebarOpened) {
      console.log(`  ✅ サイドバーが開きました`);

      // サイドバー内でユーザーを探してクリック
      // まずすべてのユーザー名要素を取得
      const allUserElements = await page.locator(`text="${userName}"`).all();
      console.log(`  🔍 "${maskName(userName)}" を含む要素数: ${allUserElements.length}`);

      // サイドバー内（右上以外）の要素を探す
      let targetElement = null;
      for (let i = 0; i < allUserElements.length; i++) {
        const box = await allUserElements[i].boundingBox().catch(() => null);
        if (box) {
          console.log(`  🔍 [${i}] 位置: x=${Math.round(box.x)}, y=${Math.round(box.y)}`);

          // 右上のユーザー名エリア以外の要素を選択
          // （右上は画面の右半分 x >= width * 0.5 かつ上部 y <= height * 0.2）
          const viewport = page.viewportSize();
          if (!(box.x >= viewport.width * 0.5 && box.y <= viewport.height * 0.2)) {
            targetElement = allUserElements[i];
            console.log(`  ✅ サイドバー内にユーザー名 "${maskName(userName)}" を発見 [${i}]`);
            break;
          }
        }
      }

      if (targetElement) {
        await targetElement.click();
        await page.waitForTimeout(3000);

        // サイドバーを閉じる
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);

        // 切り替え成功確認
        await page.waitForLoadState('networkidle').catch(() => {});

        // 切り替え後の右上のユーザー名を確認
        const afterUserName = await getCurrentUserName(page);
        console.log(`  切り替え後の右上表示ユーザー: ${maskName(afterUserName)}`);

        if (afterUserName !== userName) {
          throw new Error(`ユーザー切り替え検証失敗: 期待=${maskName(userName)}, 実際=${maskName(afterUserName)}`);
        }

        console.log(`  ✅ ユーザー切り替え成功: ${maskName(userName)}`);
        return { success: true };
      } else {
        throw new Error(`サイドバー内にユーザー "${maskName(userName)}" が見つかりません`);
      }
    }

    // どの方法でもサイドバー/メニューが開かなかった
    await page.screenshot({ path: `screenshots/user-switch-failed-${Date.now()}.png` });
    throw new Error('サイドバーまたはメニューを開くことができませんでした');

  } catch (error) {
    console.error(`  エラー: ${error.message}`);
    return {
      success: false,
      error: `ユーザー切り替えエラー: ${error.message}`
    };
  }
}

/**
 * コース選択画面に戻る（サイドバーから同じユーザーを再選択）
 * @private
 */
async function returnToCourseSelection(page, userName) {
  try {
    console.log(`    🔙 コース選択画面に戻ります...`);

    const viewport = page.viewportSize();
    const rightHalfX = viewport.width * 0.5;
    const topAreaY = viewport.height * 0.2;

    // サイドバーが既に開いている場合は閉じる
    const sidebarAlreadyOpen = await page.locator('text="お子さま"').isVisible().catch(() => false);
    if (sidebarAlreadyOpen) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    }

    // 右上のユーザー名エリアを探す
    const userNameCandidates = await page.locator('div').filter({ hasText: 'さん' }).all();
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
        console.log(`    ✅ 右上のユーザー名エリアを発見: ${maskName(text.trim())}`);
        break;
      }
    }

    if (!userArea) {
      return {
        success: false,
        error: '右上のユーザー名エリアが見つかりません'
      };
    }

    // ユーザー名エリアをクリックしてサイドバーを開く
    await userArea.click({ timeout: 5000 });
    // サイドバー（「お子さま」セクション）の表示を待つ
    await page.waitForSelector(selectors.sidebar.childrenHeader, {
      state: 'visible',
      timeout: selectors.sidebar.openTimeout
    }).catch(() => {});

    // サイドバーが開いたか確認
    const sidebarOpened = await page.locator('text="お子さま"').isVisible().catch(() => false);
    if (!sidebarOpened) {
      return {
        success: false,
        error: 'サイドバーを開くことができませんでした'
      };
    }

    console.log(`    ✅ サイドバーが開きました`);

    // サイドバー内で同じユーザー名を探してクリック
    const allUserElements = await page.locator(`text="${userName}"`).all();
    console.log(`    🔍 "${maskName(userName)}" を含む要素数: ${allUserElements.length}`);

    let targetElement = null;
    for (let i = 0; i < allUserElements.length; i++) {
      const box = await allUserElements[i].boundingBox().catch(() => null);
      if (box) {
        // 右上のユーザー名エリア以外の要素を選択
        if (!(box.x >= rightHalfX && box.y <= topAreaY)) {
          targetElement = allUserElements[i];
          console.log(`    ✅ サイドバー内にユーザー名 "${maskName(userName)}" を発見 [${i}]`);
          break;
        }
      }
    }

    if (!targetElement) {
      return {
        success: false,
        error: `サイドバー内にユーザー "${maskName(userName)}" が見つかりません`
      };
    }

    // 同じユーザーを再度クリック
    await targetElement.click();
    await page.waitForTimeout(3000);

    // ページ遷移を待機
    await page.waitForLoadState('networkidle').catch(() => {});
    // コース選択ボタンの表示を待つ（checkCourseSelection は即時判定のため事前に待機）
    await Promise.race([
      page.waitForSelector(selectors.courseSelection.juniorHighSchool, {
        state: 'visible',
        timeout: selectors.waitStrategies.courseSelectionAppearTimeout
      }).catch(() => {}),
      page.waitForSelector(selectors.courseSelection.elementarySchool, {
        state: 'visible',
        timeout: selectors.waitStrategies.courseSelectionAppearTimeout
      }).catch(() => {})
    ]);

    // コース選択画面が表示されているか確認
    const courseSelectionResult = await checkCourseSelection(page);
    if (courseSelectionResult.hasCourseSelection) {
      console.log(`    ✅ コース選択画面に戻りました`);
      return { success: true };
    }

    return {
      success: false,
      error: 'コース選択画面が表示されませんでした'
    };

  } catch (error) {
    return {
      success: false,
      error: `コース選択画面への復帰エラー: ${error.message}`
    };
  }
}

/**
 * 中学生コースかどうかを判定
 * @private
 * @param {string|null} courseName - コース名（getCourseDataから渡される）
 * @param {import('playwright').Page} page - フォールバック用
 * @returns {boolean}
 */
function isJuniorHighSchool(courseName, page) {
  // コース名が明示的に渡された場合はそれで判定
  if (courseName) {
    return courseName === '中学生コース';
  }
  // フォールバック: URLで判定
  return page.url().includes('/study/c/');
}

/**
 * コース選択画面での取得対象コースを決定する
 * @param {{hasJuniorHighSchool: boolean, hasElementarySchool: boolean}} courseSelection
 * @param {'elementary'|'juniorHigh'|null} courseFilter - null は現行互換(中学生優先)
 * @returns {string[]} 取得対象コース名の配列(対象なしは空配列 = スキップ)
 */
function resolveTargetCourses(courseSelection, courseFilter) {
  if (courseFilter === 'elementary') {
    // 中学生コースを持つユーザー(両コース持ち含む)は朝通知側の対象のためスキップ
    return !courseSelection.hasJuniorHighSchool && courseSelection.hasElementarySchool
      ? ['小学生コース']
      : [];
  }
  if (courseFilter === 'juniorHigh') {
    return courseSelection.hasJuniorHighSchool ? ['中学生コース'] : [];
  }
  // 現行互換: 両コース持ちは中学生コースのみ
  if (courseSelection.hasJuniorHighSchool) return ['中学生コース'];
  if (courseSelection.hasElementarySchool) return ['小学生コース'];
  return [];
}

/**
 * コース選択画面が出ない単一コースユーザーが取得対象かを判定する
 * @param {string} pageUrl - 現在のページURL(/study/c/ = 中学生コース)
 * @param {'elementary'|'juniorHigh'|null} courseFilter
 * @returns {boolean}
 */
function shouldProcessSingleCourseUser(pageUrl, courseFilter) {
  const isJuniorHigh = pageUrl.includes('/study/c/');
  if (courseFilter === 'elementary') return !isJuniorHigh;
  if (courseFilter === 'juniorHigh') return isJuniorHigh;
  return true;
}

/**
 * 対象日の日付を取得（JST基準、MM/DD形式）
 * GitHub Actions コンテナは UTC のため、ローカル時刻ではなく JST を明示して計算する。
 * @param {number} dateOffset - 0=今日、-1=昨日
 * @returns {{withPadding: string, withoutPadding: string, dateString: string}}
 */
function getTargetDates(dateOffset = 0) {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const target = new Date(Date.now() + JST_OFFSET_MS + dateOffset * 24 * 60 * 60 * 1000);
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth() + 1;
  const day = target.getUTCDate();

  return {
    withPadding: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
    withoutPadding: `${month}/${day}`,
    dateString: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

/**
 * 中学生コース: 今日の日付セクション（dailyRoot）を取得
 * @private
 * @param {import('playwright').Page} page
 * @returns {Promise<{element: import('playwright').Locator|null, dateText: string|null}>}
 */
async function findTodayDailyRootForJuniorHigh(page, dateOffset = 0) {
  const todayDates = getTargetDates(dateOffset);
  const { juniorHighTimeline } = selectors;

  const dailyRoots = await page.locator(juniorHighTimeline.dailyRoot).all();

  for (const root of dailyRoots) {
    const dateLabel = root.locator(juniorHighTimeline.dateLabel).first();
    const dateText = await dateLabel.textContent().catch(() => '');

    for (const pattern of [todayDates.withPadding, todayDates.withoutPadding]) {
      if (dateText.includes(pattern)) {
        return { element: root, dateText: pattern };
      }
    }
  }

  return { element: null, dateText: null };
}

/**
 * 中学生コース: 勉強時間を取得
 * @private
 */
async function getStudyTimeForJuniorHigh(page, dateOffset = 0) {
  try {
    const todayDates = getTargetDates(dateOffset);
    const { element: todayRoot } = await findTodayDailyRootForJuniorHigh(page, dateOffset);

    if (!todayRoot) {
      console.log(`  ℹ️ [中学生] 今日(${todayDates.withPadding})のデータが見つかりません（勉強時間: 0時間0分）`);
      return { success: true, hours: 0, minutes: 0 };
    }

    // studyDateInner内の時間テキスト（例: "6分"）を取得
    const studyDateInner = todayRoot.locator(selectors.juniorHighTimeline.studyDateInner).first();
    const innerText = await studyDateInner.textContent().catch(() => '');

    // "6分" や "1時間30分" をパース
    let hours = 0;
    let minutes = 0;
    const fullMatch = innerText.match(/(\d+)時間(\d+)分/);
    if (fullMatch) {
      hours = parseInt(fullMatch[1], 10);
      minutes = parseInt(fullMatch[2], 10);
    } else {
      const minutesMatch = innerText.match(/(\d+)分/);
      if (minutesMatch) {
        minutes = parseInt(minutesMatch[1], 10);
      }
      const hoursMatch = innerText.match(/(\d+)時間/);
      if (hoursMatch) {
        hours = parseInt(hoursMatch[1], 10);
      }
    }

    if (minutes >= 60) {
      hours += Math.floor(minutes / 60);
      minutes = minutes % 60;
    }

    console.log(`📚 [中学生] 勉強時間: ${hours}時間${minutes}分`);
    return { success: true, hours, minutes };
  } catch (error) {
    return { success: false, error: `[中学生] 勉強時間取得エラー: ${error.message}`, hours: 0, minutes: 0 };
  }
}

/**
 * 中学生コース: 今日の講座数を取得
 * @private
 */
async function getTodayMissionCountForJuniorHigh(page, dateOffset = 0) {
  try {
    const todayDates = getTargetDates(dateOffset);
    const { element: todayRoot } = await findTodayDailyRootForJuniorHigh(page, dateOffset);

    if (!todayRoot) {
      console.log(`  ℹ️ [中学生] 今日(${todayDates.withPadding})のデータはまだありません（0件として扱います）`);
      return { success: true, count: 0 };
    }

    // subject__bWHro 内の course__KrAEA をカウント
    const courses = await todayRoot.locator('.course__KrAEA').all();
    const count = courses.length;

    console.log(`📊 [中学生] 今日(${todayDates.withPadding})の講座数: ${count}件`);
    return { success: true, count };
  } catch (error) {
    return { success: false, error: `[中学生] 講座数取得エラー: ${error.message}`, count: 0 };
  }
}

/**
 * 中学生コース: 今日の講座詳細を取得
 * @private
 */
async function getMissionDetailsForJuniorHigh(page, dateOffset = 0) {
  try {
    const todayDates = getTargetDates(dateOffset);
    const { element: todayRoot } = await findTodayDailyRootForJuniorHigh(page, dateOffset);

    if (!todayRoot) {
      console.log(`  ℹ️ [中学生] 今日(${todayDates.withPadding})のデータが見つかりません（空配列として扱います）`);
      return { success: true, missions: [] };
    }

    const { juniorHighTimeline } = selectors;
    const missions = [];

    // 各教科グループを取得
    const subjectGroups = await todayRoot.locator(juniorHighTimeline.subjectGroup).all();

    for (const subjectGroup of subjectGroups) {
      // 教科名を取得（例: "数学"）
      const subjectNameEl = subjectGroup.locator(juniorHighTimeline.subjectName).first();
      const subjectName = await subjectNameEl.textContent().catch(() => '');

      // 各講座を取得
      const courseElements = await subjectGroup.locator('.course__KrAEA').all();

      for (const courseEl of courseElements) {
        // 講座名を取得（例: "いろいろな図形"）
        const courseNameEl = courseEl.locator(juniorHighTimeline.courseName).first();
        const courseName = await courseNameEl.textContent().catch(() => '');

        // スコアを取得（例: "66%"）
        const scoreEl = courseEl.locator(juniorHighTimeline.courseResult).first();
        const scoreText = await scoreEl.textContent().catch(() => '');
        const scoreMatch = scoreText.match(/(\d+)/);
        const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

        const name = subjectName && courseName
          ? `${subjectName.trim()}: ${courseName.trim()}`
          : courseName.trim() || subjectName.trim() || 'ミッション';

        missions.push({
          name,
          score,
          completed: true
        });

        if (missions.length >= 10) break;
      }

      if (missions.length >= 10) break;
    }

    console.log(`📋 [中学生] 今日(${todayDates.withPadding})の講座詳細: ${missions.length}件`);
    return { success: true, missions };
  } catch (error) {
    return { success: false, error: `[中学生] 講座詳細取得エラー: ${error.message}`, missions: [] };
  }
}

/**
 * 今日の完了したミッション数を取得
 * @private
 */
async function getTodayMissionCount(page, courseName = null, dateOffset = 0) {
  // 中学生コースの場合は専用ロジックを使用
  if (isJuniorHighSchool(courseName, page)) {
    return getTodayMissionCountForJuniorHigh(page, dateOffset);
  }

  try {
    const todayDates = getTargetDates(dateOffset);

    // 両方のパターンで検索（ゼロパディングあり・なし）
    const patterns = [todayDates.withPadding, todayDates.withoutPadding];
    let today = null;
    let todayHeader = null;

    for (const pattern of patterns) {
      const datePattern = new RegExp(`${pattern.replace('/', '\\/')}.*?[月火水木金土日]`);
      const header = page.locator(`text=${datePattern}`).first();

      if (await header.isVisible().catch(() => false)) {
        today = pattern;
        todayHeader = header;
        break;
      }
    }

    if (!todayHeader || !today) {
      console.log(`  ℹ️ 今日(${todayDates.withPadding}または${todayDates.withoutPadding})のデータはまだありません（0件として扱います）`);
      return {
        success: true,
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
      console.log(`  ℹ️ 今日(${today})のデータインデックスが見つかりません（0件として扱います）`);
      return {
        success: true,
        count: 0
      };
    }

    // 今日の日付要素のbounding boxを取得
    const todayBox = await todayHeader.boundingBox();

    if (!todayBox) {
      console.log(`  ℹ️ 今日(${today})の日付要素の位置情報が取得できません（0件として扱います）`);
      return {
        success: true,
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

    // 今日の日付セクション内のミッション要素を取得
    // class="missionIcon__i6nW8"を持つ<span>ミッション</span>のみを対象
    const allMissionIcons = await page.locator('.missionIcon__i6nW8').all();
    let completedMissionCount = 0;
    let totalMissionCount = 0;

    for (const missionIcon of allMissionIcons) {
      const box = await missionIcon.boundingBox();
      if (box && box.y > todayBox.y && box.y < nextDateY) {
        totalMissionCount++;

        // 親要素（subIcon__p_BWc）を取得して、NEWラベルの有無を確認
        const parent = missionIcon.locator('..');
        const hasNewLabel = await parent.locator('text="NEW"').count() > 0;

        // NEWラベルがない = 完了したミッション
        if (!hasNewLabel) {
          completedMissionCount++;
        }
      }
    }

    console.log(`📊 今日(${today})の総ミッション数: ${totalMissionCount}件`);
    console.log(`📊 今日(${today})の完了ミッション数: ${completedMissionCount}件`);

    return {
      success: true,
      count: completedMissionCount
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
 * 勉強時間を取得
 * Requirements: 1.1, 1.2, 1.3, 6.1
 * @private
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @returns {Promise<{success: boolean, hours?: number, minutes?: number, error?: string}>}
 */
async function getStudyTime(page, courseName = null, dateOffset = 0) {
  // 中学生コースの場合は専用ロジックを使用
  if (isJuniorHighSchool(courseName, page)) {
    return getStudyTimeForJuniorHigh(page, dateOffset);
  }

  try {
    const todayDates = getTargetDates(dateOffset);
    const { studyTime } = selectors.missionDetails;

    // まず今日の日付があるかチェック
    let isTodayVisible = false;
    for (const pattern of [todayDates.withPadding, todayDates.withoutPadding]) {
      const datePattern = new RegExp(`${pattern.replace('/', '\\/')}.*?[月火水木金土日]`);
      const header = page.locator(`text=${datePattern}`).first();

      if (await header.isVisible({ timeout: 2000 }).catch(() => false)) {
        isTodayVisible = true;
        break;
      }
    }

    // 今日の日付がない場合、0時間0分を返す
    if (!isTodayVisible) {
      console.log(`  ℹ️ 今日(${todayDates.withPadding})のデータが見つかりません（勉強時間: 0時間0分）`);
      return {
        success: true,
        hours: 0,
        minutes: 0
      };
    }

    // パース用の柔軟な関数
    const parseStudyTime = (text) => {
      let hours = 0;
      let minutes = 0;

      // "X時間Y分" 形式
      const fullMatch = text.match(/(\d+)時間(\d+)分/);
      if (fullMatch) {
        hours = parseInt(fullMatch[1], 10);
        minutes = parseInt(fullMatch[2], 10);
      } else {
        // "Y分" のみの形式
        const minutesMatch = text.match(/(\d+)分/);
        if (minutesMatch) {
          minutes = parseInt(minutesMatch[1], 10);
        } else {
          // "X時間" のみの形式
          const hoursMatch = text.match(/(\d+)時間/);
          if (hoursMatch) {
            hours = parseInt(hoursMatch[1], 10);
          } else {
            return null;
          }
        }
      }

      // 分が60以上の場合は時間に変換
      if (minutes >= 60) {
        hours += Math.floor(minutes / 60);
        minutes = minutes % 60;
      }

      return {
        hours,
        minutes
      };
    };

    // 勉強時間要素を探す（タイムアウト5秒）
    const timeElement = page.locator(studyTime.selector).first();
    const isVisible = await timeElement.isVisible({ timeout: 5000 }).catch(() => false);

    if (!isVisible) {
      // セレクタで見つからない場合、代替セレクタを試行
      for (const altSelector of studyTime.alternativeSelectors) {
        const altElement = page.locator(altSelector).first();
        const altVisible = await altElement.isVisible({ timeout: 2000 }).catch(() => false);

        if (altVisible) {
          const text = await altElement.textContent();
          const parsed = parseStudyTime(text);

          if (parsed) {
            console.log(`📚 勉強時間: ${parsed.hours}時間${parsed.minutes}分`);
            return {
              success: true,
              hours: parsed.hours,
              minutes: parsed.minutes
            };
          }
        }
      }

      // 全て失敗した場合はデフォルト値
      console.log(`  ℹ️ 勉強時間要素が見つかりません（0時間0分として扱います）`);
      return {
        success: true,
        hours: 0,
        minutes: 0
      };
    }

    // テキストを取得してパース
    const text = await timeElement.textContent();
    const parsed = parseStudyTime(text);

    if (!parsed) {
      console.log(`  ℹ️ 勉強時間のパースに失敗: "${text}"（0時間0分として扱います）`);
      return {
        success: true,
        hours: 0,
        minutes: 0
      };
    }

    console.log(`📚 勉強時間: ${parsed.hours}時間${parsed.minutes}分`);

    return {
      success: true,
      hours: parsed.hours,
      minutes: parsed.minutes
    };
  } catch (error) {
    return {
      success: false,
      error: `勉強時間取得エラー: ${error.message}`,
      hours: 0,
      minutes: 0
    };
  }
}

/**
 * 今日のミッション詳細を取得（名前と点数）
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.3, 6.2
 * @private
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @returns {Promise<{success: boolean, missions?: Array<{name: string, score: number, completed: boolean}>, error?: string}>}
 */
async function getMissionDetails(page, courseName = null, dateOffset = 0) {
  // 中学生コースの場合は専用ロジックを使用
  if (isJuniorHighSchool(courseName, page)) {
    return getMissionDetailsForJuniorHigh(page, dateOffset);
  }

  try {
    const todayDates = getTargetDates(dateOffset);

    // ページを上部にスクロールして最新のデータを表示
    await page.evaluate(() => window.scrollTo(0, 0));
    // スクロール完了と日付要素の描画を待つ
    await page.waitForFunction(() => window.scrollY === 0, {
      timeout: selectors.waitStrategies.scrollStabilizeTimeout
    }).catch(() => {});
    await page.waitForSelector('text=/\\d+\\/\\d+/', {
      state: 'visible',
      timeout: selectors.waitStrategies.timelineDateTimeout
    }).catch(() => {});

    // デバッグ用スクリーンショット
    await page.screenshot({ path: 'screenshots/mission-details-debug.png', fullPage: true });
    console.log(`  📸 スクリーンショット保存: screenshots/mission-details-debug.png`);

    // ページ内の全ての日付テキストを取得してログ出力
    const allDateElements = await page.locator('text=/\\d+\\/\\d+/').all();
    const allDatesText = [];
    for (const el of allDateElements) {
      const text = await el.textContent();
      allDatesText.push(text);
    }
    console.log(`  📅 検出された日付: ${allDatesText.join(', ')}`);
    console.log(`  🔍 検索中の日付: ${todayDates.withPadding} または ${todayDates.withoutPadding}`);

    // 今日の日付要素を探す（両方のパターンで検索）
    let targetDate = null;
    let todayHeader = null;
    let isTodayVisible = false;

    for (const pattern of [todayDates.withPadding, todayDates.withoutPadding]) {
      const datePattern = new RegExp(`${pattern.replace('/', '\\/')}.*?[月火水木金土日]`);
      const header = page.locator(`text=${datePattern}`).first();

      if (await header.isVisible({ timeout: 2000 }).catch(() => false)) {
        targetDate = pattern;
        todayHeader = header;
        isTodayVisible = true;
        console.log(`  ✅ 今日(${pattern})のデータが見つかりました`);
        break;
      }
    }

    // 今日の日付が見つからない場合、空の配列を返す
    if (!isTodayVisible) {
      console.log(`  ℹ️ 今日(${todayDates.withPadding})のデータが見つかりません（空配列として扱います）`);
      return {
        success: true,
        missions: []
      };
    }

    // 全ての日付要素を取得（左側のラベルのみ、X座標 < 250）
    const allDates = [];

    // 日付ラベル（左側）のみをフィルタリング
    for (const el of allDateElements) {
      const box = await el.boundingBox();
      if (box && box.x < 250) {
        const text = await el.textContent();
        allDates.push({ element: el, text, box });
      }
    }

    // 対象日付のインデックスを見つける
    let todayIndex = -1;
    for (let i = 0; i < allDates.length; i++) {
      if (allDates[i].text.includes(targetDate)) {
        todayIndex = i;
        break;
      }
    }

    if (todayIndex === -1) {
      console.log(`  ℹ️ 対象日付(${targetDate})のデータインデックスが見つかりません（空配列として扱います）`);
      return {
        success: true,
        missions: []
      };
    }

    // 対象日付要素の位置を取得
    const todayBox = await todayHeader.boundingBox();
    if (!todayBox) {
      console.log(`  ℹ️ 対象日付(${targetDate})の日付要素の位置情報が取得できません（空配列として扱います）`);
      return {
        success: true,
        missions: []
      };
    }

    // 次の日付の位置を取得（左側の日付ラベルのみ）
    let nextDateY = Infinity;
    const nextDateIndex = todayIndex + 1;
    if (nextDateIndex < allDates.length) {
      nextDateY = allDates[nextDateIndex].box.y;
    }

    // 今日のセクション内のミッションアイコンを取得
    const allMissionIcons = await page.locator('.missionIcon__i6nW8').all();
    const missions = [];

    for (const missionIcon of allMissionIcons) {
      const box = await missionIcon.boundingBox();

      // 今日のセクション内のミッションのみ処理
      if (box && box.y > todayBox.y && box.y < nextDateY) {
        // 親要素を取得
        const parent = missionIcon.locator('..');

        // NEWラベルの有無で完了判定
        const hasNewLabel = await parent.locator('text="NEW"').count() > 0;
        const completed = !hasNewLabel;

        // ミッション名を取得（親要素の兄弟として.title__C3bzFを探す）
        let missionName = selectors.missionDetails.missionName.defaultName;

        // 親要素の兄弟要素を取得（grandparent > children）
        const grandparent = parent.locator('..');
        const titleElements = await grandparent.locator('.title__C3bzF').all();

        if (titleElements.length > 0) {
          const titleText = await titleElements[0].textContent().catch(() => '');
          if (titleText && titleText.trim().length > 0) {
            missionName = titleText.trim();
          }
        } else {
          // fallback: 親要素のテキストから抽出
          const parentText = await parent.textContent().catch(() => '');
          const cleanText = parentText.replace(/NEW/g, '').replace(/\d+点/g, '').replace(/前回/g, '').trim();
          if (cleanText.length > 0 && cleanText.length < 100) {
            missionName = cleanText;
          }
        }

        // 点数を取得（学習結果エリアから現在の点数を取得）
        // 点数は右側の「学習結果」カラムにあり、ミッションアイコンから離れた場所にあるため、
        // より広い範囲（行全体レベル）で検索する
        let score = selectors.missionDetails.missionScore.defaultScore;

        // 複数の階層レベルで点数を検索
        const searchLevels = [
          grandparent,                           // 親の親
          grandparent.locator('..'),              // 親の親の親（great-grandparent）
          grandparent.locator('..').locator('..') // さらに上の階層
        ];

        for (const level of searchLevels) {
          const scoreElements = await level.locator('text=/\\d+点/').all();

          if (scoreElements.length > 0) {
            const scores = [];

            for (const scoreElement of scoreElements) {
              const scoreText = await scoreElement.textContent().catch(() => '');

              // 「前回」を含むテキストは除外（前回の点数ではなく現在の点数を取得）
              if (scoreText.includes('前回')) {
                continue;
              }

              // 数値を抽出
              const scoreMatch = scoreText.match(/(\d+)点/);
              if (scoreMatch) {
                scores.push(parseInt(scoreMatch[1], 10));
              }
            }

            // 点数が見つかった場合、最大値を使用（現在の点数）
            if (scores.length > 0) {
              score = Math.max(...scores);
              break; // 点数が見つかったので検索終了
            }
          }
        }

        missions.push({
          name: missionName,
          score,
          completed
        });

        // 最大10件に制限
        if (missions.length >= 10) {
          break;
        }
      }
    }

    console.log(`📋 今日(${targetDate})のミッション詳細: ${missions.length}件`);

    return {
      success: true,
      missions
    };
  } catch (error) {
    return {
      success: false,
      error: `ミッション詳細取得エラー: ${error.message}`,
      missions: []
    };
  }
}

/**
 * ミッション配列から合計点数を計算
 * Requirements: 3.2, 3.4
 * @param {Array<{name: string, score: number, completed: boolean}>} missions - ミッション配列
 * @returns {number} 合計点数
 */
function getTotalScore(missions) {
  if (!Array.isArray(missions) || missions.length === 0) {
    return 0;
  }

  return missions.reduce((total, mission) => total + (mission.score || 0), 0);
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
    console.log(`\n👤 ${maskName(userName)}のミッション数を取得中...`);

    // ユーザーに切り替える
    const switchResult = await switchToUser(page, userName);
    if (!switchResult.success) {
      return switchResult;
    }

    // 今日のミッション数を取得
    const missionResult = await getTodayMissionCount(page);

    console.log(`✅ ${maskName(userName)}: ${missionResult.count}件`);

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
 * コースのデータを取得（共通処理）
 * @private
 */
async function getCourseData(page, userName, courseName, dateString, dateOffset = 0) {
  try {
    let detailsAvailable = true;

    // 勉強時間を取得
    const studyTimeResult = await getStudyTime(page, courseName, dateOffset);
    const studyTime = studyTimeResult.success
      ? { hours: studyTimeResult.hours, minutes: studyTimeResult.minutes }
      : { hours: 0, minutes: 0 };

    if (!studyTimeResult.success) {
      console.warn(`      ⚠️ 勉強時間取得失敗: ${studyTimeResult.error}`);
    }

    // ミッション数を取得
    const missionCountResult = await getTodayMissionCount(page, courseName, dateOffset);
    const missionCount = missionCountResult.success ? missionCountResult.count : 0;

    if (!missionCountResult.success) {
      console.warn(`      ⚠️ ミッション数取得失敗: ${missionCountResult.error}`);
    }

    // ミッション詳細を取得
    const missionsResult = await getMissionDetails(page, courseName, dateOffset);
    const missions = missionsResult.success ? missionsResult.missions : [];

    if (!missionsResult.success) {
      console.warn(`      ⚠️ ミッション詳細取得失敗: ${missionsResult.error}`);
      detailsAvailable = false;
    }

    // 合計点数を計算
    const totalScore = getTotalScore(missions);

    // ユーザー名にコース名を追加（コース選択がある場合）
    const displayName = courseName ? `${userName} (${courseName})` : userName;

    // v2.0データ構造で返却
    return {
      success: true,
      data: {
        userName: displayName,
        missionCount,
        date: dateString,
        studyTime,
        totalScore,
        missions
      },
      detailsAvailable
    };
  } catch (error) {
    return {
      success: false,
      error: `コースデータ取得エラー: ${error.message}`,
      detailsAvailable: false
    };
  }
}

/**
 * 全ユーザーの詳細データを取得（v2.0形式）
 * Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 6.2, 6.3, 6.4
 *
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @returns {Promise<{success: boolean, data?: Array<{userName: string, missionCount: number, date: string, studyTime: {hours: number, minutes: number}, totalScore: number, missions: Array}>, error?: string, partialFailure?: boolean, detailsAvailable?: boolean}>}
 */
async function getAllUsersDetailedData(page, options = {}) {
  const { courseFilter = null, dateOffset = 0 } = options;

  try {
    // ユーザー一覧を取得
    const userListResult = await getUserList(page);

    if (!userListResult.success) {
      return {
        success: false,
        error: userListResult.error,
        detailsAvailable: false
      };
    }

    const users = userListResult.users;
    const data = [];
    let hasPartialFailure = false;
    let detailsAvailable = true;

    // 対象日の日付を取得（JST基準、YYYY-MM-DD形式）
    const dateString = getTargetDates(dateOffset).dateString;

    // 各ユーザーのデータを取得
    for (let i = 0; i < users.length; i++) {
      const user = users[i];

      console.log(`\n👤 ${maskName(user.name)}のデータを取得中...`);

      // ユーザーに切り替える
      const switchResult = await switchToUser(page, user.name);

      if (!switchResult.success) {
        hasPartialFailure = true;
        console.error(`  ❌ ユーザー切り替え失敗: ${switchResult.error}`);
        continue;
      }

      // コース選択画面が表示されているかチェック
      const courseSelectionResult = await checkCourseSelection(page);

      if (courseSelectionResult.hasCourseSelection) {
        console.log(`  📚 コース選択画面が表示されています`);
        console.log(`    中学生コース: ${courseSelectionResult.hasJuniorHighSchool ? 'あり' : 'なし'}`);
        console.log(`    小学生コース: ${courseSelectionResult.hasElementarySchool ? 'あり' : 'なし'}`);

        // courseFilter に応じて取得対象コースを決定(対象なしはスキップ)
        const courses = resolveTargetCourses(courseSelectionResult, courseFilter);

        if (courses.length === 0) {
          console.log(`  ℹ️ ${maskName(user.name)} は対象コースがないためスキップします`);
        }

        // 各コースのデータを取得
        for (const courseName of courses) {
          console.log(`\n  📖 ${courseName}のデータを取得中...`);

          // コースを選択
          const selectResult = await selectCourse(page, courseName);

          if (!selectResult.success) {
            console.error(`    ❌ コース選択失敗: ${selectResult.error}`);
            hasPartialFailure = true;
            continue;
          }

          // コース選択後のデータ取得
          const courseData = await getCourseData(page, user.name, courseName, dateString, dateOffset);

          if (courseData.success) {
            data.push(courseData.data);
            console.log(`    ✅ ${courseName}: 勉強時間=${courseData.data.studyTime.hours}h${courseData.data.studyTime.minutes}m, ミッション=${courseData.data.missionCount}件, 点数=${courseData.data.totalScore}点`);
          } else {
            hasPartialFailure = true;
            console.error(`    ❌ データ取得失敗: ${courseData.error}`);
          }

          // 次のコースのために、コース選択画面に戻る
          if (courses.indexOf(courseName) < courses.length - 1) {
            const returnResult = await returnToCourseSelection(page, user.name);
            if (!returnResult.success) {
              console.error(`    ❌ コース選択画面への復帰失敗: ${returnResult.error}`);
              hasPartialFailure = true;
              break;
            }
          }
        }
      } else if (!shouldProcessSingleCourseUser(page.url(), courseFilter)) {
        // 単一コースユーザーが対象外の場合はスキップ
        // (continue は使わず、ループ末尾のタイムライン復帰処理を必ず通す)
        console.log(`  ℹ️ ${maskName(user.name)} は対象コースではないためスキップします`);
      } else {
        // コース選択画面がない場合は、従来通りのデータ取得
        console.log(`  📖 データを取得中（コース選択なし）...`);

        const courseData = await getCourseData(page, user.name, null, dateString, dateOffset);

        if (courseData.success) {
          data.push(courseData.data);
          console.log(`  ✅ ${maskName(user.name)}: 勉強時間=${courseData.data.studyTime.hours}h${courseData.data.studyTime.minutes}m, ミッション=${courseData.data.missionCount}件, 点数=${courseData.data.totalScore}点`);
        } else {
          hasPartialFailure = true;
          console.error(`  ❌ データ取得失敗: ${courseData.error}`);
        }
      }

      // 次ユーザーへの切替前に小学生コースのタイムラインへ戻す。
      // 中学生コース (/study/c/...) のページに居る状態のままサイドバーから
      // 小学生コース単独ユーザーを選んでも切り替わらない事象があるため、
      // 各ユーザー処理の最後に明示的にホーム位置へ戻しておく。
      if (i < users.length - 1) {
        try {
          await page.goto('https://smile-zemi.jp/mimamoru-net/ui/study/s/timeline', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await page.waitForTimeout(2000);
        } catch (gotoError) {
          console.warn(`  ⚠️ タイムラインへの復帰に失敗しました: ${gotoError.message}`);
        }
      }
    }

    // 少なくとも1件成功していれば部分的な成功として扱う。
    // データ0件でも失敗がなければ「対象ユーザーなし」として成功扱い(courseFilter適用時)
    if (data.length > 0 || !hasPartialFailure) {
      return {
        success: true,
        data,
        partialFailure: hasPartialFailure,
        detailsAvailable
      };
    }

    // 全て失敗した場合
    return {
      success: false,
      error: '全てのユーザーのデータ取得に失敗しました。',
      detailsAvailable: false
    };
  } catch (error) {
    return {
      success: false,
      error: `全ユーザーの詳細データ取得エラー: ${error.message}`,
      detailsAvailable: false
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
          `ユーザー "${maskName(user.name)}" のミッション数取得に失敗: ${missionResult.error}`
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
  getAllUsersMissionCounts,
  getAllUsersDetailedData,
  getStudyTime,
  getMissionDetails,
  getTotalScore,
  getTargetDates,
  resolveTargetCourses,
  shouldProcessSingleCourseUser,
  switchToUser,
  checkCourseSelection,
  selectCourse,
  returnToCourseSelection
};
