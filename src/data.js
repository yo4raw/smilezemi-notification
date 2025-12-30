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

/**
 * ミッション詳細レベルの変更を検出
 * Requirements: 点数変化、新規ミッション、変化なしの検出
 *
 * @param {Array} previousData - 前回のユーザーデータ（v2.0形式）
 * @param {Array} currentData - 現在のユーザーデータ（v2.0形式）
 * @returns {{
 *   success: boolean,
 *   userChanges: Array<{
 *     userName: string,
 *     missionChanges: Array<{
 *       missionName: string,
 *       type: 'score_change' | 'new_mission' | 'no_change',
 *       previousScore?: number,
 *       currentScore: number,
 *       scoreChange?: number,
 *       completed: boolean
 *     }>
 *   }>
 * }}
 */
function compareMissionDetails(previousData, currentData) {
  try {
    // データ形式の検証
    if (!Array.isArray(previousData) || !Array.isArray(currentData)) {
      return {
        success: false,
        error: 'データ形式エラー: 両方とも配列である必要があります',
        userChanges: []
      };
    }

    // 前回データをユーザー名でマッピング
    const previousMap = new Map();
    previousData.forEach(user => {
      if (user.userName && Array.isArray(user.missions)) {
        previousMap.set(user.userName, user.missions);
      }
    });

    const userChanges = [];

    // 現在データを走査
    currentData.forEach(currentUser => {
      if (!currentUser.userName || !Array.isArray(currentUser.missions)) {
        return;
      }

      const previousMissions = previousMap.get(currentUser.userName);

      // 前回データがない場合、全て新規ミッションとして扱う
      if (!previousMissions) {
        const missionChanges = currentUser.missions.map(mission => ({
          missionName: mission.name,
          type: 'new_mission',
          currentScore: mission.score,
          completed: mission.completed
        }));

        if (missionChanges.length > 0) {
          userChanges.push({
            userName: currentUser.userName,
            missionChanges
          });
        }
        return;
      }

      // 前回のミッションを名前でマッピング
      const previousMissionMap = new Map();
      previousMissions.forEach(mission => {
        // 同名ミッションが複数ある場合、最初のものを使用
        if (!previousMissionMap.has(mission.name)) {
          previousMissionMap.set(mission.name, mission);
        }
      });

      const missionChanges = [];

      // 現在のミッションを走査
      currentUser.missions.forEach(currentMission => {
        const previousMission = previousMissionMap.get(currentMission.name);

        if (!previousMission) {
          // 新規ミッション
          missionChanges.push({
            missionName: currentMission.name,
            type: 'new_mission',
            currentScore: currentMission.score,
            completed: currentMission.completed
          });
        } else if (currentMission.score !== previousMission.score) {
          // 点数変化
          missionChanges.push({
            missionName: currentMission.name,
            type: 'score_change',
            previousScore: previousMission.score,
            currentScore: currentMission.score,
            scoreChange: currentMission.score - previousMission.score,
            completed: currentMission.completed
          });
        } else {
          // 変化なし
          missionChanges.push({
            missionName: currentMission.name,
            type: 'no_change',
            currentScore: currentMission.score,
            completed: currentMission.completed
          });
        }
      });

      if (missionChanges.length > 0) {
        userChanges.push({
          userName: currentUser.userName,
          missionChanges
        });
      }
    });

    return {
      success: true,
      userChanges
    };
  } catch (error) {
    return {
      success: false,
      error: `ミッション詳細比較エラー: ${error.message}`,
      userChanges: []
    };
  }
}

module.exports = {
  loadPreviousData,
  compareData,
  compareMissionDetails,
  saveData
};
