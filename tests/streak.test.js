/**
 * ストリーク管理モジュールのテスト
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  createInitialState,
  isStudied,
  countCompletedMissions,
  countStudyItems,
  confirmDay,
  confirmDayWithHistory,
  updateStreaks,
  formatStreakInfo,
  settleBonuses,
  loadStreakData,
  saveStreakData,
  STREAK_REQUIREMENTS,
  getRequirementForCourse,
  updateStreaksByCourse,
  shiftDate,
  replayStreak,
  pruneHistory,
  collapseHistory,
  GRACE_INITIAL
} = require('../src/streak');

describe('STREAK_REQUIREMENTS', () => {
  it('コースごとの必要完了数が正の整数として集約定義されている', () => {
    assert.ok(Number.isInteger(STREAK_REQUIREMENTS.elementaryMissions) && STREAK_REQUIREMENTS.elementaryMissions > 0);
    assert.ok(Number.isInteger(STREAK_REQUIREMENTS.juniorHighCourses) && STREAK_REQUIREMENTS.juniorHighCourses > 0);
  });
});

describe('createInitialState', () => {
  it('初期おたすけは1(初回特典)、ボーナスは0', () => {
    assert.deepStrictEqual(createInitialState(), {
      streak: 0,
      grace: 1,
      bonus: 0,
      lastConfirmedDate: null,
      exemptDates: [],
      history: {},
      replayBase: { streak: 0, grace: 1, date: null }
    });
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

describe('confirmDay() - 免除日', () => {
  it('免除日に未学習なら streak も grace も据え置きで event は exempt', () => {
    const state = { streak: 12, grace: 2, bonus: 5, lastConfirmedDate: '2026-08-15' };
    const { state: next, event } = confirmDay(state, '2026-08-16', false, { exempt: true });
    assert.strictEqual(event, 'exempt');
    assert.strictEqual(next.streak, 12, 'streak は減らない');
    assert.strictEqual(next.grace, 2, 'おたすけは消費されない');
    assert.strictEqual(next.bonus, 5, 'ボーナスは据え置き');
    assert.strictEqual(next.lastConfirmedDate, '2026-08-16', '日付だけ進む');
  });

  it('免除日でも学習していれば通常どおり +1 する', () => {
    const state = { streak: 12, grace: 2, bonus: 0, lastConfirmedDate: '2026-08-15' };
    const { state: next, event } = confirmDay(state, '2026-08-16', true, { exempt: true });
    assert.strictEqual(next.streak, 13, '学習を優先して加算する');
    assert.strictEqual(event, 'none');
  });

  it('免除日でも学習してマイルストーンに達すればおたすけ+1', () => {
    const state = { streak: 9, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-15' };
    const { state: next, event } = confirmDay(state, '2026-08-16', true, { exempt: true });
    assert.strictEqual(next.streak, 10);
    assert.strictEqual(next.grace, 2);
    assert.strictEqual(event, 'milestone');
  });

  it('streak 0 の免除日も日付だけ進む', () => {
    const state = { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null };
    const { state: next, event } = confirmDay(state, '2026-08-16', false, { exempt: true });
    assert.strictEqual(event, 'exempt');
    assert.strictEqual(next.streak, 0);
    assert.strictEqual(next.grace, 1);
  });

  it('options 省略時は従来どおり動く(未学習でリセット)', () => {
    const state = { streak: 5, grace: 0, bonus: 0, lastConfirmedDate: '2026-08-15' };
    const { event } = confirmDay(state, '2026-08-16', false);
    assert.strictEqual(event, 'reset');
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
      'たろう (中学生コース)': {
        streak: 9, grace: 0, bonus: 0, lastConfirmedDate: '2026-07-11',
        exemptDates: [], history: {}, replayBase: { streak: 9, grace: 0, date: '2026-07-11' }
      }
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
      {
        streak: 0,
        grace: 1,
        bonus: 0,
        lastConfirmedDate: '2026-07-12',
        exemptDates: [],
        history: { '2026-07-12': false },
        replayBase: { streak: 0, grace: 1, date: null }
      },
      '新規ユーザーはおたすけ1のまま(streak 0では消費しない)日付だけ確定されること'
    );
  });

  it('新規ユーザーが初日に学習するとstreak 1・おたすけ1になる', () => {
    const { streakUsers } = updateStreaks({}, [studiedUser], '2026-07-12');

    assert.deepStrictEqual(
      streakUsers['たろう (中学生コース)'],
      {
        streak: 1,
        grace: 1,
        bonus: 0,
        lastConfirmedDate: '2026-07-12',
        exemptDates: [],
        history: { '2026-07-12': true },
        replayBase: { streak: 0, grace: 1, date: null }
      }
    );
  });

  it('minCompletedMissions オプションが判定に伝搬する(完了4個は未学習扱いでおたすけ消費)', () => {
    const initial = {
      'じろう (小学生コース)': {
        streak: 7, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-11',
        exemptDates: [], history: {}, replayBase: { streak: 7, grace: 1, date: '2026-07-11' }
      }
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
      'たろう': {
        streak: 5, grace: 1, bonus: 0, course: 'juniorHigh', lastConfirmedDate: '2026-07-11',
        exemptDates: [], history: {}, replayBase: { streak: 5, grace: 1, date: '2026-07-11' }
      }
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
      'はなこ': {
        streak: 3, grace: 1, bonus: 0, lastConfirmedDate: '2026-07-12',
        exemptDates: [], history: { '2026-07-12': true }, replayBase: { streak: 0, grace: 1, date: null }
      }
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

describe('shiftDate()', () => {
  it('日数を足し引きできる(月またぎ)', () => {
    assert.strictEqual(shiftDate('2026-08-01', -1), '2026-07-31');
    assert.strictEqual(shiftDate('2026-08-31', 1), '2026-09-01');
    assert.strictEqual(shiftDate('2026-08-17', 0), '2026-08-17');
  });
});

describe('replayStreak()', () => {
  const base = { streak: 0, grace: 1, date: null };

  it('免除日がなければ1日ずつ確定したのと同じ値になる', () => {
    const history = { '2026-08-01': true, '2026-08-02': true, '2026-08-03': false };
    const replayed = replayStreak(base, history, []);

    // 同じ入力を confirmDay に順に通した結果と突き合わせる
    let state = { streak: 0, grace: 1, bonus: 0, lastConfirmedDate: null };
    ['2026-08-01', '2026-08-02', '2026-08-03'].forEach(date => {
      state = confirmDay(state, date, history[date]).state;
    });

    assert.strictEqual(replayed.streak, state.streak);
    assert.strictEqual(replayed.grace, state.grace);
    assert.strictEqual(replayed.lastConfirmedDate, '2026-08-03');
  });

  it('途中日を免除するとおたすけ消費が巻き戻る', () => {
    const history = { '2026-08-01': true, '2026-08-02': false, '2026-08-03': true };

    const withoutExempt = replayStreak(base, history, []);
    assert.strictEqual(withoutExempt.grace, 0, '免除なしではおたすけを1消費する');
    assert.strictEqual(withoutExempt.streak, 2);

    const withExempt = replayStreak(base, history, ['2026-08-02']);
    assert.strictEqual(withExempt.grace, 1, '免除するとおたすけが戻る');
    assert.strictEqual(withExempt.streak, 2, 'streak は維持される');
    assert.strictEqual(withExempt.events['2026-08-02'], 'exempt');
  });

  it('リセットされた日を免除すると連続日数が復活する', () => {
    const noGrace = { streak: 4, grace: 0, date: '2026-07-31' };
    const history = { '2026-08-01': false, '2026-08-02': true };

    const withoutExempt = replayStreak(noGrace, history, []);
    assert.strictEqual(withoutExempt.streak, 1, '免除なしではリセット後に1日目から');

    const withExempt = replayStreak(noGrace, history, ['2026-08-01']);
    assert.strictEqual(withExempt.streak, 5, '免除すると4日目の続きになる');
  });

  it('免除日に学習していれば加算される', () => {
    const history = { '2026-08-01': true };
    const replayed = replayStreak(base, history, ['2026-08-01']);
    assert.strictEqual(replayed.streak, 1);
    assert.strictEqual(replayed.events['2026-08-01'], 'none');
  });

  it('壊れたエントリは無視する', () => {
    const history = { '2026-08-01': true, 'あした': true, '2026-08-02': 'yes' };
    const replayed = replayStreak(base, history, []);
    assert.strictEqual(replayed.streak, 1, '正常な1件だけが反映される');
    assert.strictEqual(replayed.lastConfirmedDate, '2026-08-01');
  });

  it('replayBase が欠けていても初期状態から復元する', () => {
    const replayed = replayStreak(undefined, { '2026-08-01': true }, []);
    assert.strictEqual(replayed.streak, 1);
  });

  it('履歴が空なら replayBase の値をそのまま返す', () => {
    const replayed = replayStreak({ streak: 7, grace: 2, date: '2026-07-31' }, {}, []);
    assert.strictEqual(replayed.streak, 7);
    assert.strictEqual(replayed.grace, 2);
    assert.strictEqual(replayed.lastConfirmedDate, '2026-07-31');
  });
});

describe('pruneHistory()', () => {
  it('保持期間内なら何も畳み込まない', () => {
    const state = {
      streak: 2, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-02',
      exemptDates: [], history: { '2026-08-01': true, '2026-08-02': true },
      replayBase: { streak: 0, grace: 1, date: null }
    };
    const pruned = pruneHistory(state, 90);
    assert.deepStrictEqual(pruned.history, state.history);
  });

  it('保持期間より古い日は replayBase に畳み込まれる', () => {
    const state = {
      streak: 2, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-10',
      exemptDates: [], history: { '2026-08-01': true, '2026-08-10': true },
      replayBase: { streak: 0, grace: 1, date: null }
    };
    const pruned = pruneHistory(state, 5);

    assert.deepStrictEqual(Object.keys(pruned.history), ['2026-08-10'], '古い日が history から消える');
    assert.strictEqual(pruned.replayBase.streak, 1, '畳み込んだ日の分が replayBase に入る');
    assert.strictEqual(pruned.replayBase.date, '2026-08-01');
    assert.strictEqual(state.history['2026-08-01'], true, '入力を破壊しない');
  });

  it('畳み込む日の免除は replayBase に反映され、その免除日は取り除かれる', () => {
    const state = {
      streak: 3, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-10',
      exemptDates: ['2026-08-01', '2026-08-10'],
      history: { '2026-08-01': false, '2026-08-10': false },
      replayBase: { streak: 3, grace: 1, date: '2026-07-31' }
    };
    const pruned = pruneHistory(state, 5);

    assert.strictEqual(pruned.replayBase.grace, 1, '免除日なのでおたすけは消費されない');
    assert.strictEqual(pruned.replayBase.streak, 3, 'streak も据え置き');
    assert.deepStrictEqual(pruned.exemptDates, ['2026-08-10'], '畳み込み済みの免除日は消える');
  });

  it('リプレイの結果は畳み込みの前後で変わらない', () => {
    const state = {
      streak: 0, grace: 1, bonus: 0, lastConfirmedDate: '2026-08-10',
      exemptDates: ['2026-08-02'],
      history: { '2026-08-01': true, '2026-08-02': false, '2026-08-10': true },
      replayBase: { streak: 0, grace: 1, date: null }
    };
    const before = replayStreak(state.replayBase, state.history, state.exemptDates);
    const pruned = pruneHistory(state, 3);
    const after = replayStreak(pruned.replayBase, pruned.history, pruned.exemptDates);

    assert.strictEqual(after.streak, before.streak);
    assert.strictEqual(after.grace, before.grace);
    assert.strictEqual(after.lastConfirmedDate, before.lastConfirmedDate);
  });
});

describe('collapseHistory()', () => {
  it('現在値をチェックポイントに移して履歴を空にする', () => {
    const state = {
      streak: 7, grace: 2, bonus: 3, lastConfirmedDate: '2026-08-16',
      exemptDates: ['2026-08-10'],
      history: { '2026-08-15': true, '2026-08-16': true },
      replayBase: { streak: 0, grace: 1, date: null }
    };
    const collapsed = collapseHistory(state);

    assert.deepStrictEqual(collapsed.history, {}, '履歴は空になる');
    assert.deepStrictEqual(collapsed.replayBase, { streak: 7, grace: 2, date: '2026-08-16' });
    assert.strictEqual(collapsed.bonus, 3, 'ボーナスは触らない');
    assert.deepStrictEqual(collapsed.exemptDates, ['2026-08-10'], '免除日は残る');
    assert.deepStrictEqual(state.history, { '2026-08-15': true, '2026-08-16': true }, '入力を破壊しない');
  });

  it('畳み込んだ値は次の確定でも維持される(手動変更が巻き戻らない)', () => {
    // 8/15 学習 → 8/16 学習 で streak 2 / grace 1 になった状態
    let state = confirmDayWithHistory(createInitialState(), '2026-08-15', true).state;
    state = confirmDayWithHistory(state, '2026-08-16', true).state;
    assert.strictEqual(state.streak, 2);

    // grace を手動で 3 にする → 畳み込まないと次の確定でリプレイに戻される
    const adjusted = collapseHistory({ ...state, grace: 3 });
    const next = confirmDayWithHistory(adjusted, '2026-08-17', true).state;

    assert.strictEqual(next.grace, 3, '手動変更した grace が維持される');
    assert.strictEqual(next.streak, 3, '連続日数は通常どおり加算される');
  });

  it('畳み込まないと手動変更は次の確定で失われる(回帰の証拠)', () => {
    let state = confirmDayWithHistory(createInitialState(), '2026-08-15', true).state;
    state = confirmDayWithHistory(state, '2026-08-16', true).state;

    const notCollapsed = { ...state, grace: 3 };
    const next = confirmDayWithHistory(notCollapsed, '2026-08-17', true).state;

    assert.notStrictEqual(next.grace, 3, '畳み込まない場合はリプレイ結果に戻る');
  });
});

describe('createInitialState() - 免除日フィールド', () => {
  it('免除日・履歴・チェックポイントが初期化される', () => {
    const state = createInitialState();
    assert.deepStrictEqual(state.exemptDates, []);
    assert.deepStrictEqual(state.history, {});
    assert.strictEqual(state.replayBase.date, null);
    assert.strictEqual(state.replayBase.streak, 0);
  });
});

describe('confirmDayWithHistory()', () => {
  it('履歴に追記してリプレイ結果を返す', () => {
    const state = createInitialState();
    const { state: next, event } = confirmDayWithHistory(state, '2026-08-01', true);
    assert.strictEqual(next.streak, 1);
    assert.strictEqual(next.history['2026-08-01'], true);
    assert.strictEqual(next.lastConfirmedDate, '2026-08-01');
    assert.strictEqual(event, 'none');
  });

  it('同じ日を2回確定しても値が動かない(冪等)', () => {
    const first = confirmDayWithHistory(createInitialState(), '2026-08-01', true).state;
    const second = confirmDayWithHistory(first, '2026-08-01', true);
    assert.strictEqual(second.state.streak, 1, '二重加算されない');
    assert.strictEqual(second.event, 'none');
  });

  it('免除日は未学習でも記録が守られる', () => {
    let state = confirmDayWithHistory(createInitialState(), '2026-08-01', true).state;
    state = { ...state, exemptDates: ['2026-08-02'] };
    const { state: next, event } = confirmDayWithHistory(state, '2026-08-02', false);
    assert.strictEqual(event, 'exempt');
    assert.strictEqual(next.streak, 1, 'streak は据え置き');
    assert.strictEqual(next.grace, GRACE_INITIAL, 'おたすけも据え置き');
  });

  it('イベントが bonus の日だけボーナスが増える', () => {
    // おたすけ満タンで学習するとボーナス+1
    const state = {
      ...createInitialState(),
      grace: 3,
      replayBase: { streak: 0, grace: 3, date: null }
    };
    const { state: next, event } = confirmDayWithHistory(state, '2026-08-01', true);
    assert.strictEqual(event, 'bonus');
    assert.strictEqual(next.bonus, 1);
  });

  it('入力の状態を破壊しない', () => {
    const state = createInitialState();
    confirmDayWithHistory(state, '2026-08-01', true);
    assert.deepStrictEqual(state.history, {}, '入力の history は空のまま');
  });
});

describe('updateStreaks() - 遡及免除の反映', () => {
  it('確定済みの日を後から免除するとリプレイで修復される', () => {
    const users = [{ userName: 'たろう', studyItemCount: 0, missions: [] }];

    // 1日目は学習、2日目は未学習でおたすけを消費
    let streakUsers = updateStreaks(
      {}, [{ userName: 'たろう', studyItemCount: 4, missions: [] }], '2026-08-01',
      { minCompletedMissions: 4 }
    ).streakUsers;
    streakUsers = updateStreaks(streakUsers, users, '2026-08-02', { minCompletedMissions: 4 }).streakUsers;
    assert.strictEqual(streakUsers['たろう'].grace, GRACE_INITIAL - 1, 'おたすけが1減っている');

    // 2日目を免除に指定してリプレイすると戻る
    const repaired = { ...streakUsers['たろう'], exemptDates: ['2026-08-02'] };
    const replayed = replayStreak(repaired.replayBase, repaired.history, repaired.exemptDates);
    assert.strictEqual(replayed.grace, GRACE_INITIAL, 'おたすけが復活する');
    assert.strictEqual(replayed.streak, 1, 'streak は維持される');
  });

  it('dataReliable: false の未学習日は履歴に入らない', () => {
    const users = [{ userName: 'たろう', studyItemCount: 0, missions: [], dataReliable: false }];
    const { streakUsers } = updateStreaks({}, users, '2026-08-01', { minCompletedMissions: 4 });
    assert.deepStrictEqual(streakUsers['たろう'].history, {}, '確定していない日は記録しない');
  });
});

describe('formatStreakInfo() - 免除日', () => {
  it('exempt イベントの行を出す', () => {
    const text = formatStreakInfo({
      state: { streak: 12, grace: 2, bonus: 0 },
      event: 'exempt'
    });
    assert.ok(text.includes('😌 免除日のため記録はそのままです'), text);
  });
});

function resolveStreakModule(p) {
  return require.resolve(p);
}

const STREAK_MODULE_PATHS = ['../src/streak', '../src/store'];

function clearStreakModuleCache() {
  for (const p of STREAK_MODULE_PATHS) {
    try { delete require.cache[resolveStreakModule(p)]; } catch {}
  }
}

/**
 * storeをモックしてsrc/streak.jsをロードする
 *
 * @param {object} overrides - readState / writeState の差し替え
 * @returns {{streakModule: object, writes: Array<{key: string, value: string}>}}
 */
function loadStreakWithStore(overrides = {}) {
  clearStreakModuleCache();
  const writes = [];

  require.cache[resolveStreakModule('../src/store')] = {
    id: resolveStreakModule('../src/store'),
    filename: resolveStreakModule('../src/store'),
    loaded: true,
    exports: {
      readState: overrides.readState || (async () => ({ success: true, state: 'empty', value: null })),
      writeState: overrides.writeState || (async (key, value) => {
        writes.push({ key, value });
        return { success: true };
      }),
      resolveEndpoint: () => 'https://test-db.turso.io/v2/pipeline',
      createSchema: async () => ({ success: true })
    }
  };

  return { streakModule: require('../src/streak'), writes };
}

describe('ストリークモジュール - Turso永続化', () => {
  afterEach(() => {
    clearStreakModuleCache();
  });

  it('state=empty なら空マップを返す(初回実行)', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'empty', value: null })
    });

    const result = await streakModule.loadStreakData();

    assert.deepStrictEqual(result, { success: true, data: {} });
  });

  it('state=uninitialized なら uninitialized フラグ付きで失敗を返す(移行前)', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'uninitialized', value: null })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.uninitialized, true);
    assert.match(result.error, /未初期化/);
  });

  it('readStateの失敗はuninitializedを混入させずそのままエラーとして返す', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: false, error: 'タイムアウト: Turso が10000ms以内に応答しませんでした' })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /タイムアウト/);
    assert.strictEqual(result.uninitialized, undefined, 'state=uninitializedのケースと混同してはならない');
  });

  it('streak_data キーで読み出す', async () => {
    const readKeys = [];
    const { streakModule } = loadStreakWithStore({
      readState: async (key) => {
        readKeys.push(key);
        return { success: true, state: 'empty', value: null };
      }
    });

    await streakModule.loadStreakData();

    assert.deepStrictEqual(readKeys, ['streak_data']);
  });

  it('v1.4のデータをそのまま読み出す(おたすけの再チャージなし)', async () => {
    const stored = JSON.stringify({
      version: '1.4',
      timestamp: '2026-08-27T00:00:00.000Z',
      users: {
        'たろう': {
          streak: 5, grace: 2, bonus: 1, course: 'elementary',
          lastConfirmedDate: '2026-08-26', exemptDates: [], history: { '2026-08-26': true },
          replayBase: { streak: 0, grace: 1, date: null }
        }
      }
    });
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['たろう'].streak, 5);
    assert.strictEqual(result.data['たろう'].bonus, 1);
    assert.strictEqual(result.data['たろう'].grace, 2, '1.4は再チャージ対象外なこと');
    assert.deepStrictEqual(result.data['たろう'].exemptDates, []);
    assert.deepStrictEqual(result.data['たろう'].history, { '2026-08-26': true });
    assert.deepStrictEqual(result.data['たろう'].replayBase, { streak: 0, grace: 1, date: null }, '既存のreplayBaseは上書きされないこと');
  });

  it('v1.0のデータは全ユーザーのおたすけを満タン(3)にし免除日フィールドを補う', async () => {
    const stored = JSON.stringify({
      version: '1.0',
      users: {
        'じろう (小学生コース)': { streak: 3, grace: 0, lastConfirmedDate: '2026-07-12' },
        'たろう (中学生コース)': { streak: 15, grace: 2, lastConfirmedDate: '2026-07-12' }
      }
    });
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['じろう (小学生コース)'].grace, 3, 'おたすけ0は3になること');
    assert.strictEqual(result.data['じろう (小学生コース)'].streak, 3, 'ストリークは変わらないこと');
    assert.strictEqual(result.data['たろう (中学生コース)'].grace, 3, 'おたすけ2も3になること');
    assert.deepStrictEqual(result.data['じろう (小学生コース)'].exemptDates, []);
    assert.deepStrictEqual(result.data['じろう (小学生コース)'].history, {});
    assert.strictEqual(result.data['じろう (小学生コース)'].replayBase.streak, 3);
  });

  it('v1.1のデータも全ユーザーのおたすけを満タン(3)にする', async () => {
    const stored = JSON.stringify({
      version: '1.1',
      users: {
        'じろう (小学生コース)': { streak: 3, grace: 1, lastConfirmedDate: '2026-07-12' }
      }
    });
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['じろう (小学生コース)'].grace, 3, '1.1データも満タンチャージ対象なこと');
    assert.deepStrictEqual(result.data['じろう (小学生コース)'].exemptDates, []);
  });

  it('v1.2以前のデータはおたすけ満タンと免除日フィールドを補って読み出す', async () => {
    const stored = JSON.stringify({
      version: '1.2',
      users: { 'はなこ': { streak: 3, grace: 0, bonus: 0, lastConfirmedDate: '2026-08-20' } }
    });
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data['はなこ'].grace, 3, '1.3移行でおたすけが満タンになること');
    assert.deepStrictEqual(result.data['はなこ'].exemptDates, [], '1.4移行でexemptDatesが補われること');
    assert.deepStrictEqual(result.data['はなこ'].history, {});
  });

  it('v1.3のデータはおたすけを再チャージせず免除日フィールドのみ補う(消費済みは再付与しない)', async () => {
    const stored = JSON.stringify({
      version: '1.3',
      timestamp: '2026-08-16T00:00:00.000Z',
      users: { 'たろう': { streak: 7, grace: 0, bonus: 3, lastConfirmedDate: '2026-08-16' } }
    });
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: stored })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, true);
    const state = result.data['たろう'];
    assert.strictEqual(state.grace, 0, '1.3データは満タンチャージ対象外なこと');
    assert.deepStrictEqual(state.exemptDates, []);
    assert.deepStrictEqual(state.history, {});
    assert.strictEqual(state.replayBase.streak, 7, '現在値がチェックポイントになる');
    assert.strictEqual(state.replayBase.grace, 0);
    assert.strictEqual(state.replayBase.date, '2026-08-16');
  });

  it('未知のバージョンは失敗として返す', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: JSON.stringify({ version: '9.9', users: {} }) })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /未知のストリークデータバージョン/);
  });

  it('壊れたJSONはパースエラーとして返す', async () => {
    const { streakModule } = loadStreakWithStore({
      readState: async () => ({ success: true, state: 'ok', value: 'not json' })
    });

    const result = await streakModule.loadStreakData();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /JSONパースエラー/);
  });

  it('saveStreakDataはstreak_dataキーに整形なしJSONを書く(version 1.4とISO 8601 timestamp)', async () => {
    const { streakModule, writes } = loadStreakWithStore();

    const result = await streakModule.saveStreakData({ 'じろう': { streak: 1, grace: 1, bonus: 0 } });

    assert.deepStrictEqual(result, { success: true });
    assert.strictEqual(writes[0].key, 'streak_data');
    assert.ok(!writes[0].value.includes('\n'), '整形せず1行で保存すること');

    const saved = JSON.parse(writes[0].value);
    assert.strictEqual(saved.version, '1.4');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(saved.timestamp), 'ISO 8601形式のtimestampが含まれること');
    assert.strictEqual(saved.users['じろう'].streak, 1);
  });

  it('saveStreakDataはオブジェクト以外を拒否する', async () => {
    const { streakModule, writes } = loadStreakWithStore();

    const result = await streakModule.saveStreakData([]);

    assert.strictEqual(result.success, false);
    assert.match(result.error, /オブジェクト/);
    assert.strictEqual(writes.length, 0, '検証に失敗したら書き込まないこと');
  });

  it('書き込みの失敗はエラーとして返す', async () => {
    const { streakModule } = loadStreakWithStore({
      writeState: async () => ({ success: false, error: 'SQL エラー: no such table: app_state' })
    });

    const result = await streakModule.saveStreakData({});

    assert.strictEqual(result.success, false);
    assert.match(result.error, /no such table/);
  });

  it('保存したデータをそのまま読み戻せる(モックストア越しのラウンドトリップ)', async () => {
    let storedValue = null;
    const { streakModule } = loadStreakWithStore({
      readState: async () => storedValue === null
        ? { success: true, state: 'empty', value: null }
        : { success: true, state: 'ok', value: storedValue },
      writeState: async (key, value) => {
        storedValue = value;
        return { success: true };
      }
    });

    const users = {
      'たろう (中学生コース)': {
        streak: 12, grace: 1, bonus: 0, course: 'juniorHigh',
        lastConfirmedDate: '2026-07-12', exemptDates: [], history: {},
        replayBase: { streak: 12, grace: 1, date: '2026-07-12' }
      }
    };

    const saveResult = await streakModule.saveStreakData(users);
    assert.strictEqual(saveResult.success, true);

    const loadResult = await streakModule.loadStreakData();
    assert.strictEqual(loadResult.success, true);
    assert.deepStrictEqual(loadResult.data, users);
  });
});
