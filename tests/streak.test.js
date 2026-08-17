/**
 * ストリーク管理モジュールのテスト
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');

const {
  createInitialState,
  isStudied,
  countCompletedMissions,
  countStudyItems,
  confirmDay,
  updateStreaks,
  formatStreakInfo,
  settleBonuses,
  loadStreakData,
  saveStreakData,
  STREAK_REQUIREMENTS,
  getRequirementForCourse,
  updateStreaksByCourse
} = require('../src/streak');

const DATA_DIR = path.join(__dirname, '../data');
const STREAK_FILE = path.join(DATA_DIR, 'streak_data.json');

describe('STREAK_REQUIREMENTS', () => {
  it('コースごとの必要完了数が正の整数として集約定義されている', () => {
    assert.ok(Number.isInteger(STREAK_REQUIREMENTS.elementaryMissions) && STREAK_REQUIREMENTS.elementaryMissions > 0);
    assert.ok(Number.isInteger(STREAK_REQUIREMENTS.juniorHighCourses) && STREAK_REQUIREMENTS.juniorHighCourses > 0);
  });
});

describe('createInitialState', () => {
  it('初期おたすけは1(初回特典)、ボーナスは0', () => {
    assert.deepStrictEqual(createInitialState(), { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null });
  });
});

describe('isStudied', () => {
  it('勉強時間もミッションもない場合は未学習', () => {
    assert.strictEqual(isStudied({ studyTime: { hours: 0, minutes: 0 }, missions: [] }), false);
  });

  it('勉強時間があれば学習済み', () => {
    assert.strictEqual(isStudied({ studyTime: { hours: 0, minutes: 5 }, missions: [] }), true);
  });

  it('ミッションがあれば学習済み', () => {
    assert.strictEqual(
      isStudied({ studyTime: { hours: 0, minutes: 0 }, missions: [{ name: '算数', score: 80, completed: true }] }),
      true
    );
  });

  it('studyTime / missions が欠けていても未学習として扱える', () => {
    assert.strictEqual(isStudied({}), false);
  });

  describe('minCompletedMissions オプション(小学生コースの5個ルール)', () => {
    it('完了ミッションが閾値以上なら学習済み', () => {
      const user = { studyTime: { hours: 0, minutes: 0 }, missionCount: 5, missions: [] };
      assert.strictEqual(isStudied(user, { minCompletedMissions: 5 }), true);
    });

    it('完了ミッションが閾値未満なら未学習(境界: 4個)', () => {
      const user = { studyTime: { hours: 0, minutes: 0 }, missionCount: 4, missions: [] };
      assert.strictEqual(isStudied(user, { minCompletedMissions: 5 }), false);
    });

    it('勉強時間があっても完了ミッションが閾値未満なら未学習', () => {
      const user = { studyTime: { hours: 2, minutes: 30 }, missionCount: 3, missions: [] };
      assert.strictEqual(isStudied(user, { minCompletedMissions: 5 }), false);
    });

    it('オプション未指定(または0)は現行判定のまま', () => {
      const user = { studyTime: { hours: 0, minutes: 5 }, missionCount: 0, missions: [] };
      assert.strictEqual(isStudied(user), true);
      assert.strictEqual(isStudied(user, { minCompletedMissions: 0 }), true);
    });

    it('missionCountがない場合はmissionsのcompleted件数で判定する', () => {
      const missions = [
        { name: 'a', score: 80, completed: true },
        { name: 'b', score: 0, completed: false },
        { name: 'c', score: 90, completed: true },
        { name: 'd', score: 70, completed: true },
        { name: 'e', score: 60, completed: true },
        { name: 'f', score: 50, completed: true }
      ];
      const user = { studyTime: { hours: 0, minutes: 0 }, missions };
      assert.strictEqual(isStudied(user, { minCompletedMissions: 5 }), true, '完了5件(未完了1件は数えない)');
      assert.strictEqual(isStudied(user, { minCompletedMissions: 6 }), false);
    });
  });
});

describe('countCompletedMissions', () => {
  it('missionCount(数値)を優先して返す', () => {
    assert.strictEqual(countCompletedMissions({ missionCount: 3, missions: [] }), 3);
  });

  it('missionCountがない場合はmissionsのcompleted件数を返す', () => {
    const missions = [
      { name: 'a', completed: true },
      { name: 'b', completed: false },
      { name: 'c', completed: true }
    ];
    assert.strictEqual(countCompletedMissions({ missions }), 2);
  });

  it('どちらもない場合は0を返す', () => {
    assert.strictEqual(countCompletedMissions({}), 0);
  });
});

describe('confirmDay', () => {
  it('学習した日はストリークが+1される(初期おたすけ1は維持)', () => {
    const { state, event } = confirmDay(createInitialState(), '2026-07-12', true);
    assert.deepStrictEqual(state, { streak: 1, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'none');
  });

  it('おたすけ満タン(3)の学習日は毎日ボーナス+1(bonusイベント、節目以外の日)', () => {
    const { state, event } = confirmDay(
      { streak: 4, grace: 3, bonus: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 5);
    assert.strictEqual(state.grace, 3, 'おたすけは満タンのまま');
    assert.strictEqual(state.bonus, 1, 'ボーナスが+1されること');
    assert.strictEqual(event, 'bonus');
  });

  it('おたすけ満タン中は10日節目でもボーナス+1のみ(重ね掛けなし・マイルストーン判定なし)', () => {
    const { state, event } = confirmDay(
      { streak: 9, grace: 3, bonus: 2, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 10);
    assert.strictEqual(state.grace, 3, 'おたすけは満タンのまま');
    assert.strictEqual(state.bonus, 3, '節目でも+1のみであること');
    assert.strictEqual(event, 'bonus');
  });

  it('bonusフィールドがない旧データでもボーナス獲得できる(0扱い)', () => {
    const { state, event } = confirmDay(
      { streak: 19, grace: 3, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.bonus, 1);
    assert.strictEqual(event, 'bonus');
  });

  it('ボーナスはおたすけ消費でも保持される', () => {
    const { state } = confirmDay(
      { streak: 12, grace: 1, bonus: 2, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.strictEqual(state.bonus, 2);
    assert.strictEqual(state.grace, 0);
  });

  it('ボーナスはリセットでも保持される(支給予定のため)', () => {
    const { state, event } = confirmDay(
      { streak: 12, grace: 0, bonus: 2, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.strictEqual(event, 'reset');
    assert.strictEqual(state.streak, 0);
    assert.strictEqual(state.bonus, 2, 'リセットでもボーナスは消えないこと');
  });

  it('おたすけ3未満の節目以外の学習日はボーナス不変・報酬なし', () => {
    const { state, event } = confirmDay(
      { streak: 11, grace: 2, bonus: 1, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 12);
    assert.strictEqual(state.grace, 2);
    assert.strictEqual(state.bonus, 1);
    assert.strictEqual(event, 'none');
  });

  it('10日到達でおたすけ+1(milestone)', () => {
    const { state, event } = confirmDay(
      { streak: 9, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 10);
    assert.strictEqual(state.grace, 1);
    assert.strictEqual(event, 'milestone');
  });

  it('20日到達でもおたすけ+1(ボーナスは不変)', () => {
    const { state, event } = confirmDay(
      { streak: 19, grace: 1, bonus: 1, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.grace, 2);
    assert.strictEqual(state.bonus, 1, 'おたすけ3未満のマイルストーンではボーナスは増えないこと');
    assert.strictEqual(event, 'milestone');
  });

  it('おたすけは上限3を超えない(超過分はボーナスになる)', () => {
    const { state, event } = confirmDay(
      { streak: 39, grace: 3, lastConfirmedDate: '2026-07-11' }, '2026-07-12', true
    );
    assert.strictEqual(state.streak, 40);
    assert.strictEqual(state.grace, 3);
    assert.strictEqual(event, 'bonus');
  });

  it('未学習でもおたすけがあれば消費してストリーク維持(+1されない)', () => {
    const { state, event } = confirmDay(
      { streak: 12, grace: 2, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.deepStrictEqual(state, { streak: 12, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'grace_used');
  });

  it('未学習でおたすけがなければストリークもおたすけも0にリセット', () => {
    const { state, event } = confirmDay(
      { streak: 12, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.deepStrictEqual(state, { streak: 0, grace: 0, bonus: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'reset');
  });

  it('ストリーク0のときはおたすけを消費しない(守る記録がないため)', () => {
    const { state, event } = confirmDay(
      { streak: 0, grace: 1, lastConfirmedDate: null },
      '2026-07-12',
      false
    );
    assert.deepStrictEqual(state, { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' });
    assert.strictEqual(event, 'none');
  });

  it('ストリーク0で未学習の場合はresetイベントを出さない', () => {
    const { state, event } = confirmDay(
      { streak: 0, grace: 0, lastConfirmedDate: '2026-07-11' }, '2026-07-12', false
    );
    assert.strictEqual(state.streak, 0);
    assert.strictEqual(event, 'none');
  });

  it('判定済みの日付は再判定しない(冪等)', () => {
    const before = { streak: 5, grace: 1, lastConfirmedDate: '2026-07-12' };
    const { state, event } = confirmDay(before, '2026-07-12', true);
    assert.deepStrictEqual(state, before);
    assert.strictEqual(event, 'none');
  });

  it('過去の日付も再判定しない', () => {
    const before = { streak: 5, grace: 1, lastConfirmedDate: '2026-07-12' };
    const { state, event } = confirmDay(before, '2026-07-10', true);
    assert.deepStrictEqual(state, before);
    assert.strictEqual(event, 'none');
  });

  it('空白日(前回確定日から日が飛んでいる)は中立扱いで、対象日のみ判定される', () => {
    // 07-08 まで確定 → 07-09〜07-11 はCI障害等で未判定 → 07-12 を判定
    const { state } = confirmDay(
      { streak: 5, grace: 1, lastConfirmedDate: '2026-07-08' }, '2026-07-12', true
    );
    assert.deepStrictEqual(state, { streak: 6, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' });
  });
});

describe('loadStreakData / saveStreakData', () => {
  beforeEach(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.unlink(STREAK_FILE);
    } catch (e) {
      // ファイルなしは無視
    }
  });

  afterEach(async () => {
    try {
      await fs.unlink(STREAK_FILE);
    } catch (e) {
      // ファイルなしは無視
    }
  });

  it('ファイルが存在しない場合は空のマップを返す(初回実行)', async () => {
    const result = await loadStreakData();
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, {});
  });

  it('保存したデータを読み込める(ラウンドトリップ)', async () => {
    const users = {
      'たろう (中学生コース)': { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' }
    };
    const saveResult = await saveStreakData(users);
    assert.strictEqual(saveResult.success, true);

    const loadResult = await loadStreakData();
    assert.strictEqual(loadResult.success, true);
    assert.deepStrictEqual(loadResult.data, users);
  });

  it('保存ファイルに version(1.3) と ISO 8601 timestamp が含まれる', async () => {
    await saveStreakData({});
    const content = JSON.parse(await fs.readFile(STREAK_FILE, 'utf-8'));
    assert.strictEqual(content.version, '1.3');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(content.timestamp));
  });

  it('1.0データの読み込み時に全ユーザーのおたすけを3にする(一度きりの満タンチャージ)', async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STREAK_FILE, JSON.stringify({
      version: '1.0',
      users: {
        'じろう (小学生コース)': { streak: 3, grace: 0, lastConfirmedDate: '2026-07-12' },
        'たろう (中学生コース)': { streak: 15, grace: 2, lastConfirmedDate: '2026-07-12' }
      }
    }), 'utf-8');

    const result = await loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['じろう (小学生コース)'].grace, 3, 'おたすけ0は3になること');
    assert.strictEqual(result.data['じろう (小学生コース)'].streak, 3, 'ストリークは変わらないこと');
    assert.strictEqual(result.data['たろう (中学生コース)'].grace, 3, 'おたすけ2も3になること');
  });

  it('1.1データの読み込み時も全ユーザーのおたすけを3にする', async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STREAK_FILE, JSON.stringify({
      version: '1.1',
      users: {
        'じろう (小学生コース)': { streak: 3, grace: 1, lastConfirmedDate: '2026-07-12' }
      }
    }), 'utf-8');

    const result = await loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['じろう (小学生コース)'].grace, 3, '1.1データも満タンチャージ対象なこと');
  });

  it('1.2データの読み込み時も全ユーザーのおたすけを3にする(v1.3再チャージ)', async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STREAK_FILE, JSON.stringify({
      version: '1.2',
      users: {
        'じろう (小学生コース)': { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' }
      }
    }), 'utf-8');

    const result = await loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['じろう (小学生コース)'].grace, 3, '1.2データも満タンチャージ対象なこと');
  });

  it('1.3データの読み込みではおたすけ0でも変化しない(消費済みは再付与しない)', async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STREAK_FILE, JSON.stringify({
      version: '1.3',
      users: {
        'じろう (小学生コース)': { streak: 3, grace: 0, bonus: 0, lastConfirmedDate: '2026-07-12' }
      }
    }), 'utf-8');

    const result = await loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['じろう (小学生コース)'].grace, 0, '1.3データは移行対象外なこと');
  });

  it('不正なJSONの場合はエラーを返す', async () => {
    await fs.writeFile(STREAK_FILE, '{invalid json', 'utf-8');
    const result = await loadStreakData();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('JSONパースエラー'));
  });

  it('未知のバージョンはエラーを返す', async () => {
    await fs.writeFile(STREAK_FILE, JSON.stringify({ version: '9.9', users: {} }), 'utf-8');
    const result = await loadStreakData();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('未知のストリークデータバージョン'));
  });

  it('配列を渡すと保存エラーになる', async () => {
    const result = await saveStreakData([]);
    assert.strictEqual(result.success, false);
  });
});

describe('updateStreaks', () => {
  const studiedUser = {
    userName: 'たろう (中学生コース)',
    studyTime: { hours: 0, minutes: 45 },
    missions: [{ name: '数学', score: 80, completed: true }]
  };
  const notStudiedUser = {
    userName: 'じろう (小学生コース)',
    studyTime: { hours: 0, minutes: 0 },
    missions: []
  };

  it('複数ユーザーをそれぞれ独立に判定する', () => {
    const { streakUsers, results } = updateStreaks({}, [studiedUser, notStudiedUser], '2026-07-12');
    assert.strictEqual(streakUsers['たろう (中学生コース)'].streak, 1);
    assert.strictEqual(streakUsers['じろう (小学生コース)'].streak, 0);
    assert.strictEqual(results.length, 2);
  });

  it('既存の状態から更新される', () => {
    const initial = {
      'たろう (中学生コース)': { streak: 9, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    const { streakUsers, results } = updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.strictEqual(streakUsers['たろう (中学生コース)'].streak, 10);
    assert.strictEqual(results[0].event, 'milestone');
  });

  it('入力のマップを変更しない(純粋関数)', () => {
    const initial = {
      'たろう (中学生コース)': { streak: 5, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.strictEqual(initial['たろう (中学生コース)'].streak, 5);
  });

  it('クロール対象にいないユーザーの状態は変更されない', () => {
    const initial = {
      '別の子 (小学生コース)': { streak: 3, grace: 0, lastConfirmedDate: '2026-07-11' }
    };
    const { streakUsers } = updateStreaks(initial, [studiedUser], '2026-07-12');
    assert.deepStrictEqual(
      streakUsers['別の子 (小学生コース)'],
      { streak: 3, grace: 0, lastConfirmedDate: '2026-07-11' }
    );
  });

  it('dataReliable:false かつ未学習の場合は確定をスキップし状態を維持する(誤リセット防止)', () => {
    const initial = {
      'たろう (中学生コース)': { streak: 5, grace: 1, lastConfirmedDate: '2026-07-11' }
    };
    const unreliableNotStudiedUser = {
      userName: 'たろう (中学生コース)',
      studyTime: { hours: 0, minutes: 0 },
      missions: [],
      dataReliable: false
    };
    const { streakUsers, results } = updateStreaks(initial, [unreliableNotStudiedUser], '2026-07-12');

    assert.deepStrictEqual(streakUsers['たろう (中学生コース)'], initial['たろう (中学生コース)']);
    assert.strictEqual(results[0].event, 'none');
    assert.deepStrictEqual(results[0].state, initial['たろう (中学生コース)']);
  });

  it('dataReliable:false でも学習実績があれば通常通り確定する(正の証跡は信頼する)', () => {
    const unreliableStudiedUser = {
      userName: 'たろう (中学生コース)',
      studyTime: { hours: 0, minutes: 30 },
      missions: [{ name: '数学', score: 80, completed: true }],
      dataReliable: false
    };
    const { streakUsers, results } = updateStreaks({}, [unreliableStudiedUser], '2026-07-12');

    assert.strictEqual(streakUsers['たろう (中学生コース)'].streak, 1);
    assert.strictEqual(streakUsers['たろう (中学生コース)'].lastConfirmedDate, '2026-07-12');
    assert.strictEqual(results[0].event, 'none');
  });

  it('dataReliable が未指定の場合は信頼できるものとして通常通り確定する(既存呼び出し互換)', () => {
    const { streakUsers } = updateStreaks({}, [notStudiedUser], '2026-07-12');

    assert.deepStrictEqual(
      streakUsers['じろう (小学生コース)'],
      { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' },
      '新規ユーザーはおたすけ1のまま(streak 0では消費しない)日付だけ確定されること'
    );
  });

  it('新規ユーザーが初日に学習するとstreak 1・おたすけ1になる', () => {
    const { streakUsers } = updateStreaks({}, [studiedUser], '2026-07-12');

    assert.deepStrictEqual(
      streakUsers['たろう (中学生コース)'],
      { streak: 1, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' }
    );
  });

  it('minCompletedMissions オプションが判定に伝搬する(完了4個は未学習扱いでおたすけ消費)', () => {
    const initial = {
      'じろう (小学生コース)': { streak: 7, grace: 1, lastConfirmedDate: '2026-07-11' }
    };
    const fourMissionsUser = {
      userName: 'じろう (小学生コース)',
      studyTime: { hours: 1, minutes: 0 },
      missionCount: 4,
      missions: []
    };
    const { streakUsers, results } = updateStreaks(
      initial,
      [fourMissionsUser],
      '2026-07-12',
      { minCompletedMissions: 5 }
    );

    assert.strictEqual(streakUsers['じろう (小学生コース)'].streak, 7, '+1されないこと');
    assert.strictEqual(streakUsers['じろう (小学生コース)'].grace, 0, 'おたすけが消費されること');
    assert.strictEqual(results[0].event, 'grace_used');
  });

  it('minCompletedMissions オプションで完了5個の日は+1される', () => {
    const fiveMissionsUser = {
      userName: 'じろう (小学生コース)',
      studyTime: { hours: 0, minutes: 0 },
      missionCount: 5,
      missions: []
    };
    const { streakUsers } = updateStreaks({}, [fiveMissionsUser], '2026-07-12', { minCompletedMissions: 5 });

    assert.strictEqual(streakUsers['じろう (小学生コース)'].streak, 1);
  });
});

describe('settleBonuses', () => {
  const users = {
    'じろう (小学生コース)': { streak: 12, grace: 3, bonus: 2, lastConfirmedDate: '2026-07-31' },
    'はなこ (小学生コース)': { streak: 5, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-31' },
    'たろう (中学生コース)': { streak: 20, grace: 3, lastConfirmedDate: '2026-07-31' }
  };

  it('全ユーザーのボーナスを0にした新しいマップと清算リストを返す', () => {
    const { streakUsers, settlements } = settleBonuses(users);

    assert.strictEqual(streakUsers['じろう (小学生コース)'].bonus, 0);
    assert.strictEqual(streakUsers['じろう (小学生コース)'].streak, 12, 'ストリークは変わらないこと');
    assert.strictEqual(streakUsers['じろう (小学生コース)'].grace, 3, 'おたすけは変わらないこと');

    assert.deepStrictEqual(
      settlements.map(s => [s.userName, s.bonus]).sort(),
      [
        ['たろう (中学生コース)', 0],
        ['はなこ (小学生コース)', 0],
        ['じろう (小学生コース)', 2]
      ].sort(),
      'bonus欠損は0として清算リストに含まれること'
    );
  });

  it('入力のマップを変更しない(純粋関数)', () => {
    settleBonuses(users);
    assert.strictEqual(users['じろう (小学生コース)'].bonus, 2);
  });
});

describe('updateStreaks - コース種別の保存', () => {
  const studiedElementaryUser = {
    userName: 'はなこ',
    course: 'elementary',
    studyTime: { hours: 1, minutes: 0 },
    missionCount: 4,
    missions: []
  };

  it('確定したユーザーの状態に course を保存する', () => {
    const { streakUsers } = updateStreaks({}, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(streakUsers['はなこ'].course, 'elementary');
    assert.strictEqual(streakUsers['はなこ'].streak, 1, 'ストリークの確定は従来どおり行われること');
  });

  it('中学生コースの course も保存する', () => {
    const juniorHighUser = {
      userName: 'たろう',
      course: 'juniorHigh',
      studyTime: { hours: 1, minutes: 0 },
      missionCount: 3,
      missions: []
    };
    const { streakUsers } = updateStreaks({}, [juniorHighUser], '2026-07-12', { minCompletedMissions: 3 });

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh');
  });

  it('results に載る状態にも course が含まれる', () => {
    const { results } = updateStreaks({}, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(results[0].state.course, 'elementary');
  });

  it('dataReliable:false で確定をスキップする場合も course は保存する', () => {
    const initial = {
      'たろう': { streak: 5, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-11' }
    };
    const unreliableNotStudiedUser = {
      userName: 'たろう',
      course: 'juniorHigh',
      studyTime: { hours: 0, minutes: 0 },
      missions: [],
      dataReliable: false
    };
    const { streakUsers, results } = updateStreaks(initial, [unreliableNotStudiedUser], '2026-07-12');

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh', 'コースは学習判定と無関係に分かるため保存すること');
    assert.strictEqual(streakUsers['たろう'].streak, 5, 'ストリークは変わらないこと');
    assert.strictEqual(streakUsers['たろう'].grace, 1, 'おたすけは変わらないこと');
    assert.strictEqual(streakUsers['たろう'].bonus, 0, 'ボーナスは変わらないこと');
    assert.strictEqual(streakUsers['たろう'].lastConfirmedDate, '2026-07-11', '確定日は進めないこと');
    assert.strictEqual(results[0].event, 'none');
  });

  it('user.course が未指定なら既存の course を保持する', () => {
    const initial = {
      'たろう': { streak: 5, grace: 1, bonus: 0, course: 'juniorHigh', lastConfirmedDate: '2026-07-11' }
    };
    const noCourseUser = {
      userName: 'たろう',
      studyTime: { hours: 1, minutes: 0 },
      missionCount: 4,
      missions: []
    };
    const { streakUsers } = updateStreaks(initial, [noCourseUser], '2026-07-12');

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh', '未指定で既存値を消さないこと');
    assert.strictEqual(streakUsers['たろう'].streak, 6, '確定は従来どおり行われること');
  });

  it('入力のマップを変更しない(純粋関数)', () => {
    const initial = {
      'はなこ': { streak: 3, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-11' }
    };
    updateStreaks(initial, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(initial['はなこ'].course, undefined, '入力側に course が生えないこと');
    assert.strictEqual(initial['はなこ'].streak, 3);
  });

  it('同日再実行でも course は保存される(冪等な確定スキップ経路)', () => {
    const initial = {
      'はなこ': { streak: 3, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12' }
    };
    const { streakUsers } = updateStreaks(initial, [studiedElementaryUser], '2026-07-12');

    assert.strictEqual(streakUsers['はなこ'].course, 'elementary');
    assert.strictEqual(streakUsers['はなこ'].streak, 3, '同日再実行でストリークは進まないこと');
  });
});

describe('settleBonuses - コース種別の引き継ぎ', () => {
  it('settlements に course を載せる', () => {
    const users = {
      'たろう': { streak: 20, grace: 3, bonus: 3, course: 'juniorHigh', lastConfirmedDate: '2026-07-31' },
      'はなこ': { streak: 5, grace: 1, bonus: 2, course: 'elementary', lastConfirmedDate: '2026-07-31' }
    };
    const { settlements } = settleBonuses(users);

    assert.deepStrictEqual(
      settlements.map(s => [s.userName, s.bonus, s.course]).sort(),
      [
        ['たろう', 3, 'juniorHigh'],
        ['はなこ', 2, 'elementary']
      ].sort()
    );
  });

  it('course のないユーザーは course: undefined で返す', () => {
    const users = {
      'じろう': { streak: 1, grace: 1, bonus: 1, lastConfirmedDate: '2026-07-31' }
    };
    const { settlements } = settleBonuses(users);

    assert.strictEqual(settlements[0].course, undefined);
  });

  it('リセット後の状態でも course は残る', () => {
    const users = {
      'たろう': { streak: 20, grace: 3, bonus: 3, course: 'juniorHigh', lastConfirmedDate: '2026-07-31' }
    };
    const { streakUsers } = settleBonuses(users);

    assert.strictEqual(streakUsers['たろう'].course, 'juniorHigh');
    assert.strictEqual(streakUsers['たろう'].bonus, 0);
  });
});

describe('formatStreakInfo', () => {
  it('ボーナス1以上のときストリーク行に表示される', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 3, bonus: 2, lastConfirmedDate: '2026-07-12' },
      event: 'none'
    });
    assert.match(text, /💰 ボーナス: 2P/);
  });

  it('ボーナス0のときは表示されない', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 3, bonus: 0, lastConfirmedDate: '2026-07-12' },
      event: 'none'
    });
    assert.doesNotMatch(text, /ボーナス/);
  });

  it('bonusイベントで毎日ボーナス行が追加される(🎉の連続達成文面は出さない)', () => {
    const text = formatStreakInfo({
      state: { streak: 20, grace: 3, bonus: 2, lastConfirmedDate: '2026-07-12' },
      event: 'bonus'
    });
    assert.match(text, /💰 おたすけ満タンのためボーナス\+1\(合計2P\)/);
    assert.doesNotMatch(text, /🎉/);
  });

  it('基本表示(ストリークとおたすけ)', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'none'
    });
    assert.strictEqual(text, '🔥 連続学習: 12日目  🛟 おたすけ: 1/3');
  });

  it('todayStudied で暫定+1表示(夜通知用)', () => {
    const text = formatStreakInfo(
      { state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' }, event: 'none' },
      { todayStudied: true }
    );
    assert.ok(text.includes('13日目'));
  });

  it('ストリーク0のときは「0日」表示', () => {
    const text = formatStreakInfo({
      state: { streak: 0, grace: 0, lastConfirmedDate: null },
      event: 'none'
    });
    assert.ok(text.includes('🔥 連続学習: 0日'));
  });

  it('milestoneイベントでお祝い行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 10, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'milestone'
    });
    assert.ok(text.includes('🎉 10日連続達成!おたすけ+1(残り1)'));
  });

  it('grace_usedイベントでおたすけ使用行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 1, lastConfirmedDate: '2026-07-12' },
      event: 'grace_used'
    });
    assert.ok(text.includes('💤 昨日はおたすけを使って連続記録を守りました(残り1)'));
  });

  it('resetイベントでリセット行が追加される', () => {
    const text = formatStreakInfo({
      state: { streak: 0, grace: 0, lastConfirmedDate: '2026-07-12' },
      event: 'reset'
    });
    assert.ok(text.includes('😢 連続記録がリセットされました'));
  });
});

describe('getRequirementForCourse', () => {
  it('elementary は elementaryMissions を返す', () => {
    assert.strictEqual(
      getRequirementForCourse('elementary'),
      STREAK_REQUIREMENTS.elementaryMissions
    );
  });

  it('juniorHigh は juniorHighCourses を返す', () => {
    assert.strictEqual(
      getRequirementForCourse('juniorHigh'),
      STREAK_REQUIREMENTS.juniorHighCourses
    );
  });

  it('未知/未設定コースは elementary 扱い', () => {
    assert.strictEqual(
      getRequirementForCourse(undefined),
      STREAK_REQUIREMENTS.elementaryMissions
    );
  });
});

describe('updateStreaksByCourse', () => {
  it('コースごとに異なるしきい値で確定する', () => {
    // 小学生: 4ミッションで学習成立 / 中学生: 3講座で学習成立
    const elemUser = { userName: '太郎 (小学生コース)', course: 'elementary', missionCount: 4, missions: [] };
    const jhUser = { userName: '花子 (中学生コース)', course: 'juniorHigh', missionCount: 3, missions: [] };

    const { streakUsers, results } = updateStreaksByCourse(
      {}, [elemUser, jhUser], '2026-07-13'
    );

    assert.strictEqual(streakUsers['太郎 (小学生コース)'].streak, 1, '小学生は4ミッションで+1');
    assert.strictEqual(streakUsers['花子 (中学生コース)'].streak, 1, '中学生は3講座で+1');
    assert.strictEqual(results.length, 2, '両コース分のresultが返る');
  });

  it('土曜でも中学生は3講座で学習成立(曜日別しきい値を持たない)', () => {
    // 2026-07-11 は土曜。曜日別しきい値時代は5講座必要だった日付
    const jhUser = { userName: '花子', course: 'juniorHigh', missionCount: 3, missions: [] };
    const { streakUsers } = updateStreaksByCourse({}, [jhUser], '2026-07-11');
    assert.strictEqual(streakUsers['花子'].streak, 1, '土曜でも3講座で+1される');
  });

  it('中学生のしきい値未満(2講座)は学習不成立', () => {
    const jhUser = { userName: '花子 (中学生コース)', course: 'juniorHigh', missionCount: 2, missions: [] };
    const { streakUsers } = updateStreaksByCourse({}, [jhUser], '2026-07-13');
    assert.strictEqual(streakUsers['花子 (中学生コース)'].streak, 0, '2講座では+1されない');
  });

  it('入力の streakUsers を破壊しない', () => {
    const input = {};
    const elemUser = { userName: '太郎 (小学生コース)', course: 'elementary', missionCount: 4, missions: [] };
    updateStreaksByCourse(input, [elemUser], '2026-07-13');
    assert.deepStrictEqual(input, {}, '入力マップは変更されない');
  });
});

// ─── countStudyItems テスト ───

describe('countStudyItems() - 学習件数の算出', () => {
  it('studyItemCount があればそれを返す', () => {
    const user = { studyItemCount: 5, missionCount: 4 };

    assert.strictEqual(countStudyItems(user), 5);
  });

  it('studyItemCount がなければ missionCount にフォールバックする', () => {
    const user = { missionCount: 4 };

    assert.strictEqual(countStudyItems(user), 4);
  });

  it('どちらもなければ missions の completed 件数を使う', () => {
    const user = { missions: [{ completed: true }, { completed: true }, { completed: false }] };

    assert.strictEqual(countStudyItems(user), 2);
  });

  it('studyItemCount が 0 でも missionCount にフォールバックしない', () => {
    const user = { studyItemCount: 0, missionCount: 4 };

    assert.strictEqual(countStudyItems(user), 0);
  });
});

// ─── 自主学習を含めた達成判定テスト ───

describe('isStudied() - 自主学習を含めた判定', () => {
  it('ミッション2件+自主2件の計4件でしきい値4を満たす', () => {
    const user = { studyItemCount: 4, missionCount: 2 };

    assert.strictEqual(isStudied(user, { minCompletedMissions: 4 }), true);
  });

  it('ミッション3件のみ(自主0件)ではしきい値4を満たさない', () => {
    const user = { studyItemCount: 3, missionCount: 3 };

    assert.strictEqual(isStudied(user, { minCompletedMissions: 4 }), false);
  });

  it('studyItemCount のない旧データは missionCount で判定する', () => {
    const user = { missionCount: 4 };

    assert.strictEqual(isStudied(user, { minCompletedMissions: 4 }), true);
  });
});
