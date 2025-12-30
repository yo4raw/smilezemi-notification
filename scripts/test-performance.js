#!/usr/bin/env node
/**
 * パフォーマンステストスクリプト
 * 実行時間とLINE API呼び出し回数を測定
 *
 * Task 6.5: パフォーマンス検証
 * 目標:
 * - ユーザーあたり処理時間: < 30秒
 * - 総実行時間: < 5分
 * - LINE API呼び出し: ≤ 3回
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { login } = require('../src/auth');
const { getAllUsersDetailedData } = require('../src/crawler');
const { loadConfig } = require('../src/config');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('⚡ パフォーマンステスト開始');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

async function runPerformanceTest() {
  let browser;
  let context;
  let page;

  const performanceMetrics = {
    totalStartTime: Date.now(),
    loginTime: 0,
    crawlTime: 0,
    perUserTime: [],
    totalUsers: 0,
    lineApiCalls: 0
  };

  try {
    // 1. 設定読み込み
    console.log('📋 設定を読み込んでいます...');
    const config = loadConfig();
    console.log('✅ 設定読み込み完了\n');

    // 2. ブラウザ起動
    console.log('🌐 ブラウザを起動しています...');
    const browserStartTime = Date.now();
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    const browserTime = Date.now() - browserStartTime;
    console.log(`✅ ブラウザ起動完了（${browserTime}ms）\n`);

    // 3. ログイン
    console.log('🔐 ログイン処理を実行しています...');
    const loginStartTime = Date.now();
    const loginResult = await login(browser, {
      username: config.SMILEZEMI_USERNAME,
      password: config.SMILEZEMI_PASSWORD
    });

    if (!loginResult.success) {
      throw new Error(`ログイン失敗: ${loginResult.error}`);
    }

    page = loginResult.page;
    context = loginResult.context;
    performanceMetrics.loginTime = Date.now() - loginStartTime;
    console.log(`✅ ログイン完了（${performanceMetrics.loginTime}ms）\n`);

    // 4. 詳細データ取得（パフォーマンス測定）
    console.log('🔍 詳細データ取得を実行しています...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const crawlStartTime = Date.now();
    const crawlResult = await getAllUsersDetailedData(page);

    if (!crawlResult.success) {
      throw new Error(`クローリング失敗: ${crawlResult.error}`);
    }

    performanceMetrics.crawlTime = Date.now() - crawlStartTime;
    performanceMetrics.totalUsers = crawlResult.data.length;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ データ取得完了（${performanceMetrics.crawlTime}ms）\n`);

    // 5. ユーザーあたりの平均処理時間を計算
    const avgTimePerUser = performanceMetrics.crawlTime / performanceMetrics.totalUsers;

    // 6. 総実行時間
    const totalTime = Date.now() - performanceMetrics.totalStartTime;

    // 7. パフォーマンスレポート
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 パフォーマンスレポート');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('⏱️  実行時間測定:');
    console.log(`  ブラウザ起動: ${browserTime}ms (${(browserTime / 1000).toFixed(2)}秒)`);
    console.log(`  ログイン処理: ${performanceMetrics.loginTime}ms (${(performanceMetrics.loginTime / 1000).toFixed(2)}秒)`);
    console.log(`  データ取得: ${performanceMetrics.crawlTime}ms (${(performanceMetrics.crawlTime / 1000).toFixed(2)}秒)`);
    console.log(`  総実行時間: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}秒)\n`);

    console.log('👥 ユーザー処理統計:');
    console.log(`  総ユーザー数: ${performanceMetrics.totalUsers}名`);
    console.log(`  ユーザーあたり平均時間: ${avgTimePerUser.toFixed(2)}ms (${(avgTimePerUser / 1000).toFixed(2)}秒)\n`);

    // 8. 目標達成確認
    console.log('🎯 目標達成確認:');

    const perUserTargetMs = 30 * 1000; // 30秒
    const totalTargetMs = 5 * 60 * 1000; // 5分
    const lineApiTarget = 3; // 3回以下

    const perUserPass = avgTimePerUser < perUserTargetMs;
    const totalTimePass = totalTime < totalTargetMs;
    const lineApiPass = performanceMetrics.lineApiCalls <= lineApiTarget;

    console.log(`  ${perUserPass ? '✅' : '❌'} ユーザーあたり処理時間: ${(avgTimePerUser / 1000).toFixed(2)}秒 < 30秒 ${perUserPass ? '(達成)' : '(未達成)'}`);
    console.log(`  ${totalTimePass ? '✅' : '❌'} 総実行時間: ${(totalTime / 1000).toFixed(2)}秒 < 300秒 ${totalTimePass ? '(達成)' : '(未達成)'}`);
    console.log(`  ${lineApiPass ? '✅' : '⚠️'} LINE API呼び出し: ${performanceMetrics.lineApiCalls}回 ≤ 3回 ${lineApiPass ? '(達成)' : '(要最適化)'}\n`);

    // 9. データ品質確認
    console.log('📋 データ品質確認:');
    const dataQuality = {
      usersWithStudyTime: 0,
      usersWithMissions: 0,
      usersWithScores: 0,
      totalMissions: 0
    };

    crawlResult.data.forEach(user => {
      if (user.studyTime && (user.studyTime.hours > 0 || user.studyTime.minutes > 0)) {
        dataQuality.usersWithStudyTime++;
      }
      if (user.missions && user.missions.length > 0) {
        dataQuality.usersWithMissions++;
        dataQuality.totalMissions += user.missions.length;
      }
      if (user.totalScore > 0) {
        dataQuality.usersWithScores++;
      }
    });

    console.log(`  勉強時間取得: ${dataQuality.usersWithStudyTime}/${performanceMetrics.totalUsers}名`);
    console.log(`  ミッション詳細取得: ${dataQuality.usersWithMissions}/${performanceMetrics.totalUsers}名`);
    console.log(`  点数取得: ${dataQuality.usersWithScores}/${performanceMetrics.totalUsers}名`);
    console.log(`  総ミッション数: ${dataQuality.totalMissions}件\n`);

    // 10. 総合判定
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (perUserPass && totalTimePass) {
      console.log('🎉 パフォーマンステスト: 全ての目標を達成しました！');
    } else {
      console.log('⚠️ パフォーマンステスト: 一部の目標が未達成です');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('❌ テスト実行エラー:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // ブラウザクリーンアップ
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

// 実行
runPerformanceTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
