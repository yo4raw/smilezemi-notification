/**
 * 通知モジュールのテスト
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 7.1, 7.2, 9.4
 */

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

describe('通知モジュール (src/notifier.js)', () => {
  let notifier;
  let mockFetch;

  beforeEach(() => {
    // モジュールを読み込む（実装後に動作）
    notifier = require('../src/notifier');

    // グローバルfetchのモック
    mockFetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({})
    }));
    global.fetch = mockFetch;
  });

  describe('sendPushMessage() - リトライ', () => {
    it('異常系: API呼び出し失敗時、リトライして最終的にエラーを返す', async () => {
      // 常にエラーを返すモック
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      }));

      const result = await notifier.sendPushMessage('テストメッセージ', 'token', 'user', { maxRetries: 3 });

      assert.strictEqual(result.success, false, '通知送信が失敗すること');
      assert.strictEqual(global.fetch.mock.calls.length, 3, '3回リトライされること');
      assert.match(result.error, /API|失敗|エラー|500/i, 'エラーメッセージが含まれること');
    });

    it('異常系: ネットワークエラー時、リトライしてエラーを返す', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Network error');
      });

      const result = await notifier.sendPushMessage('テストメッセージ', 'token', 'user', { maxRetries: 3 });

      assert.strictEqual(result.success, false);
      assert.strictEqual(global.fetch.mock.calls.length, 3, '3回リトライされること');
      assert.match(result.error, /ネットワーク|Network/i);
    });

    it('異常系: 認証エラー時（401）、リトライせずにエラーを返す', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      }));

      const result = await notifier.sendPushMessage('テストメッセージ', 'invalid_token', 'user');

      assert.strictEqual(result.success, false);
      assert.strictEqual(global.fetch.mock.calls.length, 1, '認証エラーはリトライしないこと');
      assert.match(result.error, /認証|Unauthorized|401/i);
    });

    it('正常系: リトライ間隔が指数バックオフであること', async () => {
      let callCount = 0;
      const callTimes = [];

      global.fetch = mock.fn(async () => {
        callTimes.push(Date.now());
        callCount++;
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error'
        };
      });

      await notifier.sendPushMessage('テストメッセージ', 'token', 'user', {
        maxRetries: 3,
        retryDelay: 100
      });

      assert.strictEqual(callCount, 3, '3回試行されること');

      // 2回目と1回目の間隔が約100ms（指数バックオフの初回: 100ms）
      if (callTimes.length >= 2) {
        const interval1 = callTimes[1] - callTimes[0];
        assert.strictEqual(interval1 >= 90 && interval1 <= 150, true, '1回目のリトライ間隔が適切であること');
      }

      // 3回目と2回目の間隔が約200ms（指数バックオフの2回目: 200ms）
      if (callTimes.length >= 3) {
        const interval2 = callTimes[2] - callTimes[1];
        assert.strictEqual(interval2 >= 180 && interval2 <= 250, true, '2回目のリトライ間隔が適切であること');
      }
    });
  });

  describe('sendPushMessage() - 整形済みメッセージ送信', () => {
    it('正常系: 整形済みメッセージをそのまま送信できる', async () => {
      const result = await notifier.sendPushMessage('テストメッセージ', 'test_token', 'test_user');

      assert.strictEqual(result.success, true, '送信が成功すること');
      assert.strictEqual(mockFetch.mock.calls.length, 1, 'fetchが1回呼ばれること');

      const [url, options] = mockFetch.mock.calls[0].arguments;
      assert.strictEqual(url, 'https://api.line.me/v2/bot/message/push');
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers['Authorization'], 'Bearer test_token');

      const body = JSON.parse(options.body);
      assert.strictEqual(body.to, 'test_user');
      assert.strictEqual(body.messages[0].type, 'text');
      assert.strictEqual(body.messages[0].text, 'テストメッセージ', 'メッセージが整形されずそのまま送られること');
    });

    it('異常系: 必須パラメータ欠落時はエラーを返す', async () => {
      const result = await notifier.sendPushMessage('テスト', '', '');

      assert.strictEqual(result.success, false);
      assert.match(result.error, /必須パラメータ/);
      assert.strictEqual(mockFetch.mock.calls.length, 0, 'fetchが呼ばれないこと');
    });

    it('異常系: 401はリトライせず即失敗する', async () => {
      global.fetch = mockFetch = mock.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      }));

      const result = await notifier.sendPushMessage('テスト', 'bad_token', 'test_user', { retryDelay: 1 });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /401/);
      assert.strictEqual(mockFetch.mock.calls.length, 1, 'リトライされないこと');
    });

    it('異常系: 429(月間上限超過)はリトライせず即失敗する', async () => {
      global.fetch = mockFetch = mock.fn(async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => '{"message":"You have reached your monthly limit."}'
      }));

      const result = await notifier.sendPushMessage('テスト', 'test_token', 'test_user', { retryDelay: 1 });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /429/);
      assert.strictEqual(mockFetch.mock.calls.length, 1, '上限超過はリトライしても解決しないためリトライされないこと');
    });

    it('異常系: エラー時はレスポンスボディの内容がエラーメッセージに含まれる', async () => {
      global.fetch = mockFetch = mock.fn(async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => '{"message":"You have reached your monthly limit."}'
      }));

      const result = await notifier.sendPushMessage('テスト', 'test_token', 'test_user', { retryDelay: 1 });

      assert.match(result.error, /monthly limit/, '原因調査のためAPIが返す理由が記録されること');
    });

    it('異常系: レスポンスボディが読めなくてもエラー処理が壊れない', async () => {
      // text()を持たないレスポンス(ボディ取得不可)でも従来どおりstatusは報告される
      global.fetch = mockFetch = mock.fn(async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests'
      }));

      const result = await notifier.sendPushMessage('テスト', 'test_token', 'test_user', { retryDelay: 1 });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /429/);
    });

    it('異常系: 5xxはリトライして成功できる', async () => {
      let callCount = 0;
      global.fetch = mockFetch = mock.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { ok: false, status: 500, statusText: 'Internal Server Error' };
        }
        return { ok: true, status: 200, statusText: 'OK' };
      });

      const result = await notifier.sendPushMessage('テスト', 'test_token', 'test_user', { retryDelay: 1 });

      assert.strictEqual(result.success, true, 'リトライ後に成功すること');
      assert.strictEqual(mockFetch.mock.calls.length, 2, '2回目で成功すること');
    });

    it('異常系: タイムアウトすると中断されリトライされる', async () => {
      global.fetch = mockFetch = mock.fn((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new Error('This operation was aborted'));
        });
      }));

      const result = await notifier.sendPushMessage('テスト', 'test_token', 'test_user', {
        maxRetries: 2,
        retryDelay: 1,
        timeoutMs: 30
      });

      assert.strictEqual(result.success, false, '全試行タイムアウトで失敗すること');
      assert.strictEqual(mockFetch.mock.calls.length, 2, 'タイムアウト後にリトライされること');
    });

    it('セキュリティ: 正規表現の特殊文字を含むトークンもエラー文からマスクされる', async () => {
      // LINEのトークンは Base64 系で + / = を含みうる。[ ( はマスク処理を壊しやすい文字
      const token = 'abc+def/ghi=[jkl](mno).pqr*stu?vwx^yz${1}|end';
      global.fetch = mockFetch = mock.fn(async () => {
        throw new Error(`network failure with token ${token} in message`);
      });

      const result = await notifier.sendPushMessage('テスト', token, 'test_user', {
        maxRetries: 1,
        retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.ok(!result.error.includes(token), 'トークンがエラー文に残らないこと');
      assert.match(result.error, /\*\*\*/, 'マスク記号に置換されること');
    });

    it('セキュリティ: 特殊文字を含むトークンでもマスク処理が例外を投げない', async () => {
      // 未エスケープで RegExp を組むと SyntaxError になるトークン
      const token = 'token-with-unterminated-class-[abc';
      global.fetch = mockFetch = mock.fn(async () => {
        throw new Error(`fetch failed for ${token}`);
      });

      const result = await notifier.sendPushMessage('テスト', token, 'test_user', {
        maxRetries: 1,
        retryDelay: 1
      });

      assert.strictEqual(result.success, false, '例外ではなく失敗結果を返すこと');
      assert.ok(!result.error.includes(token), 'トークンがエラー文に残らないこと');
    });

    it('セキュリティ: レスポンスボディに含まれる特殊文字入りトークンもマスクされる', async () => {
      const token = 'body+token/with[special]chars';
      global.fetch = mockFetch = mock.fn(async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => `{"message":"invalid token ${token}"}`
      }));

      const result = await notifier.sendPushMessage('テスト', token, 'test_user', {
        maxRetries: 1,
        retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.ok(!result.error.includes(token), 'トークンがエラー文に残らないこと');
    });
  });

  describe('センシティブデータのマスキング', () => {
    it('エラーメッセージにアクセストークンが含まれない', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Failed with token: secret_token_12345');
      });

      const result = await notifier.sendPushMessage('テストメッセージ', 'secret_token_12345', 'user');

      assert.strictEqual(result.success, false);
      assert.strictEqual(
        result.error.includes('secret_token_12345'),
        false,
        'エラーメッセージにトークンが含まれないこと'
      );
      assert.match(result.error, /\*\*\*/, 'トークンがマスキングされること');
    });
  });

  describe('ユーザー一覧通知関数の削除確認 (Requirement 3.2, 3.3)', () => {
    it('sendUserListNotification関数が存在しないこと', () => {
      assert.strictEqual(
        typeof notifier.sendUserListNotification,
        'undefined',
        'sendUserListNotification関数はエクスポートされていないこと'
      );
    });

    it('formatUserListMessage関数が存在しないこと', () => {
      assert.strictEqual(
        typeof notifier.formatUserListMessage,
        'undefined',
        'formatUserListMessage関数はエクスポートされていないこと'
      );
    });

    it('module.exportsに詳細データ通知関連の関数のみが含まれること', () => {
      const exports = Object.keys(notifier);

      // 存在すべき関数
      assert.deepStrictEqual(exports.toSorted(), ['formatDetailedMessage', 'sendPushMessage', 'truncateToLimit']);

      // 削除されるべき関数
      assert.strictEqual(exports.includes('sendUserListNotification'), false, 'sendUserListNotificationが含まれないこと');
      assert.strictEqual(exports.includes('formatUserListMessage'), false, 'formatUserListMessageが含まれないこと');
    });
  });

  describe('formatDetailedMessage - ミッション未達警告 (missionWarningThresholds)', () => {
    const baseUser = {
      userName: 'じろう (小学生コース)',
      missionCount: 3,
      date: '2026-07-13',
      studyTime: { hours: 1, minutes: 0 },
      totalScore: 240,
      missions: [
        { name: '算数', score: 80, completed: true },
        { name: '国語', score: 90, completed: true },
        { name: '理科', score: 70, completed: true }
      ]
    };

    it('完了ミッションが閾値未満なら警告行が表示される(today)', () => {
      const message = notifier.formatDetailedMessage([baseUser], {
        missionWarningThresholds: { elementary: 5, juniorHigh: 5 },
        missionWarningStyle: 'today'
      });

      assert.match(message, /🚨🚨 あと2件! がんばろう! 🚨🚨/, '残り件数つきの励まし文言が出ること');
    });

    it('missionWarningStyle: past は過去形の文言になる', () => {
      const message = notifier.formatDetailedMessage([baseUser], {
        missionWarningThresholds: { elementary: 5, juniorHigh: 5 },
        missionWarningStyle: 'past'
      });

      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, '過去形の文言が出ること');
    });

    it('missionWarningStyle 省略時は past 扱いになる', () => {
      const message = notifier.formatDetailedMessage([baseUser], { missionWarningThresholds: { elementary: 5, juniorHigh: 5 } });

      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, '既定は past であること');
    });

    it('missionWarningStyle が未知の値のときは past にフォールバックする', () => {
      const message = notifier.formatDetailedMessage([baseUser], {
        missionWarningThresholds: { elementary: 5, juniorHigh: 5 },
        missionWarningStyle: 'unknown'
      });

      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, '未知の値は past にフォールバックすること');
    });

    it('missionWarningStyle が "constructor" のような Object.prototype のプロパティ名でも past にフォールバックする', () => {
      const message = notifier.formatDetailedMessage([baseUser], {
        missionWarningThresholds: { elementary: 5, juniorHigh: 5 },
        missionWarningStyle: 'constructor'
      });

      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, 'prototype汚染を拾わずpastにフォールバックすること');
    });

    it('完了ミッションが閾値以上なら警告行は表示されない', () => {
      const user = { ...baseUser, missionCount: 5 };
      const message = notifier.formatDetailedMessage([user], { missionWarningThresholds: { elementary: 5, juniorHigh: 5 } });

      assert.doesNotMatch(message, /あと\d+件/, '警告行が含まれないこと');
    });

    it('閾値未指定なら警告行は表示されない', () => {
      const message = notifier.formatDetailedMessage([baseUser], {});

      assert.doesNotMatch(message, /あと\d+件/, '警告行が含まれないこと');
    });

    it('dataReliable:false のユーザーには警告を出さない(取得失敗の誤警告防止)', () => {
      const user = { ...baseUser, missionCount: 0, dataReliable: false };
      const message = notifier.formatDetailedMessage([user], { missionWarningThresholds: { elementary: 5, juniorHigh: 5 } });

      assert.doesNotMatch(message, /あと\d+件/, '警告行が含まれないこと');
    });

    it('dataReliable:false のユーザーは夜通知相当のオプションでもデータ取得失敗を表示し、未達警告は出さない', () => {
      const user = {
        userName: 'たろう (中学生コース)',
        course: 'juniorHigh',
        missionCount: 0,
        studyItemCount: 0,
        date: '2026-08-04',
        studyTime: { hours: 0, minutes: 0 },
        totalScore: 0,
        missions: [],
        dataReliable: false
      };
      const message = notifier.formatDetailedMessage([user], {
        showStudyTime: false,
        missionWarningStyle: 'today',
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });

      assert.match(message, /⚠️ データを取得できませんでした/, 'データ取得失敗の行が出ること');
      assert.doesNotMatch(message, /あと\d+件/, '未達警告行は出ないこと');
    });

    it('dataReliable:false かつ完全未学習のユーザーは朝通知相当のオプションでも「学習していません」ではなくデータ取得失敗を表示する', () => {
      const user = {
        userName: 'はなこ (小学生コース)',
        course: 'elementary',
        missionCount: 0,
        studyItemCount: 0,
        date: '2026-08-03',
        studyTime: { hours: 0, minutes: 0 },
        totalScore: 0,
        missions: [],
        dataReliable: false
      };
      const message = notifier.formatDetailedMessage([user], {
        showNoStudyWarning: true
      });

      assert.match(message, /⚠️ データを取得できませんでした/, 'データ取得失敗の行が出ること');
      assert.doesNotMatch(message, /昨日は学習していません/, '断定的な未学習警告は出さないこと');
    });

    it('dataReliable 未設定のユーザーにはデータ取得失敗行を出さない', () => {
      const message = notifier.formatDetailedMessage([baseUser], { missionWarningThresholds: { elementary: 5, juniorHigh: 5 } });

      assert.doesNotMatch(message, /データを取得できませんでした/, 'dataReliable未設定なら出ないこと');
    });

    it('警告文言はコースが違っても同一になる', () => {
      const juniorUser = {
        userName: 'たろう (中学生コース)',
        course: 'juniorHigh',
        missionCount: 2,
        date: '2026-07-13',
        studyTime: { hours: 0, minutes: 30 },
        totalScore: 150,
        missions: [
          { name: '数学: いろいろな図形', score: 66, completed: true },
          { name: '英語: 不定詞', score: 80, completed: true }
        ]
      };
      const message = notifier.formatDetailedMessage([juniorUser], {
        missionWarningThresholds: { elementary: 4, juniorHigh: 4 },
        missionWarningStyle: 'today'
      });

      assert.match(message, /🚨🚨 あと2件! がんばろう! 🚨🚨/, '小学生と同じ文言になること');
      assert.doesNotMatch(message, /講座完了/, '旧表記が残っていないこと');
      assert.doesNotMatch(message, /連続学習/, '「連続学習」への言及が消えていること');
    });

    it('showNoStudyWarning併用時、完全未学習の日は「学習していません」のみで閾値警告を重複させない', () => {
      const noStudyUser = {
        userName: 'たろう (中学生コース)',
        missionCount: 0,
        date: '2026-07-13',
        studyTime: { hours: 0, minutes: 0 },
        totalScore: 0,
        missions: []
      };
      const message = notifier.formatDetailedMessage([noStudyUser], {
        showNoStudyWarning: true,
        missionWarningThresholds: { elementary: 4, juniorHigh: 4 }
      });

      assert.match(message, /昨日は学習していません/, '未学習警告が表示されること');
      assert.doesNotMatch(message, /あと\d+件/, '閾値警告が重複しないこと');
    });

    it('showNoStudyWarning併用時、部分学習(閾値未満)の日は閾値警告が表示される', () => {
      const partialUser = {
        userName: 'たろう (中学生コース)',
        missionCount: 1,
        date: '2026-07-13',
        studyTime: { hours: 0, minutes: 10 },
        totalScore: 66,
        missions: [{ name: '数学: いろいろな図形', score: 66, completed: true }]
      };
      const message = notifier.formatDetailedMessage([partialUser], {
        showNoStudyWarning: true,
        missionWarningThresholds: { elementary: 4, juniorHigh: 4 }
      });

      assert.match(message, /😢😢 あと3件たりなかった… 😢😢/, '閾値警告が表示されること');
      assert.doesNotMatch(message, /昨日は学習していません/, '未学習警告は表示されないこと');
    });

    it('missionWarningThresholds: courseフィールドで小学生に elementary 閾値を適用', () => {
      const user = {
        userName: 'じろう', course: 'elementary', missionCount: 3,
        date: '2026-07-13', studyTime: { hours: 1, minutes: 0 }, totalScore: 240,
        missions: [{ name: '算数', score: 80, completed: true }]
      };
      const message = notifier.formatDetailedMessage([user], {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /😢😢 あと1件たりなかった… 😢😢/, '小学生は elementary(4) 閾値が使われること');
    });

    it('missionWarningThresholds: courseフィールドで中学生に juniorHigh 閾値を適用', () => {
      const user = {
        userName: 'たろう', course: 'juniorHigh', missionCount: 2,
        date: '2026-07-13', studyTime: { hours: 0, minutes: 30 }, totalScore: 150,
        missions: [{ name: '数学: 図形', score: 66, completed: true }]
      };
      const message = notifier.formatDetailedMessage([user], {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /😢😢 あと1件たりなかった… 😢😢/, '中学生は juniorHigh(3) 閾値が使われること');
    });

    it('missionWarningThresholds: 混在データを1メッセージでコース別に警告する', () => {
      const elem = {
        userName: 'じろう', course: 'elementary', missionCount: 3,
        date: '2026-07-13', studyTime: { hours: 1, minutes: 0 }, totalScore: 240,
        missions: [{ name: '算数', score: 80, completed: true }]
      };
      const jh = {
        userName: 'たろう', course: 'juniorHigh', missionCount: 1,
        date: '2026-07-13', studyTime: { hours: 0, minutes: 30 }, totalScore: 150,
        missions: [{ name: '数学: 図形', score: 66, completed: true }]
      };
      const message = notifier.formatDetailedMessage([elem, jh], {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });
      assert.match(message, /😢😢 あと1件たりなかった… 😢😢/, '小学生の警告(4-3=1件)');
      assert.match(message, /😢😢 あと2件たりなかった… 😢😢/, '中学生の警告(3-1=2件)');
    });

  });

  describe('formatDetailedMessage - 朝通知オプション', () => {
    const { formatDetailedMessage } = require('../src/notifier');

    it('dateLabel 指定でヘッダに日付ラベルが入る', () => {
      const userData = [{
        userName: 'たろう (中学生コース)',
        missionCount: 1,
        date: '2026-07-09',
        studyTime: { hours: 1, minutes: 5 },
        totalScore: 80,
        missions: [{ name: '数学: 一次関数', score: 80, completed: true }]
      }];
      const message = formatDetailedMessage(userData, { dateLabel: '昨日(07/09)' });
      assert.ok(message.startsWith('📊 スマイルゼミ 昨日(07/09)の学習状況'));
      assert.ok(message.includes('⏱️ 勉強時間: 01:05'));
    });

    it('showNoStudyWarning: 未学習ユーザーに警告文言を表示し詳細セクションを出さない', () => {
      const userData = [{
        userName: 'たろう (中学生コース)',
        missionCount: 0,
        date: '2026-07-09',
        studyTime: { hours: 0, minutes: 0 },
        totalScore: 0,
        missions: []
      }];
      const message = formatDetailedMessage(userData, {
        dateLabel: '昨日(07/09)',
        showNoStudyWarning: true
      });
      assert.ok(message.includes('⚠️ 昨日は学習していません'));
      assert.ok(!message.includes('学習詳細'));
    });

    it('showNoStudyWarning でも学習ありのユーザーには警告を出さない', () => {
      const userData = [{
        userName: 'たろう (中学生コース)',
        missionCount: 1,
        date: '2026-07-09',
        studyTime: { hours: 0, minutes: 30 },
        totalScore: 90,
        missions: [{ name: '英語: 不定詞', score: 90, completed: true }]
      }];
      const message = formatDetailedMessage(userData, { showNoStudyWarning: true });
      assert.ok(!message.includes('⚠️ 昨日は学習していません'));
      assert.ok(message.includes('英語: 不定詞'));
    });

    it('データ0件のとき dateLabel 付きの文言を返す', () => {
      const message = formatDetailedMessage([], { dateLabel: '昨日(07/09)' });
      assert.ok(message.includes('昨日(07/09)のデータはありません。'));
    });

    it('オプション省略時は従来フォーマットのまま', () => {
      const message = formatDetailedMessage([]);
      assert.ok(message.startsWith('📊 スマイルゼミ 学習状況'));
      assert.ok(message.includes('本日のデータはありません。'));
    });
  });

  describe('formatDetailedMessage - 勉強時間の表示切り替え', () => {
    const { formatDetailedMessage } = require('../src/notifier');

    const userData = [{
      userName: 'たろう (小学生コース)',
      course: 'elementary',
      studyItemCount: 4,
      missionCount: 0,
      date: '2026-08-03',
      studyTime: { hours: 0, minutes: 13 },
      totalScore: 202,
      missions: [{ name: '国語テスト(2年生：夏)', score: 20, completed: true }]
    }];

    it('showStudyTime: false で勉強時間行を出さない', () => {
      const message = formatDetailedMessage(userData, { showStudyTime: false });
      assert.ok(!message.includes('勉強時間'), message);
      assert.ok(message.includes('✅ 学習4件'), '学習件数行は残ること');
    });

    it('showStudyTime 省略時は従来どおり勉強時間行を出す', () => {
      const message = formatDetailedMessage(userData, {});
      assert.ok(message.includes('⏱️ 勉強時間: 00:13'), message);
    });

    it('showStudyTime: false でも朝通知の完全未学習判定は勉強時間を見る', () => {
      const noStudy = [{
        userName: 'はなこ (小学生コース)',
        course: 'elementary',
        studyItemCount: 0,
        missionCount: 0,
        date: '2026-08-03',
        studyTime: { hours: 0, minutes: 0 },
        totalScore: 0,
        missions: []
      }];
      const message = formatDetailedMessage(noStudy, {
        showStudyTime: false,
        showNoStudyWarning: true
      });
      assert.ok(message.includes('⚠️ 昨日は学習していません'), message);
    });
  });

  describe('formatDetailedMessage - ストリーク表示', () => {
    const { formatDetailedMessage } = require('../src/notifier');

    const userData = [{
      userName: 'たろう (中学生コース)',
      missionCount: 1,
      date: '2026-07-12',
      studyTime: { hours: 0, minutes: 45 },
      totalScore: 80,
      missions: [{ name: '数学: 一次関数', score: 80, completed: true }]
    }];

    it('streaks オプションでユーザー名の直後にストリーク行が入る', () => {
      const streaks = { 'たろう (中学生コース)': '🔥 連続学習: 12日目  🛟 おたすけ: 1/3' };
      const message = formatDetailedMessage(userData, { streaks });
      const lines = message.split('\n');
      const nameIndex = lines.findIndex(line => line.startsWith('👤 たろう'));
      assert.strictEqual(lines[nameIndex + 1], '🔥 連続学習: 12日目  🛟 おたすけ: 1/3');
    });

    it('複数行のストリーク情報(イベント行付き)も表示される', () => {
      const streaks = {
        'たろう (中学生コース)': '🔥 連続学習: 10日目  🛟 おたすけ: 1/3\n🎉 10日連続達成!おたすけ+1(残り1)'
      };
      const message = formatDetailedMessage(userData, { streaks });
      assert.ok(message.includes('🎉 10日連続達成!おたすけ+1(残り1)'));
    });

    it('streaks に含まれないユーザーにはストリーク行を出さない', () => {
      const streaks = { '別の子 (小学生コース)': '🔥 連続学習: 3日目  🛟 おたすけ: 0/3' };
      const message = formatDetailedMessage(userData, { streaks });
      assert.ok(!message.includes('連続学習'));
    });

    it('streaks オプション省略時は従来フォーマットのまま', () => {
      const message = formatDetailedMessage(userData, {});
      assert.ok(!message.includes('連続学習'));
      assert.ok(message.includes('👤 たろう (中学生コース)'));
    });
  });

  describe('formatDetailedMessage - 学習件数の内訳と自主学習表示', () => {
    it('自主学習がある場合、学習件数行に内訳を表示する', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 5,
        missionCount: 4,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 343,
        missions: [
          { name: 'こそあど言葉', score: 93, completed: true, isMission: true },
          { name: '漢字のミニテスト', score: 0, completed: true, isMission: false, correctAnswers: 9, questionCount: 10 }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('✅ 学習5件（ミッション4・自主1）'), message);
    });

    it('自主学習が0件の場合、内訳を出さない', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 4,
        missionCount: 4,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 343,
        missions: [{ name: 'こそあど言葉', score: 93, completed: true, isMission: true }]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('✅ 学習4件'), message);
      assert.ok(!message.includes('自主'), message);
    });

    it('中学生コースの学習件数行は「講座」表記になる', () => {
      const userData = [{
        userName: 'じろう (中学生コース)',
        course: 'juniorHigh',
        studyItemCount: 4,
        missionCount: 4,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 300,
        missions: [{ name: '数学: 四則の混じった計算', score: 75, completed: true, isMission: true }]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('✅ 講座4件'), message);
      assert.ok(!message.includes('学習4件'), message);
      assert.ok(!message.includes('自主'), message);
    });

    it('自主学習の講座行に（自主）を付ける', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 2,
        missionCount: 1,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 93,
        missions: [
          { name: 'こそあど言葉', score: 93, completed: true, isMission: true },
          { name: 'ふしぎ探検 世界遺産', score: 0, completed: true, isMission: false }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・ふしぎ探検 世界遺産: 0点（自主）'), message);
      assert.ok(!message.includes('・こそあど言葉: 93点（自主）'), message);
    });

    it('同名の講座にミッションと自主が混在する場合、（自主）を付けない', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 2,
        missionCount: 1,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 175,
        missions: [
          { name: '漢字', score: 80, completed: true, isMission: true },
          { name: '漢字', score: 95, completed: true, isMission: false }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・漢字: 80→95点'), message);
      assert.ok(!message.includes('・漢字: 80→95点（自主）'), message);
    });

    it('isMission フィールドがない旧データの講座行には（自主）を付けない', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 1,
        missionCount: 1,
        studyTime: { hours: 0, minutes: 15 },
        totalScore: 70,
        missions: [
          { name: '英語', score: 70, completed: true }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・英語: 70点'), message);
      assert.ok(!message.includes('（自主）'), message);
    });

    it('正答数タイプの結果は 9/10 形式で表示する', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 1,
        missionCount: 0,
        studyTime: { hours: 0, minutes: 5 },
        totalScore: 0,
        missions: [
          { name: '漢字のミニテスト', score: 0, completed: true, isMission: false, correctAnswers: 9, questionCount: 10 }
        ]
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・漢字のミニテスト: 9/10（自主）'), message);
    });

    it('講座が11件以上の場合、10件までで打ち切り「ほか◯件」を出す', () => {
      const missions = Array.from({ length: 13 }, (_, i) => ({
        name: `講座${i + 1}`, score: 50, completed: true, isMission: true
      }));
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 13,
        missionCount: 13,
        studyTime: { hours: 1, minutes: 0 },
        totalScore: 650,
        missions
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・講座10: 50点'), message);
      assert.ok(!message.includes('・講座11:'), message);
      assert.ok(message.includes('・ほか3件'), message);
    });

    it('講座がちょうど10件の場合、「ほか◯件」を出さない', () => {
      const missions = Array.from({ length: 10 }, (_, i) => ({
        name: `講座${i + 1}`, score: 50, completed: true, isMission: true
      }));
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 10,
        missionCount: 10,
        studyTime: { hours: 1, minutes: 0 },
        totalScore: 500,
        missions
      }];

      const message = notifier.formatDetailedMessage(userData);

      assert.ok(message.includes('・講座10: 50点'), message);
      assert.ok(!message.includes('ほか'), message);
    });

    it('小学生コースの未達警告に残り件数が出る', () => {
      const userData = [{
        userName: 'たろう (小学生コース)',
        course: 'elementary',
        studyItemCount: 2,
        missionCount: 2,
        studyTime: { hours: 0, minutes: 10 },
        totalScore: 100,
        missions: [{ name: 'こそあど言葉', score: 100, completed: true, isMission: true }],
        dataReliable: true
      }];

      const message = notifier.formatDetailedMessage(userData, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });

      assert.ok(message.includes('😢😢 あと2件たりなかった… 😢😢'), message);
    });

    it('中学生コースの未達警告にも残り件数が出る', () => {
      const userData = [{
        userName: 'じろう (中学生コース)',
        course: 'juniorHigh',
        studyItemCount: 1,
        missionCount: 1,
        studyTime: { hours: 0, minutes: 10 },
        totalScore: 75,
        missions: [{ name: '数学: 四則の混じった計算', score: 75, completed: true, isMission: true }],
        dataReliable: true
      }];

      const message = notifier.formatDetailedMessage(userData, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 }
      });

      assert.ok(message.includes('😢😢 あと2件たりなかった… 😢😢'), message);
    });
  });

  describe('formatDetailedMessage() - 免除日', () => {
    const user = { userName: 'たろう', studyItemCount: 0, missionCount: 0, missions: [], date: '2026-08-17' };

    it('免除ユーザーには未達警告を出さない', () => {
      const message = notifier.formatDetailedMessage([user], {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
        missionWarningStyle: 'today',
        exemptUserNames: ['たろう']
      });
      assert.ok(!message.includes('あと'), `未達警告が出ている: ${message}`);
    });

    it('showExemptNotice が true ならおやすみ行を出す', () => {
      const message = notifier.formatDetailedMessage([user], {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
        missionWarningStyle: 'today',
        exemptUserNames: ['たろう'],
        showExemptNotice: true
      });
      assert.ok(message.includes('🏝️ 今日はおやすみ（免除日）'), message);
    });

    it('showExemptNotice を省略するとおやすみ行は出ない(朝通知はストリーク行で伝える)', () => {
      const message = notifier.formatDetailedMessage([user], {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
        exemptUserNames: ['たろう']
      });
      assert.ok(!message.includes('🏝️'), message);
    });

    it('免除ユーザー以外には従来どおり警告を出す', () => {
      const others = [user, { ...user, userName: 'はなこ' }];
      const message = notifier.formatDetailedMessage(others, {
        missionWarningThresholds: { elementary: 4, juniorHigh: 3 },
        missionWarningStyle: 'today',
        exemptUserNames: ['たろう']
      });
      assert.ok(message.includes('あと4件'), `はなこの警告が出ていない: ${message}`);
    });
  });

  describe('truncateToLimit() - 宛先別の文字数制限', () => {
    it('引数なしなら5000文字を上限として切り詰める', () => {
      const long = 'あ'.repeat(6000);

      const result = notifier.truncateToLimit(long);

      assert.strictEqual(result.length <= 5000, true, '5000文字以内に収まること');
      assert.match(result, /省略/, '省略された旨が付くこと');
    });

    it('上限を明示すればその長さで切り詰める(Discordの2000文字用)', () => {
      const long = 'あ'.repeat(3000);

      const result = notifier.truncateToLimit(long, 2000);

      assert.strictEqual(result.length <= 2000, true, '2000文字以内に収まること');
      assert.match(result, /省略/, '省略された旨が付くこと');
    });

    it('上限以下のメッセージはそのまま返す', () => {
      const short = 'みじかいメッセージ';

      assert.strictEqual(notifier.truncateToLimit(short, 2000), short);
    });

    it('絵文字(サロゲートペア)の途中で切れても孤立サロゲートを残さない', () => {
      // 👤 は UTF-16 で2コードユニット。切断位置が奇数になるよう長さを選ぶ
      const long = '👤'.repeat(1500);

      const result = notifier.truncateToLimit(long, 2000);

      assert.strictEqual(result.length <= 2000, true, '上限に収まること');
      assert.ok(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result),
        '孤立した高サロゲートが残らないこと'
      );
      assert.ok(
        !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result),
        '孤立した低サロゲートが残らないこと'
      );
      assert.match(result, /省略/, '省略された旨が付くこと');
    });

    it('切断位置がサロゲートペアの境界と一致する場合はそのまま切る', () => {
      // 先頭にASCIIを1文字入れて切断位置をずらし、境界一致のケースを作る
      const long = 'a' + '👤'.repeat(1500);

      const result = notifier.truncateToLimit(long, 2000);

      assert.strictEqual(result.length <= 2000, true, '上限に収まること');
      assert.ok(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result),
        '孤立した高サロゲートが残らないこと'
      );
    });
  });
});
