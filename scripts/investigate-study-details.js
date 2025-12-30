#!/usr/bin/env node
/**
 * DOM構造調査スクリプト - 勉強時間、ミッション名、点数の表示要素を特定
 * Requirements: 1.1, 1.2, 2.1, 2.2, 3.1
 *
 * 実行方法:
 *   node scripts/investigate-study-details.js
 *
 * 調査対象:
 *   - 勉強時間の表示要素（セレクタ、テキストパターン、位置）
 *   - ミッション名の表示要素（.missionIcon__i6nW8の周辺）
 *   - 点数の表示要素（同上）
 *
 * 出力:
 *   - コンソール出力: 調査結果（セレクタ、位置、テキスト内容）
 *   - スクリーンショット: screenshots/study-details-investigation-{timestamp}.png
 */

const { chromium } = require('playwright');
const { login } = require('../src/auth');
const path = require('path');
const fs = require('fs').promises;

// 環境変数から認証情報を取得
require('dotenv').config();

const CREDENTIALS = {
  username: process.env.SMILEZEMI_USERNAME,
  password: process.env.SMILEZEMI_PASSWORD
};

/**
 * 調査メイン処理
 */
async function investigateStudyDetails() {
  let browser;
  let context;
  let page;

  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 DOM構造調査スクリプト開始');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // ブラウザ起動
    console.log('🚀 ブラウザを起動中...');
    browser = await chromium.launch({
      headless: false, // 調査時は画面を見ながら実行
      slowMo: 500      // 操作を遅くして確認しやすくする
    });

    // ログイン
    console.log('🔐 みまもるネットにログイン中...');
    const loginResult = await login(browser, CREDENTIALS);

    if (!loginResult.success) {
      throw new Error(`ログイン失敗: ${loginResult.error}`);
    }

    page = loginResult.page;
    context = loginResult.context;
    console.log('✅ ログイン成功\n');

    // ページのDOM読み込みを待機（networkidleは使わない - タイムアウトの原因）
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);  // JavaScript初期化のための待機時間を延長

    // ユーザー一覧を取得
    console.log('👥 ユーザー一覧を取得中...');
    const { getUserList } = require('../src/crawler');
    const userListResult = await getUserList(page);

    if (!userListResult.success || userListResult.users.length === 0) {
      console.log('⚠️ ユーザー一覧の取得に失敗しましたが、現在のユーザーで調査を続行します');
    } else {
      const firstUser = userListResult.users[0].name;
      console.log(`\n📌 調査対象ユーザー: ${firstUser}`);
    }

    // ページが安定するまで待機（domcontentloadedで十分）
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 DOM構造調査開始');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // === 調査1: 勉強時間の表示要素 ===
    await investigateStudyTime(page);

    // === 調査2: ミッション関連要素 ===
    await investigateMissionElements(page);

    // === スクリーンショット保存 ===
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = `screenshots/study-details-investigation-${timestamp}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`\n📸 スクリーンショット保存: ${screenshotPath}`);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ DOM構造調査完了');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('\n❌ エラーが発生しました:');
    console.error(error.message);
    console.error(error.stack);

    // エラー時もスクリーンショット保存
    if (page) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await page.screenshot({ path: `screenshots/error-${timestamp}.png` });
        console.log(`\n📸 エラー時スクリーンショット保存: screenshots/error-${timestamp}.png`);
      } catch (screenshotError) {
        console.error('スクリーンショット保存失敗:', screenshotError.message);
      }
    }

  } finally {
    // クリーンアップ
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * 勉強時間の表示要素を調査
 */
async function investigateStudyTime(page) {
  console.log('═══════════════════════════════════════════');
  console.log('📊 調査1: 勉強時間の表示要素');
  console.log('═══════════════════════════════════════════\n');

  try {
    // パターン1: "時間"と"分"を含むテキストを探す
    console.log('🔍 パターン1: "時間"と"分"を含むテキストを探索...');
    const timePattern = /(\d+)時間(\d+)分/;
    const allTextElements = await page.locator('*').allTextContents();

    const timeMatches = [];
    for (let i = 0; i < allTextElements.length; i++) {
      const text = allTextElements[i];
      if (timePattern.test(text)) {
        timeMatches.push(text.trim());
      }
    }

    if (timeMatches.length > 0) {
      console.log(`  ✅ 見つかった時間表記: ${timeMatches.length}件`);
      timeMatches.slice(0, 5).forEach((match, idx) => {
        console.log(`  [${idx + 1}] ${match}`);
      });
    } else {
      console.log('  ⚠️ "時間"+"分"パターンは見つかりませんでした');
    }

    // パターン2: 特定のクラスやID内での検索
    console.log('\n🔍 パターン2: よく使われるクラス名で検索...');
    const commonPatterns = [
      '.study-time',
      '.studytime',
      '.time',
      '[class*="time"]',
      '[class*="study"]',
      '[class*="hour"]',
      '[class*="minute"]'
    ];

    for (const pattern of commonPatterns) {
      const elements = await page.locator(pattern).count();
      if (elements > 0) {
        console.log(`  ✅ ${pattern}: ${elements}件見つかりました`);
        const firstElement = page.locator(pattern).first();
        const text = await firstElement.textContent().catch(() => '');
        const box = await firstElement.boundingBox().catch(() => null);

        if (text) {
          console.log(`     テキスト: ${text.substring(0, 100)}`);
        }
        if (box) {
          console.log(`     位置: x=${Math.round(box.x)}, y=${Math.round(box.y)}`);
        }
      }
    }

    // パターン3: ページ全体の構造を探索
    console.log('\n🔍 パターン3: 全要素をスキャンして"時間"を含む要素を特定...');
    const allElements = await page.locator('div, span, p').all();
    const candidateElements = [];

    for (const element of allElements.slice(0, 500)) { // 最初の500要素のみ
      const text = await element.textContent().catch(() => '');
      if (text && (text.includes('時間') || text.includes('分')) && text.length < 50) {
        const classes = await element.getAttribute('class').catch(() => '');
        const box = await element.boundingBox().catch(() => null);
        const isVisible = await element.isVisible().catch(() => false);

        if (isVisible && box) {
          candidateElements.push({
            text: text.trim(),
            classes: classes,
            x: Math.round(box.x),
            y: Math.round(box.y)
          });
        }
      }
    }

    if (candidateElements.length > 0) {
      console.log(`  ✅ 候補要素: ${candidateElements.length}件`);
      candidateElements.slice(0, 10).forEach((elem, idx) => {
        console.log(`  [${idx + 1}] テキスト: "${elem.text}"`);
        console.log(`       クラス: ${elem.classes || '(なし)'}`);
        console.log(`       位置: x=${elem.x}, y=${elem.y}`);
      });
    } else {
      console.log('  ⚠️ 候補要素が見つかりませんでした');
    }

  } catch (error) {
    console.error(`  ❌ 調査エラー: ${error.message}`);
  }
}

/**
 * ミッション関連要素を調査（名前と点数）
 */
async function investigateMissionElements(page) {
  console.log('\n═══════════════════════════════════════════');
  console.log('📋 調査2: ミッション名と点数の表示要素');
  console.log('═══════════════════════════════════════════\n');

  try {
    // 既存の.missionIcon__i6nW8を基準に調査
    console.log('🔍 基準要素: .missionIcon__i6nW8 を探索...');
    const missionIcons = await page.locator('.missionIcon__i6nW8').all();

    if (missionIcons.length === 0) {
      console.log('  ⚠️ .missionIcon__i6nW8 が見つかりませんでした');
      return;
    }

    console.log(`  ✅ 見つかったミッションアイコン: ${missionIcons.length}件`);

    // 最初の数件を詳細に調査
    const investigationLimit = Math.min(5, missionIcons.length);
    console.log(`\n📌 最初の${investigationLimit}件を詳細調査...\n`);

    for (let i = 0; i < investigationLimit; i++) {
      const icon = missionIcons[i];
      console.log(`━━━ ミッション ${i + 1} ━━━`);

      // アイコン自体の情報
      const iconText = await icon.textContent().catch(() => '');
      const iconBox = await icon.boundingBox().catch(() => null);
      console.log(`  📍 アイコンテキスト: "${iconText}"`);
      if (iconBox) {
        console.log(`     位置: x=${Math.round(iconBox.x)}, y=${Math.round(iconBox.y)}`);
      }

      // 親要素を調査
      const parent = icon.locator('..');
      const parentClasses = await parent.getAttribute('class').catch(() => '');
      const parentText = await parent.textContent().catch(() => '');
      console.log(`\n  🔼 親要素:`);
      console.log(`     クラス: ${parentClasses}`);
      console.log(`     テキスト: "${parentText.substring(0, 100)}"`);

      // 兄弟要素を調査
      console.log(`\n  ↔️ 兄弟要素:`);
      const siblings = await parent.locator('..').locator('> *').all();
      for (let j = 0; j < Math.min(5, siblings.length); j++) {
        const siblingClasses = await siblings[j].getAttribute('class').catch(() => '');
        const siblingText = await siblings[j].textContent().catch(() => '');
        if (siblingText.trim().length > 0 && siblingText.trim().length < 100) {
          console.log(`     [${j + 1}] クラス: ${siblingClasses}`);
          console.log(`         テキスト: "${siblingText.trim()}"`);
        }
      }

      // 周辺の点数らしき要素を探す（数字＋"点"）
      console.log(`\n  🎯 周辺の点数らしき要素:`);
      const nearbyElements = await parent.locator('..').locator('text=/\\d+点/').all();
      for (const elem of nearbyElements.slice(0, 3)) {
        const scoreText = await elem.textContent().catch(() => '');
        const scoreClasses = await elem.getAttribute('class').catch(() => '');
        const scoreBox = await elem.boundingBox().catch(() => null);
        console.log(`     テキスト: "${scoreText.trim()}"`);
        console.log(`     クラス: ${scoreClasses}`);
        if (scoreBox) {
          console.log(`     位置: x=${Math.round(scoreBox.x)}, y=${Math.round(scoreBox.y)}`);
        }
      }

      console.log('');
    }

    // 一般的な点数パターンを検索
    console.log('\n🔍 一般的な点数表記パターンを検索...');
    const scoreElements = await page.locator('text=/\\d+点/').all();
    console.log(`  ✅ 見つかった点数表記: ${scoreElements.length}件`);

    if (scoreElements.length > 0) {
      console.log(`  最初の10件:`);
      for (let i = 0; i < Math.min(10, scoreElements.length); i++) {
        const text = await scoreElements[i].textContent().catch(() => '');
        const classes = await scoreElements[i].getAttribute('class').catch(() => '');
        console.log(`  [${i + 1}] テキスト: "${text.trim()}", クラス: ${classes}`);
      }
    }

  } catch (error) {
    console.error(`  ❌ 調査エラー: ${error.message}`);
  }
}

// メイン実行
investigateStudyDetails()
  .then(() => {
    console.log('🎉 調査スクリプト正常終了');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 調査スクリプト異常終了:', error);
    process.exit(1);
  });
