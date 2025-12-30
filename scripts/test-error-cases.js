#!/usr/bin/env node
/**
 * エラーケーステストスクリプト
 * 様々なエラーシナリオでグレースフルデグラデーションが動作するかテスト
 *
 * Task 6.4: エラーケースのテスト
 */

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 エラーケーステスト開始');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let testsPassed = 0;
let testsFailed = 0;

// ========================================
// テスト1: 勉強時間要素が見つからない場合
// ========================================
console.log('📋 テスト1: 勉強時間要素が見つからない場合');
try {
  const { getStudyTime } = require('../src/crawler');

  // Mock page object with no study time elements
  const mockPage = {
    locator: (selector) => ({
      first: () => ({
        isVisible: async () => false,
        textContent: async () => ''
      }),
      all: async () => []
    })
  };

  getStudyTime(mockPage).then(result => {
    if (result.success && result.hours === 0 && result.minutes === 0) {
      console.log('  ✅ デフォルト値（0時間0分）が返されました');
      testsPassed++;
    } else {
      console.error('  ❌ 期待したデフォルト値が返されませんでした:', result);
      testsFailed++;
    }
  }).catch(error => {
    console.error('  ❌ エラー:', error.message);
    testsFailed++;
  });
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// ========================================
// テスト2: getMissionDetailsでミッション詳細が取得できない場合
// ========================================
console.log('\n📋 テスト2: ミッション詳細が取得できない場合');
try {
  const { getMissionDetails } = require('../src/crawler');

  // Mock page object with no mission elements
  const mockPage = {
    locator: (selector) => ({
      first: () => ({
        isVisible: async () => false,
        boundingBox: async () => null
      }),
      all: async () => []
    })
  };

  getMissionDetails(mockPage).then(result => {
    if (result.success && Array.isArray(result.missions) && result.missions.length === 0) {
      console.log('  ✅ 空の配列が返されました');
      testsPassed++;
    } else {
      console.error('  ❌ 期待した空配列が返されませんでした:', result);
      testsFailed++;
    }
  }).catch(error => {
    console.error('  ❌ エラー:', error.message);
    testsFailed++;
  });
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// ========================================
// テスト3: getTotalScoreで空配列の場合
// ========================================
console.log('\n📋 テスト3: 合計点数計算で空配列の場合');
try {
  const { getTotalScore } = require('../src/crawler');

  const emptyMissions = [];
  const total = getTotalScore(emptyMissions);

  if (total === 0) {
    console.log('  ✅ 0点が返されました');
    testsPassed++;
  } else {
    console.error(`  ❌ 期待値0点ではなく${total}点が返されました`);
    testsFailed++;
  }
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// ========================================
// テスト4: getTotalScoreで正常なデータの場合
// ========================================
console.log('\n📋 テスト4: 合計点数計算で正常データの場合');
try {
  const { getTotalScore } = require('../src/crawler');

  const missions = [
    { name: 'ミッション1', score: 100, completed: true },
    { name: 'ミッション2', score: 85, completed: true },
    { name: 'ミッション3', score: 95, completed: false }
  ];

  const total = getTotalScore(missions);
  const expected = 100 + 85 + 95;

  if (total === expected) {
    console.log(`  ✅ 正しい合計点数（${total}点）が返されました`);
    testsPassed++;
  } else {
    console.error(`  ❌ 期待値${expected}点ではなく${total}点が返されました`);
    testsFailed++;
  }
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// ========================================
// テスト5: formatDetailedMessageで空データの場合
// ========================================
console.log('\n📋 テスト5: 詳細メッセージフォーマットで空データの場合');
try {
  const { formatDetailedMessage } = require('../src/notifier');

  const emptyData = [];
  const message = formatDetailedMessage(emptyData);

  if (message.includes('本日のデータはありません')) {
    console.log('  ✅ 「本日のデータはありません」メッセージが生成されました');
    testsPassed++;
  } else {
    console.error('  ❌ 期待したメッセージが生成されませんでした:', message);
    testsFailed++;
  }
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// ========================================
// テスト6: formatDetailedMessageで正常データの場合
// ========================================
console.log('\n📋 テスト6: 詳細メッセージフォーマットで正常データの場合');
try {
  const { formatDetailedMessage } = require('../src/notifier');

  const userData = [
    {
      userName: 'テスト太郎',
      missionCount: 2,
      date: '2025-12-30',
      studyTime: { hours: 1, minutes: 30 },
      totalScore: 185,
      missions: [
        { name: 'テストミッション1', score: 100, completed: true },
        { name: 'テストミッション2', score: 85, completed: true }
      ]
    }
  ];

  const message = formatDetailedMessage(userData);

  const checks = [
    message.includes('テスト太郎'),
    message.includes('1時間30分'),
    message.includes('2件'),
    message.includes('185点'),
    message.includes('テストミッション1'),
    message.includes('100点')
  ];

  if (checks.every(check => check)) {
    console.log('  ✅ 全ての要素が含まれたメッセージが生成されました');
    testsPassed++;
  } else {
    console.error('  ❌ 一部の要素が欠けています:', message);
    testsFailed++;
  }
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// ========================================
// テスト7: truncateToLimitで5000文字以下の場合
// ========================================
console.log('\n📋 テスト7: メッセージ切り詰めで5000文字以下の場合');
try {
  const { truncateToLimit } = require('../src/notifier');

  const shortMessage = 'これは短いメッセージです。';
  const result = truncateToLimit(shortMessage);

  if (result === shortMessage) {
    console.log('  ✅ メッセージがそのまま返されました');
    testsPassed++;
  } else {
    console.error('  ❌ メッセージが変更されました:', result);
    testsFailed++;
  }
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// ========================================
// テスト8: truncateToLimitで5000文字超過の場合
// ========================================
console.log('\n📋 テスト8: メッセージ切り詰めで5000文字超過の場合');
try {
  const { truncateToLimit } = require('../src/notifier');

  // 5500文字のメッセージを生成
  const longMessage = 'あ'.repeat(5500);
  const result = truncateToLimit(longMessage);

  if (result.length <= 5000 && result.includes('...（メッセージが長すぎるため省略）')) {
    console.log(`  ✅ メッセージが${result.length}文字に切り詰められました`);
    testsPassed++;
  } else {
    console.error(`  ❌ メッセージが適切に切り詰められませんでした（長さ: ${result.length}）`);
    testsFailed++;
  }
} catch (error) {
  console.error('  ❌ テスト実行エラー:', error.message);
  testsFailed++;
}

// テスト結果を待って表示
setTimeout(() => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 テスト結果サマリー');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ 成功: ${testsPassed}件`);
  console.log(`❌ 失敗: ${testsFailed}件`);
  console.log(`📈 成功率: ${Math.round(testsPassed / (testsPassed + testsFailed) * 100)}%`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (testsFailed === 0) {
    console.log('🎉 全てのエラーケーステストが成功しました！\n');
    process.exit(0);
  } else {
    console.log('⚠️ 一部のテストが失敗しました\n');
    process.exit(1);
  }
}, 1000);
