/**
 * クローラーモジュール - みまもるネットデータ取得
 * Requirements: 3.1, 3.2, 3.3, 3.4, 1.1, 1.2, 2.1, 2.2, 3.1
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
 * 指定ユーザーに切り替える
 * @private
 */
async function switchToUser(page, userName) {
  try {
    console.log(`\n  ユーザーを ${userName} に切り替え中...`);

    // 切り替え前の右上のユーザー名を確認
    const beforeUserName = await getCurrentUserName(page);
    console.log(`  切り替え前の右上表示ユーザー: ${beforeUserName}`);

    // 既に目的のユーザーであればスキップ
    if (beforeUserName === userName) {
      console.log(`  ✅ 既に ${userName} です（切り替え不要）`);
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
      await page.waitForTimeout(2000);

      // メニュー/サイドバー内でユーザー名を探す
      const userInMenu = await page.locator(`text="${userName}"`).first().isVisible({ timeout: 3000 }).catch(() => false);

      if (userInMenu) {
        console.log(`  ✅ メニュー内にユーザー名 "${userName}" を発見`);
        await page.locator(`text="${userName}"`).first().click();
        await page.waitForTimeout(3000);

        // 切り替え成功確認
        await page.waitForLoadState('networkidle').catch(() => {});

        // 切り替え後の右上のユーザー名を確認
        const afterUserName = await getCurrentUserName(page);
        console.log(`  切り替え後の右上表示ユーザー: ${afterUserName}`);

        if (afterUserName !== userName) {
          throw new Error(`ユーザー切り替え検証失敗: 期待=${userName}, 実際=${afterUserName}`);
        }

        console.log(`  ✅ ユーザー切り替え成功: ${userName}`);
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
    await page.waitForTimeout(3000);

    // プロフィールページに遷移した場合は戻る（ここではユーザー切り替えできない）
    const isProfilePage = await page.locator('text="プロフィール設定"').isVisible().catch(() => false);
    if (isProfilePage) {
      console.log(`  ⚠️ プロフィール設定ページに遷移しました（ユーザー切り替えには使えません）`);
      await page.goBack();
      await page.waitForTimeout(2000);
      throw new Error('プロフィールページではユーザー切り替えができません。別の方法を探す必要があります。');
    }

    // サイドバーが開いたか確認
    const sidebarOpened = await page.locator('text="お子さま"').isVisible().catch(() => false);
    if (sidebarOpened) {
      console.log(`  ✅ サイドバーが開きました`);

      // サイドバー内でユーザーを探してクリック
      // まずすべてのユーザー名要素を取得
      const allUserElements = await page.locator(`text="${userName}"`).all();
      console.log(`  🔍 "${userName}" を含む要素数: ${allUserElements.length}`);

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
            console.log(`  ✅ サイドバー内にユーザー名 "${userName}" を発見 [${i}]`);
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
        console.log(`  切り替え後の右上表示ユーザー: ${afterUserName}`);

        if (afterUserName !== userName) {
          throw new Error(`ユーザー切り替え検証失敗: 期待=${userName}, 実際=${afterUserName}`);
        }

        console.log(`  ✅ ユーザー切り替え成功: ${userName}`);
        return { success: true };
      } else {
        throw new Error(`サイドバー内にユーザー "${userName}" が見つかりません`);
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
 * 今日の日付を取得（MM/DD形式、ゼロパディング）
 * @private
 */
function getTodayDate() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${month}/${day}`;
}

/**
 * 今日の完了したミッション数を取得
 * @private
 */
async function getTodayMissionCount(page) {
  try {
    const today = getTodayDate();

    // 今日の日付を含む要素を探す（例: "12/25(木)"）
    const datePattern = new RegExp(`${today}.*?[月火水木金土日]`);
    const todayHeader = page.locator(`text=${datePattern}`).first();

    if (!(await todayHeader.isVisible())) {
      console.log(`  ℹ️ 今日(${today})のデータはまだありません（0件として扱います）`);
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
async function getStudyTime(page) {
  try {
    const { studyTime } = selectors.missionDetails;

    // パース用の柔軟な関数
    const parseStudyTime = (text) => {
      // "X時間Y分" 形式
      const fullMatch = text.match(/(\d+)時間(\d+)分/);
      if (fullMatch) {
        return {
          hours: parseInt(fullMatch[1], 10),
          minutes: parseInt(fullMatch[2], 10)
        };
      }

      // "Y分" のみの形式
      const minutesMatch = text.match(/(\d+)分/);
      if (minutesMatch) {
        return {
          hours: 0,
          minutes: parseInt(minutesMatch[1], 10)
        };
      }

      // "X時間" のみの形式
      const hoursMatch = text.match(/(\d+)時間/);
      if (hoursMatch) {
        return {
          hours: parseInt(hoursMatch[1], 10),
          minutes: 0
        };
      }

      return null;
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
async function getMissionDetails(page) {
  try {
    const today = getTodayDate();

    // 今日の日付要素を探す
    const datePattern = new RegExp(`${today}.*?[月火水木金土日]`);
    const todayHeader = page.locator(`text=${datePattern}`).first();

    if (!(await todayHeader.isVisible({ timeout: 10000 }))) {
      console.log(`  ℹ️ 今日(${today})のデータはまだありません（空配列として扱います）`);
      return {
        success: true,
        missions: []
      };
    }

    // 全ての日付要素を取得（左側のラベルのみ、X座標 < 250）
    const allDateElements = await page.locator('text=/\\d+\\/\\d+/').all();
    const allDates = [];

    // 日付ラベル（左側）のみをフィルタリング
    for (const el of allDateElements) {
      const box = await el.boundingBox();
      if (box && box.x < 250) {
        const text = await el.textContent();
        allDates.push({ element: el, text, box });
      }
    }

    // 今日の日付のインデックスを見つける
    let todayIndex = -1;
    for (let i = 0; i < allDates.length; i++) {
      if (allDates[i].text.includes(today)) {
        todayIndex = i;
        break;
      }
    }

    if (todayIndex === -1) {
      console.log(`  ℹ️ 今日(${today})のデータインデックスが見つかりません（空配列として扱います）`);
      return {
        success: true,
        missions: []
      };
    }

    // 今日の日付要素の位置を取得
    const todayBox = await todayHeader.boundingBox();
    if (!todayBox) {
      console.log(`  ℹ️ 今日(${today})の日付要素の位置情報が取得できません（空配列として扱います）`);
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

    console.log(`📋 今日(${today})のミッション詳細: ${missions.length}件`);

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
    console.log(`\n👤 ${userName}のミッション数を取得中...`);

    // ユーザーに切り替える
    const switchResult = await switchToUser(page, userName);
    if (!switchResult.success) {
      return switchResult;
    }

    // 今日のミッション数を取得
    const missionResult = await getTodayMissionCount(page);

    console.log(`✅ ${userName}: ${missionResult.count}件`);

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
 * 全ユーザーの詳細データを取得（v2.0形式）
 * Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 6.2, 6.3, 6.4
 *
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @returns {Promise<{success: boolean, data?: Array<{userName: string, missionCount: number, date: string, studyTime: {hours: number, minutes: number}, totalScore: number, missions: Array}>, error?: string, partialFailure?: boolean, detailsAvailable?: boolean}>}
 */
async function getAllUsersDetailedData(page) {
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

    // 当日の日付を取得（YYYY-MM-DD形式）
    const today = new Date();
    const dateString = today.toISOString().split('T')[0];

    // 各ユーザーのデータを取得
    for (let i = 0; i < users.length; i++) {
      const user = users[i];

      console.log(`\n👤 ${user.name}のデータを取得中...`);

      // ユーザーに切り替える
      const switchResult = await switchToUser(page, user.name);

      if (!switchResult.success) {
        hasPartialFailure = true;
        console.error(`  ❌ ユーザー切り替え失敗: ${switchResult.error}`);
        continue;
      }

      // 勉強時間を取得
      const studyTimeResult = await getStudyTime(page);
      const studyTime = studyTimeResult.success
        ? { hours: studyTimeResult.hours, minutes: studyTimeResult.minutes }
        : { hours: 0, minutes: 0 };

      if (!studyTimeResult.success) {
        console.warn(`  ⚠️ 勉強時間取得失敗: ${studyTimeResult.error}`);
        hasPartialFailure = true;
      }

      // ミッション数を取得
      const missionCountResult = await getTodayMissionCount(page);
      const missionCount = missionCountResult.success ? missionCountResult.count : 0;

      if (!missionCountResult.success) {
        console.warn(`  ⚠️ ミッション数取得失敗: ${missionCountResult.error}`);
        hasPartialFailure = true;
      }

      // ミッション詳細を取得
      const missionsResult = await getMissionDetails(page);
      const missions = missionsResult.success ? missionsResult.missions : [];

      if (!missionsResult.success) {
        console.warn(`  ⚠️ ミッション詳細取得失敗: ${missionsResult.error}`);
        hasPartialFailure = true;
        detailsAvailable = false;
      }

      // 合計点数を計算
      const totalScore = getTotalScore(missions);

      // v2.0データ構造で格納
      data.push({
        userName: user.name,
        missionCount,
        date: dateString,
        studyTime,
        totalScore,
        missions
      });

      console.log(`  ✅ ${user.name}: 勉強時間=${studyTime.hours}h${studyTime.minutes}m, ミッション=${missionCount}件, 点数=${totalScore}点`);
    }

    // 少なくとも1件成功していれば、部分的な成功として扱う
    if (data.length > 0) {
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
  getAllUsersMissionCounts,
  getAllUsersDetailedData,
  getStudyTime,
  getMissionDetails,
  getTotalScore,
  switchToUser
};
