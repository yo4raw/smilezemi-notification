#!/usr/bin/env node
/**
 * データ移行テストスクリプト
 * v1.0 → v2.0 のデータ移行が正しく動作するかテスト
 *
 * Task 6.2: データ移行ロジックのテスト
 */

const fs = require('fs').promises;
const path = require('path');

// テスト用のv1.0データ
const v1TestData = {
  version: '1.0',
  timestamp: '2025-12-29T10:00:00.000Z',
  users: [
    {
      userName: '太郎',
      missionCount: 3,
      date: '2025-12-29'
    },
    {
      userName: '花子',
      missionCount: 5,
      date: '2025-12-29'
    }
  ]
};

// 期待されるv2.0データ
const expectedV2Data = [
  {
    userName: '太郎',
    missionCount: 3,
    date: '2025-12-29',
    studyTime: { hours: 0, minutes: 0 },
    totalScore: 0,
    missions: []
  },
  {
    userName: '花子',
    missionCount: 5,
    date: '2025-12-29',
    studyTime: { hours: 0, minutes: 0 },
    totalScore: 0,
    missions: []
  }
];

async function runMigrationTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 データ移行テスト開始');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let allTestsPassed = true;

  try {
    // テスト1: v1.0データをファイルに保存
    console.log('🔧 テスト1: v1.0データをファイルに保存...');
    const dataDir = path.join(__dirname, '../data');
    await fs.mkdir(dataDir, { recursive: true });

    const testFilePath = path.join(dataDir, 'mission_data_test.json');
    await fs.writeFile(testFilePath, JSON.stringify(v1TestData, null, 2), 'utf-8');
    console.log('✅ v1.0データ保存成功\n');

    // テスト2: loadPreviousData()でv1.0データを読み込み、自動移行を確認
    console.log('🔧 テスト2: v1.0データの読み込みと自動移行...');
    const { loadPreviousData } = require('../src/data');

    // 一時的にファイルパスを変更してテスト
    const originalDataFile = path.join(dataDir, 'mission_data.json');
    const backupExists = await fs.access(originalDataFile).then(() => true).catch(() => false);

    if (backupExists) {
      await fs.rename(originalDataFile, originalDataFile + '.backup');
    }

    await fs.rename(testFilePath, originalDataFile);

    const loadResult = await loadPreviousData();

    // ファイルを元に戻す
    await fs.rename(originalDataFile, testFilePath);
    if (backupExists) {
      await fs.rename(originalDataFile + '.backup', originalDataFile);
    }

    if (!loadResult.success) {
      console.error('❌ テスト2失敗: データ読み込みエラー:', loadResult.error);
      allTestsPassed = false;
    } else {
      console.log('✅ データ読み込み成功');

      // v2.0形式に変換されているか確認
      const migratedData = loadResult.data;
      console.log('\n📊 移行後のデータ:');
      console.log(JSON.stringify(migratedData, null, 2));

      // 検証
      if (migratedData.length !== expectedV2Data.length) {
        console.error(`❌ テスト2失敗: ユーザー数が一致しません（期待: ${expectedV2Data.length}, 実際: ${migratedData.length}）`);
        allTestsPassed = false;
      } else {
        console.log(`✅ ユーザー数一致: ${migratedData.length}名`);

        // 各ユーザーの検証
        for (let i = 0; i < migratedData.length; i++) {
          const actual = migratedData[i];
          const expected = expectedV2Data[i];

          console.log(`\n🔍 ユーザー${i + 1}: ${actual.userName}`);

          // userName 検証
          if (actual.userName !== expected.userName) {
            console.error(`  ❌ userName不一致（期待: ${expected.userName}, 実際: ${actual.userName}）`);
            allTestsPassed = false;
          } else {
            console.log(`  ✅ userName: ${actual.userName}`);
          }

          // missionCount 検証
          if (actual.missionCount !== expected.missionCount) {
            console.error(`  ❌ missionCount不一致（期待: ${expected.missionCount}, 実際: ${actual.missionCount}）`);
            allTestsPassed = false;
          } else {
            console.log(`  ✅ missionCount: ${actual.missionCount}`);
          }

          // date 検証
          if (actual.date !== expected.date) {
            console.error(`  ❌ date不一致（期待: ${expected.date}, 実際: ${actual.date}）`);
            allTestsPassed = false;
          } else {
            console.log(`  ✅ date: ${actual.date}`);
          }

          // studyTime 検証
          if (!actual.studyTime ||
              actual.studyTime.hours !== expected.studyTime.hours ||
              actual.studyTime.minutes !== expected.studyTime.minutes) {
            console.error(`  ❌ studyTime不一致（期待: ${JSON.stringify(expected.studyTime)}, 実際: ${JSON.stringify(actual.studyTime)}）`);
            allTestsPassed = false;
          } else {
            console.log(`  ✅ studyTime: ${actual.studyTime.hours}時間${actual.studyTime.minutes}分`);
          }

          // totalScore 検証
          if (actual.totalScore !== expected.totalScore) {
            console.error(`  ❌ totalScore不一致（期待: ${expected.totalScore}, 実際: ${actual.totalScore}）`);
            allTestsPassed = false;
          } else {
            console.log(`  ✅ totalScore: ${actual.totalScore}点`);
          }

          // missions 検証
          if (!Array.isArray(actual.missions) || actual.missions.length !== expected.missions.length) {
            console.error(`  ❌ missions不一致（期待: ${expected.missions.length}件, 実際: ${actual.missions?.length || 'undefined'}）`);
            allTestsPassed = false;
          } else {
            console.log(`  ✅ missions: ${actual.missions.length}件`);
          }
        }
      }
    }

    // テスト3: v2.0形式でデータを保存
    console.log('\n🔧 テスト3: v2.0形式でデータ保存...');
    const { saveData } = require('../src/data');

    const v2TestData = [
      {
        userName: '次郎',
        missionCount: 4,
        date: '2025-12-30',
        studyTime: { hours: 1, minutes: 30 },
        totalScore: 250,
        missions: [
          { name: 'テストミッション1', score: 100, completed: true },
          { name: 'テストミッション2', score: 150, completed: true }
        ]
      }
    ];

    // テストファイルに保存
    const saveBackupExists = await fs.access(originalDataFile).then(() => true).catch(() => false);
    if (saveBackupExists) {
      await fs.rename(originalDataFile, originalDataFile + '.backup2');
    }

    const saveResult = await saveData(v2TestData);

    if (!saveResult.success) {
      console.error('❌ テスト3失敗: データ保存エラー:', saveResult.error);
      allTestsPassed = false;
    } else {
      console.log('✅ データ保存成功');

      // 保存されたファイルを読み込んで検証
      const savedContent = await fs.readFile(originalDataFile, 'utf-8');
      const savedData = JSON.parse(savedContent);

      console.log('\n📊 保存されたデータ:');
      console.log(JSON.stringify(savedData, null, 2));

      // version確認
      if (savedData.version !== '2.0') {
        console.error(`❌ テスト3失敗: versionが2.0ではありません（実際: ${savedData.version}）`);
        allTestsPassed = false;
      } else {
        console.log('✅ version: 2.0');
      }

      // timestamp確認
      if (!savedData.timestamp) {
        console.error('❌ テスト3失敗: timestampが存在しません');
        allTestsPassed = false;
      } else {
        console.log(`✅ timestamp: ${savedData.timestamp}`);
      }

      // users確認
      if (!Array.isArray(savedData.users) || savedData.users.length !== 1) {
        console.error(`❌ テスト3失敗: users配列が不正です（長さ: ${savedData.users?.length}）`);
        allTestsPassed = false;
      } else {
        console.log('✅ users配列: 1名');

        const user = savedData.users[0];
        if (user.userName !== '次郎' ||
            user.missionCount !== 4 ||
            user.studyTime.hours !== 1 ||
            user.studyTime.minutes !== 30 ||
            user.totalScore !== 250 ||
            user.missions.length !== 2) {
          console.error('❌ テスト3失敗: ユーザーデータが期待値と一致しません');
          allTestsPassed = false;
        } else {
          console.log('✅ ユーザーデータ検証成功');
        }
      }
    }

    // ファイルを元に戻す
    await fs.unlink(originalDataFile);
    if (saveBackupExists) {
      await fs.rename(originalDataFile + '.backup2', originalDataFile);
    }

    // テストファイルをクリーンアップ
    await fs.unlink(testFilePath).catch(() => {});

  } catch (error) {
    console.error('❌ テスト実行エラー:', error.message);
    console.error(error.stack);
    allTestsPassed = false;
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (allTestsPassed) {
    console.log('✅ 全てのテストが成功しました！');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(0);
  } else {
    console.log('❌ 一部のテストが失敗しました');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  }
}

// 実行
runMigrationTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
