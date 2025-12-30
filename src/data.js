/**
 * データ管理モジュール - ミッションデータの保存・取得・比較
 * Requirements: 3.6, 3.9, 4.6, 4.7, 1.4, 2.2, 3.2, 5.1, 5.2
 *
 * データ構造v2.0:
 * {
 *   version: "2.0",
 *   timestamp: "ISO 8601",
 *   users: [
 *     {
 *       userName: "string",
 *       missionCount: number,
 *       date: "YYYY-MM-DD",
 *       studyTime: { hours: number, minutes: number },
 *       totalScore: number,
 *       missions: [
 *         { name: "string", score: number, completed: boolean }
 *       ]
 *     }
 *   ]
 * }
 */

const fs = require('fs').promises;
const path = require('path');

// データファイルのパス
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'mission_data.json');

/**
 * v1.0データをv2.0形式に移行
 * Requirements: 3.6
 *
 * @param {Array} v1Data - v1.0形式のユーザーデータ
 * @returns {Array} v2.0形式のユーザーデータ
 */
function migrateDataV1toV2(v1Data) {
  return v1Data.map(user => ({
    ...user,  // userName, missionCount, date を保持
    studyTime: { hours: 0, minutes: 0 },
    totalScore: 0,
    missions: []
  }));
}

/**
 * 前回実行時のデータを読み込む
 *
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
async function loadPreviousData() {
  try {
    // ファイルが存在するか確認
    try {
      await fs.access(DATA_FILE);
    } catch (error) {
      // ファイルが存在しない場合（初回実行時）は空配列を返す
      return {
        success: true,
        data: []
      };
    }

    // ファイルを読み込む
    const fileContent = await fs.readFile(DATA_FILE, 'utf-8');

    // JSONをパース
    const jsonData = JSON.parse(fileContent);

    // バージョン判定と移行
    const version = jsonData.version || '1.0';
    let users = jsonData.users || [];

    if (version === '1.0') {
      // v1.0 → v2.0 自動マイグレーション
      users = migrateDataV1toV2(users);
    } else if (version !== '2.0') {
      return {
        success: false,
        error: `未知のデータバージョン: ${version}`
      };
    }

    return {
      success: true,
      data: users
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      // JSONパースエラー
      return {
        success: false,
        error: `JSONパースエラー: ${error.message}`
      };
    }

    // その他のエラー（ファイル読み込みエラーなど）
    return {
      success: false,
      error: `データ読み込みエラー: ${error.message}`
    };
  }
}

/**
 * 新旧データを比較して変更を検出
 *
 * @param {Array} previousData - 前回のユーザーデータ
 * @param {Array} currentData - 現在のユーザーデータ
 * @returns {{success: boolean, changes: Array}}
 */
function compareData(previousData, currentData) {
  const changes = [];

  // 前回データをユーザー名でマッピング
  const previousMap = new Map();
  previousData.forEach(user => {
    previousMap.set(user.userName, user.missionCount);
  });

  // 現在データを走査して変更を検出
  currentData.forEach(current => {
    const userName = current.userName;
    const currentCount = current.missionCount;
    const previousCount = previousMap.get(userName);

    if (previousCount === undefined) {
      // 新規ユーザー
      changes.push({
        userName,
        previousCount: 0,
        currentCount,
        diff: currentCount,
        type: 'new'
      });
    } else if (currentCount > previousCount) {
      // ミッション数が増加
      changes.push({
        userName,
        previousCount,
        currentCount,
        diff: currentCount - previousCount,
        type: 'increase'
      });
    } else if (currentCount < previousCount) {
      // ミッション数が減少
      changes.push({
        userName,
        previousCount,
        currentCount,
        diff: currentCount - previousCount,
        type: 'decrease'
      });
    }
    // currentCount === previousCount の場合は変更なしなので何もしない
  });

  return {
    success: true,
    changes
  };
}

/**
 * 新しいデータをJSON形式で保存
 *
 * @param {Array} data - 保存するユーザーデータ
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveData(data) {
  try {
    // データ形式の検証
    if (!Array.isArray(data)) {
      return {
        success: false,
        error: '不正なデータ形式: 配列である必要があります'
      };
    }

    // データディレクトリを作成（存在しない場合）
    await fs.mkdir(DATA_DIR, { recursive: true });

    // 保存用のJSONオブジェクトを構築
    const saveObject = {
      version: '2.0',
      timestamp: new Date().toISOString(),
      users: data
    };

    // JSON文字列に変換
    const jsonString = JSON.stringify(saveObject, null, 2);

    // ファイルに書き込み
    await fs.writeFile(DATA_FILE, jsonString, 'utf-8');

    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error: `データ保存エラー: ${error.message}`
    };
  }
}

module.exports = {
  loadPreviousData,
  compareData,
  saveData
};
