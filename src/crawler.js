/**
 * クローラーモジュール - みまもるネットデータ取得
 */

const fs = require('fs').promises;
const path = require('path');
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

    if (!(await page.locator(selectors.sidebar.childrenHeader).isVisible())) {
      return {
        success: false,
        error: '「お子さま」セクションが見つかりません。画面構造が変更された可能性があります。'
      };
    }

    // 「お子さま」の後に続く要素でユーザー名（「さん」で終わる）を探す
    const userElements = await page.locator('text=/.*さん$/').all();
    const names = [];

    for (const element of userElements) {
      const userName = (await element.textContent()).trim();

      // 「お子さま」や「おとうさん」、「コース」などを除外し、子アカウント名のみを取得
      if (userName.length < 20 &&
          userName !== 'お子さま' &&
          !userName.includes('おとう') &&
          !userName.includes('おかあ') &&
          !userName.includes('コース') &&
          !names.includes(userName)) {
        names.push(userName);
      }
    }

    // サイドバーを閉じる（ESCキー）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    if (names.length === 0) {
      return { success: false, error: 'ユーザーが見つかりません。' };
    }

    return { success: true, users: names.map((name, index) => ({ name, index })) };
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
 * 座標が「右上のユーザー名エリア」(画面右半分かつ上部20%)に入っているか
 * @private
 */
function isTopRight(box, viewport) {
  return box.x >= viewport.width * 0.5 && box.y <= viewport.height * 0.2;
}

/**
 * 画面右上のユーザー名エリアを座標で見つける
 *
 * 右上にある「さん」で終わる短い可視テキストの div を右上のユーザー名とみなす。
 *
 * @private
 * @param {import('playwright').Page} page
 * @returns {Promise<{element: import('playwright').Locator, text: string}|null>}
 */
async function findTopRightUserArea(page) {
  const viewport = page.viewportSize();
  const candidates = await page.locator('div').filter({ hasText: 'さん' }).all();

  for (const candidate of candidates) {
    const box = await candidate.boundingBox().catch(() => null);
    const text = (await candidate.innerText().catch(() => '')).trim();
    const isVisible = await candidate.isVisible().catch(() => false);

    if (box && isTopRight(box, viewport) && isVisible &&
        text.length > 0 && text.length < 20 && text.endsWith('さん')) {
      return { element: candidate, text };
    }
  }

  return null;
}

/**
 * 右上に表示されている現在のユーザー名を取得
 * @private
 */
async function getCurrentUserName(page) {
  const userArea = await findTopRightUserArea(page);
  if (!userArea) {
    throw new Error('右上のユーザー名が見つかりません');
  }
  return userArea.text;
}

/**
 * サイドバー内(右上のユーザー名エリア以外)にあるユーザー名要素を探す
 * @private
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function findSidebarUserElement(page, userName) {
  const viewport = page.viewportSize();
  const elements = await page.locator(`text="${userName}"`).all();
  console.log(`  🔍 "${maskName(userName)}" を含む要素数: ${elements.length}`);

  for (const element of elements) {
    const box = await element.boundingBox().catch(() => null);
    if (box && !isTopRight(box, viewport)) {
      return element;
    }
  }

  return null;
}

/**
 * サイドバーが開いていれば閉じる
 * @private
 */
async function closeSidebarIfOpen(page) {
  if (await page.locator(selectors.sidebar.childrenHeader).isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
  }
}

/**
 * 右上のユーザー名エリアをクリックしてサイドバーを開く
 *
 * クリック先がプロフィール設定ページに遷移することがあるため、どちらになったかも返す。
 *
 * @private
 * @returns {Promise<{opened: boolean, profilePage: boolean}>}
 */
async function openSidebar(page) {
  const userArea = await findTopRightUserArea(page);
  if (!userArea) {
    throw new Error('右上のユーザーエリアが見つかりません');
  }

  await userArea.element.click({ timeout: 5000 });

  // サイドバー表示 or プロフィールページ遷移のどちらかを待つ
  await Promise.race([selectors.sidebar.childrenHeader, selectors.sidebar.profileSettings].map(selector =>
    page.waitForSelector(selector, { state: 'visible', timeout: selectors.sidebar.openTimeout }).catch(() => {})
  ));

  const profilePage = await page.locator(selectors.sidebar.profileSettings).isVisible().catch(() => false);
  const opened = !profilePage && await page.locator(selectors.sidebar.childrenHeader).isVisible().catch(() => false);
  return { opened, profilePage };
}

/**
 * 切り替え後に右上の表示名が目的のユーザーになったか検証する
 * @private
 */
async function verifySwitched(page, userName) {
  await page.waitForLoadState('networkidle').catch(() => {});

  const afterUserName = await getCurrentUserName(page);
  console.log(`  切り替え後の右上表示ユーザー: ${maskName(afterUserName)}`);

  if (afterUserName !== userName) {
    throw new Error(`ユーザー切り替え検証失敗: 期待=${maskName(userName)}, 実際=${maskName(afterUserName)}`);
  }

  console.log(`  ✅ ユーザー切り替え成功: ${maskName(userName)}`);
  return { success: true };
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

    const hasJuniorHighSchool = await isActuallyVisible(courseSelection.juniorHighSchool);
    const hasElementarySchool = await isActuallyVisible(courseSelection.elementarySchool);

    return {
      hasCourseSelection: hasJuniorHighSchool || hasElementarySchool,
      hasJuniorHighSchool,
      hasElementarySchool
    };
  } catch {
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

    const courseSelector = { '中学生コース': courseSelection.juniorHighSchool, '小学生コース': courseSelection.elementarySchool }[courseName];
    if (!courseSelector) {
      return { success: false, error: `不明なコース名: ${courseName}` };
    }

    const courseLocator = page.locator(courseSelector).first();
    if (!(await courseLocator.isVisible({ timeout: 5000 }).catch(() => false))) {
      return { success: false, error: `コース "${courseName}" が見つかりません` };
    }

    await courseLocator.click();
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log(`  ✅ ${courseName}を選択しました`);
    return { success: true };
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

    const beforeUserName = await getCurrentUserName(page);
    console.log(`  切り替え前の右上表示ユーザー: ${maskName(beforeUserName)}`);

    if (beforeUserName === userName) {
      console.log(`  ✅ 既に ${maskName(userName)} です（切り替え不要）`);
      return { success: true };
    }

    await closeSidebarIfOpen(page);

    // 方法1: 左上のMENUボタンからユーザー切り替えを試みる
    console.log(`  [方法1] 左上のMENUボタンをクリック...`);
    const menuButton = page.locator('text="MENU"').first();

    if (await menuButton.isVisible().catch(() => false)) {
      await menuButton.click();
      // メニュー内に対象ユーザー名が表示されるのを待つ
      await page.waitForSelector(`text="${userName}"`, {
        state: 'visible',
        timeout: selectors.sidebar.menuItemTimeout
      }).catch(() => {});

      const userInMenu = page.locator(`text="${userName}"`).first();
      if (await userInMenu.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`  ✅ メニュー内にユーザー名 "${maskName(userName)}" を発見`);
        await userInMenu.click();
        await page.waitForTimeout(3000);
        return await verifySwitched(page, userName);
      }

      console.log(`  ⚠️ メニュー内にユーザー名が見つかりません、メニューを閉じます`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    } else {
      console.log(`  ⚠️ MENUボタンが見つかりません`);
    }

    // 方法2: 右上のユーザーエリアをクリックしてサイドバーを開く
    console.log(`  [方法2] 右上のユーザーエリアを探索...`);
    const { opened, profilePage } = await openSidebar(page);

    if (profilePage) {
      console.log(`  ⚠️ プロフィール設定ページに遷移しました（ユーザー切り替えには使えません）`);
      await page.goBack();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      throw new Error('プロフィールページではユーザー切り替えができません。別の方法を探す必要があります。');
    }

    if (!opened) {
      await page.screenshot({ path: `screenshots/user-switch-failed-${Date.now()}.png` });
      throw new Error('サイドバーまたはメニューを開くことができませんでした');
    }

    console.log(`  ✅ サイドバーが開きました`);

    const targetElement = await findSidebarUserElement(page, userName);
    if (!targetElement) {
      throw new Error(`サイドバー内にユーザー "${maskName(userName)}" が見つかりません`);
    }

    await targetElement.click();
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    return await verifySwitched(page, userName);

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

    await closeSidebarIfOpen(page);

    const { opened } = await openSidebar(page);
    if (!opened) {
      return { success: false, error: 'サイドバーを開くことができませんでした' };
    }
    console.log(`    ✅ サイドバーが開きました`);

    const targetElement = await findSidebarUserElement(page, userName);
    if (!targetElement) {
      return { success: false, error: `サイドバー内にユーザー "${maskName(userName)}" が見つかりません` };
    }

    // 同じユーザーを再度クリックするとコース選択画面に戻る
    await targetElement.click();
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});

    // コース選択ボタンの表示を待つ（checkCourseSelection は即時判定のため事前に待機）
    await Promise.race([selectors.courseSelection.juniorHighSchool, selectors.courseSelection.elementarySchool].map(selector =>
      page.waitForSelector(selector, {
        state: 'visible',
        timeout: selectors.waitStrategies.courseSelectionAppearTimeout
      }).catch(() => {})
    ));

    if ((await checkCourseSelection(page)).hasCourseSelection) {
      console.log(`    ✅ コース選択画面に戻りました`);
      return { success: true };
    }

    return { success: false, error: 'コース選択画面が表示されませんでした' };

  } catch (error) {
    return {
      success: false,
      error: `コース選択画面への復帰エラー: ${error.message}`
    };
  }
}

/**
 * 中学生コースかどうかを判定
 * @param {string|null} courseName - コース名（コース選択画面を経由した場合）
 * @param {import('playwright').Page} page - フォールバック用(URLで判定)
 * @returns {boolean}
 */
function isJuniorHighSchool(courseName, page) {
  if (courseName) {
    return courseName === '中学生コース';
  }
  return page.url().includes('/study/c/');
}

/**
 * 対象日の日付を取得（JST基準）
 * GitHub Actions コンテナは UTC のため、タイムゾーンを明示して求める。
 * @param {number} dateOffset - 0=今日、-1=昨日
 * @returns {{withPadding: string, withoutPadding: string, dateString: string}} withPadding="07/10" / withoutPadding="7/10" / dateString="2026-07-10"
 */
function getTargetDates(dateOffset = 0) {
  const target = new Date(Date.now() + dateOffset * 24 * 60 * 60 * 1000);
  // sv-SE ロケールは YYYY-MM-DD 形式で出力する
  const dateString = target.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const [, month, day] = dateString.split('-');

  return {
    withPadding: `${month}/${day}`,
    withoutPadding: `${Number(month)}/${Number(day)}`,
    dateString
  };
}

/**
 * 中学生コース: 対象日の日ブロック(dailyRoot)から勉強時間と講座行を抽出する
 *
 * `dayBlockCount` はページ上の日ブロック総数。`found: false` のとき、これが0なら
 * 「タイムライン自体が未描画/セレクタ破損」、1以上なら「対象日の学習がない(正当な0)」を区別する。
 *
 * @private
 * @param {import('playwright').Page} page
 * @param {number} dateOffset - 0=今日、-1=昨日
 * @returns {Promise<{found: boolean, minuteText: string, rows: Array<{name: string, isMission: boolean, score: number}>, dayBlockCount: number}>}
 */
async function extractJuniorHighDay(page, dateOffset = 0) {
  const targetDates = getTargetDates(dateOffset);
  const sel = selectors.juniorHighTimeline;

  const dailyRoots = await page.locator(sel.dailyRoot).all();

  for (const root of dailyRoots) {
    const dateText = await root.locator(sel.dateLabel).first().textContent().catch(() => '');
    if (!dateText.includes(targetDates.withPadding) && !dateText.includes(targetDates.withoutPadding)) continue;

    // 日付の下の時間テキスト（例: "6分" / "1時間30分"）
    const minuteText = await root.locator(sel.studyDateInner).first().textContent().catch(() => '');
    const rows = [];

    for (const subjectGroup of await root.locator(sel.subjectGroup).all()) {
      const subjectName = (await subjectGroup.locator(sel.subjectName).first().textContent().catch(() => '')).trim();

      for (const courseEl of await subjectGroup.locator(sel.course).all()) {
        const courseName = (await courseEl.locator(sel.courseName).first().textContent().catch(() => '')).trim();
        const scoreText = await courseEl.locator(sel.courseResult).first().textContent().catch(() => '');

        // 中学生コースにミッション概念はなく、載っている行は全て学習実績
        rows.push({
          name: subjectName && courseName ? `${subjectName}: ${courseName}` : courseName || subjectName,
          score: parseInt(scoreText.match(/\d+/)?.[0] ?? '0', 10),
          isMission: true
        });
      }
    }

    return { found: true, minuteText, rows, dayBlockCount: dailyRoots.length };
  }

  return { found: false, minuteText: '', rows: [], dayBlockCount: dailyRoots.length };
}

/**
 * 小学生コース: 対象日の日ブロックから学習時間と全行データを1回のevaluateで抽出する
 *
 * 日ブロック([class*="dailyTimeline__"])が構造として分離されているため、
 * boundingBox のY座標計算は不要。
 * スターアプリのアコーディオン行は学習として扱わないため読み飛ばす。
 *
 * `dayBlockCount` はページ上の日ブロック総数。`found: false` のとき、
 * これが0なら「タイムライン自体が未描画/セレクタ破損」、1以上なら
 * 「タイムラインは出ているが対象日の学習がない(正当な0)」を区別するために使う。
 *
 * @private
 * @param {import('playwright').Page} page
 * @param {number} dateOffset - 0=今日、-1=昨日
 * @returns {Promise<{found: boolean, minuteText: string, rows: Array<{name: string, isMission: boolean, score: number, correctAnswers: number|null, questionCount: number|null}>, dayBlockCount: number}>}
 */
async function extractElementaryDay(page, dateOffset = 0) {
  const targetDates = getTargetDates(dateOffset);
  const { elementaryTimeline } = selectors;

  // タイムラインの日ブロックが描画されるまで待つ。待てなくても
  // (SPAの初期表示遅延等) 後続の判定(dayBlockCount)に委ねる。
  await page.waitForSelector(elementaryTimeline.dayBlock, {
    state: 'visible',
    timeout: selectors.waitStrategies.timelineDateTimeout
  }).catch(() => {});

  return page.evaluate(({ padded, unpadded, sel }) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate()内は丸ごとブラウザへシリアライズされるため、外側スコープの関数を参照できない
    const parseIntOrNull = (text) => {
      const digits = (text || '').replace(/\D/g, '');
      return digits ? parseInt(digits, 10) : null;
    };

    const dayBlocks = Array.from(document.querySelectorAll(sel.dayBlock));

    for (const dayBlock of dayBlocks) {
      const dateEl = dayBlock.querySelector(sel.dateLabel);
      const dateText = (dateEl ? dateEl.textContent : '').trim();

      if (!dateText.includes(padded) && !dateText.includes(unpadded)) continue;

      const minuteEl = dayBlock.querySelector(sel.totalStudyTime);
      const minuteText = (minuteEl ? minuteEl.textContent : '').trim();

      const list = dayBlock.querySelector(sel.courseList);
      const rows = [];

      if (list) {
        for (const row of Array.from(list.children)) {
          // スターアプリ(アコーディオン行)は学習として扱わない
          if (row.querySelector(sel.accordion)) continue;

          const titleEl = row.querySelector(sel.courseTitle);
          const scoreEl = row.querySelector(sel.scoreNumber);
          const correctEl = row.querySelector(sel.correctAnswerCount);
          const questionEl = row.querySelector(sel.questionCount);

          rows.push({
            name: (titleEl ? titleEl.textContent : '').trim(),
            isMission: !!row.querySelector(sel.missionBadge),
            score: parseIntOrNull(scoreEl ? scoreEl.textContent : '') ?? 0,
            correctAnswers: parseIntOrNull(correctEl ? correctEl.textContent : ''),
            questionCount: parseIntOrNull(questionEl ? questionEl.textContent : '')
          });
        }
      }

      return { found: true, minuteText, rows, dayBlockCount: dayBlocks.length };
    }

    return { found: false, minuteText: '', rows: [], dayBlockCount: dayBlocks.length };
  }, {
    padded: targetDates.withPadding,
    unpadded: targetDates.withoutPadding,
    sel: elementaryTimeline
  }).then(result => result ?? { found: false, minuteText: '', rows: [], dayBlockCount: 0 });
}

/**
 * 勉強時間テキストをパースする（"X時間Y分" "Y分" "X時間" 形式に対応）
 * @private
 * @param {string} text - パース対象のテキスト
 * @returns {{hours: number, minutes: number}|null} パース結果（時間表記がなければnull）
 */
function parseStudyTime(text) {
  if (!/\d+(時間|分)/.test(text)) {
    return null;
  }
  const hours = Number(text.match(/(\d+)時間/)?.[1] ?? 0);
  const minutes = Number(text.match(/(\d+)分/)?.[1] ?? 0);
  // 分が60以上の場合は時間に繰り上げる
  return { hours: hours + Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * タイムラインから抽出した行データを集計する(純粋関数)
 *
 * 行データはDOM抽出の結果で、ミッション/自主学習の区別と学習結果を持つ。
 * これをユーザーデータの missions 配列と各カウントに変換する。
 *
 * @param {Array<{name?: string, isMission?: boolean, score?: number, correctAnswers?: number|null, questionCount?: number|null}>} rows
 * @returns {{studyItemCount: number, missionCount: number, missions: Array, totalScore: number}}
 */
function summarizeStudyRows(rows) {
  const source = Array.isArray(rows) ? rows : [];

  const missions = source.map(row => ({
    name: (row.name || '').trim() || 'ミッション',
    score: row.score ?? 0,
    // タイムラインに載っている = 実施済みのため常に完了扱い
    completed: true,
    isMission: row.isMission === true,
    correctAnswers: row.correctAnswers ?? null,
    questionCount: row.questionCount ?? null
  }));

  return {
    studyItemCount: missions.length,
    missionCount: missions.filter(mission => mission.isMission).length,
    missions,
    totalScore: missions.reduce((total, mission) => total + (mission.score || 0), 0)
  };
}

/**
 * 表示中のコースのデータを取得する
 *
 * タイムラインから対象日を1回抽出し、勉強時間・学習件数・講座詳細をまとめて組み立てる。
 * 日ブロックが1件も無い(未描画/セレクタ破損)か抽出が例外になった場合は、実際の未学習と
 * 区別できるよう dataReliable: false を付ける(ストリーク判定の誤リセット防止に使う)。
 *
 * @param {import('playwright').Page} page
 * @param {string} userName - ユーザー名
 * @param {string|null} courseName - コース選択画面で選んだコース名(選択画面がなければ null)
 * @param {string} dateString - 対象日 (YYYY-MM-DD)
 * @param {number} [dateOffset=0] - 0=今日、-1=昨日
 * @returns {Promise<{success: boolean, data?: object, detailsAvailable: boolean, error?: string}>}
 */
async function getCourseData(page, userName, courseName, dateString, dateOffset = 0) {
  try {
    const isJuniorHigh = isJuniorHighSchool(courseName, page);
    const targetDates = getTargetDates(dateOffset);

    let day = null;
    try {
      day = isJuniorHigh
        ? await extractJuniorHighDay(page, dateOffset)
        : await extractElementaryDay(page, dateOffset);
    } catch (error) {
      console.warn(`      ⚠️ タイムラインの抽出に失敗: ${error.message}`);
    }

    if (day && !day.found) {
      console.log(day.dayBlockCount === 0
        ? '      ⚠️ タイムラインの日ブロックが1件も見つかりません（未描画の可能性）'
        : `      ℹ️ 対象日(${targetDates.withPadding})のデータはまだありません（日ブロック${day.dayBlockCount}件中に該当なし、0件として扱います）`);
    }

    const dataReliable = day !== null && day.dayBlockCount > 0;
    const summary = summarizeStudyRows(day?.rows);
    // 勉強時間はタイムライン左カラムの値。スターアプリの時間は含まれない(サイト側の仕様)
    const studyTime = parseStudyTime(day?.minuteText ?? '') ?? { hours: 0, minutes: 0 };

    return {
      success: true,
      data: {
        // ユーザー名にコース名を追加（コース選択がある場合）
        userName: courseName ? `${userName} (${courseName})` : userName,
        // ストリーク確定・警告のしきい値をコース別に切り替えるために使う
        course: isJuniorHigh ? 'juniorHigh' : 'elementary',
        studyItemCount: summary.studyItemCount,
        missionCount: summary.missionCount,
        date: dateString,
        studyTime,
        totalScore: summary.totalScore,
        missions: summary.missions,
        dataReliable
      },
      detailsAvailable: dataReliable
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
 *
 * @param {import('playwright').Page} page - Playwrightページインスタンス
 * @param {object} [options]
 * @param {number} [options.dateOffset=0] - 0=今日、-1=昨日
 * @returns {Promise<{success: boolean, data?: Array<object>, error?: string, partialFailure?: boolean, detailsAvailable?: boolean}>}
 */
async function getAllUsersDetailedData(page, options = {}) {
  const { dateOffset = 0 } = options;

  try {
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

    const dateString = getTargetDates(dateOffset).dateString;

    const collect = async (userName, courseName) => {
      const courseData = await getCourseData(page, userName, courseName, dateString, dateOffset);
      if (courseData.success) {
        data.push(courseData.data);
        detailsAvailable = detailsAvailable && courseData.detailsAvailable;
        const { studyTime, missionCount, totalScore } = courseData.data;
        console.log(`    ✅ ${courseName ?? maskName(userName)}: 勉強時間=${studyTime.hours}h${studyTime.minutes}m, ミッション=${missionCount}件, 点数=${totalScore}点`);
      } else {
        hasPartialFailure = true;
        console.error(`    ❌ データ取得失敗: ${courseData.error}`);
      }
    };

    for (let i = 0; i < users.length; i++) {
      const user = users[i];

      console.log(`\n👤 ${maskName(user.name)}のデータを取得中...`);

      const switchResult = await switchToUser(page, user.name);

      if (!switchResult.success) {
        hasPartialFailure = true;
        console.error(`  ❌ ユーザー切り替え失敗: ${switchResult.error}`);
        continue;
      }

      const courseSelection = await checkCourseSelection(page);

      if (courseSelection.hasCourseSelection) {
        console.log(`  📚 コース選択画面が表示されています`);
        console.log(`    中学生コース: ${courseSelection.hasJuniorHighSchool ? 'あり' : 'なし'}`);
        console.log(`    小学生コース: ${courseSelection.hasElementarySchool ? 'あり' : 'なし'}`);

        // 両コース持ちは中学生コースのみ取得する
        const courses = courseSelection.hasJuniorHighSchool ? ['中学生コース'] : ['小学生コース'];

        for (const [index, courseName] of courses.entries()) {
          console.log(`\n  📖 ${courseName}のデータを取得中...`);

          const selectResult = await selectCourse(page, courseName);
          if (!selectResult.success) {
            console.error(`    ❌ コース選択失敗: ${selectResult.error}`);
            hasPartialFailure = true;
            continue;
          }

          await collect(user.name, courseName);

          // 次のコースのために、コース選択画面に戻る
          if (index < courses.length - 1) {
            const returnResult = await returnToCourseSelection(page, user.name);
            if (!returnResult.success) {
              console.error(`    ❌ コース選択画面への復帰失敗: ${returnResult.error}`);
              hasPartialFailure = true;
              break;
            }
          }
        }
      } else {
        console.log(`  📖 データを取得中（コース選択なし）...`);
        await collect(user.name, null);
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
    // データ0件でも失敗がなければ「対象ユーザーなし」として成功扱い
    if (data.length > 0 || !hasPartialFailure) {
      return {
        success: true,
        data,
        partialFailure: hasPartialFailure,
        detailsAvailable
      };
    }

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
 * エラー時のスクリーンショット保存
 *
 * @param {import('playwright').Page} page
 * @param {string} errorType - ファイル名の接頭辞
 */
async function saveErrorScreenshot(page, errorType) {
  try {
    const screenshotsDir = path.join(__dirname, '../screenshots');
    await fs.mkdir(screenshotsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${errorType}-${timestamp}.png`;

    await page.screenshot({ path: path.join(screenshotsDir, filename), fullPage: true });
    console.log(`📸 スクリーンショットを保存しました: ${filename}`);
  } catch (error) {
    console.error('⚠️ スクリーンショットの保存に失敗しました:', error.message);
  }
}

module.exports = {
  getUserList,
  getAllUsersDetailedData,
  getCourseData,
  summarizeStudyRows,
  getTargetDates,
  isJuniorHighSchool,
  saveErrorScreenshot
};
