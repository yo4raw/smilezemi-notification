/**
 * LINE送信枠モジュールのテスト
 *
 * 月間送信可能数の取得（quota / consumption / メンバー数）と、
 * 通知末尾に付ける残数行のフォーマットを検証する。
 * global.fetch を差し替えてLINE APIをモックする。
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { fetchQuotaStatus, formatQuotaLine } = require('../src/line-quota');

const GROUP_CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: 'test_token',
  LINE_USER_ID: 'Cabcdef0123456789'
};

/**
 * URLごとのレスポンスを返す fetch モックを作る
 *
 * @param {object} routes - URLの部分文字列 → {status?, body?, throws?} のマップ
 * @returns {Function} fetch 互換関数（呼び出し記録を calls プロパティに持つ）
 */
function createFetchMock(routes) {
  const mock = async (url, init) => {
    mock.calls.push({ url, init });

    const key = Object.keys(routes).find(pattern => url.includes(pattern));
    const route = key ? routes[key] : { status: 404, body: '{"message":"not found"}' };

    if (route.throws) {
      throw route.throws;
    }

    return {
      ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
      status: route.status ?? 200,
      statusText: route.statusText ?? 'OK',
      json: async () => JSON.parse(route.body),
      text: async () => route.body
    };
  };

  mock.calls = [];
  return mock;
}

const OK_ROUTES = {
  '/message/quota/consumption': { body: '{"totalUsage":61}' },
  '/message/quota': { body: '{"type":"limited","value":200}' },
  '/members/count': { body: '{"count":4}' }
};

describe('LINE送信枠 (src/line-quota.js)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('formatQuotaLine()', () => {
    it('上限と人数がわかるとき、残数と残り送信回数を出す', () => {
      const line = formatQuotaLine({ limited: true, limit: 200, used: 61, remaining: 139, memberCount: 4 });

      assert.strictEqual(line, '📮 LINE残り: 139/200（あと34回）');
    });

    it('人数がわからないとき、残数だけを出す', () => {
      const line = formatQuotaLine({ limited: true, limit: 200, used: 61, remaining: 139, memberCount: null });

      assert.strictEqual(line, '📮 LINE残り: 139/200');
    });

    it('残数が人数に満たないとき、あと0回と出す', () => {
      const line = formatQuotaLine({ limited: true, limit: 200, used: 198, remaining: 2, memberCount: 4 });

      assert.strictEqual(line, '📮 LINE残り: 2/200（あと0回）');
    });

    it('上限なしプランのとき、今月の使用数を出す', () => {
      const line = formatQuotaLine({ limited: false, limit: null, used: 61, remaining: null, memberCount: 4 });

      assert.strictEqual(line, '📮 LINE送信数: 61（上限なし）');
    });

    it('データがないとき null を返す', () => {
      assert.strictEqual(formatQuotaLine(null), null);
      assert.strictEqual(formatQuotaLine(undefined), null);
    });
  });

  describe('fetchQuotaStatus()', () => {
    it('quota・consumption・メンバー数を集約して残数を返す', async () => {
      global.fetch = createFetchMock(OK_ROUTES);

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, {
        limited: true,
        limit: 200,
        used: 61,
        remaining: 139,
        memberCount: 4
      });
    });

    it('グループIDのときグループのメンバー数APIを叩く', async () => {
      const fetchMock = createFetchMock(OK_ROUTES);
      global.fetch = fetchMock;

      await fetchQuotaStatus(GROUP_CONFIG);

      const memberCall = fetchMock.calls.find(call => call.url.includes('/members/count'));
      assert.ok(memberCall, 'メンバー数APIが呼ばれていない');
      assert.ok(
        memberCall.url.includes('/v2/bot/group/Cabcdef0123456789/members/count'),
        `想定外のURL: ${memberCall.url}`
      );
    });

    it('ルームIDのときルームのメンバー数APIを叩く', async () => {
      const fetchMock = createFetchMock(OK_ROUTES);
      global.fetch = fetchMock;

      await fetchQuotaStatus({ ...GROUP_CONFIG, LINE_USER_ID: 'Rabcdef0123456789' });

      const memberCall = fetchMock.calls.find(call => call.url.includes('/members/count'));
      assert.ok(
        memberCall.url.includes('/v2/bot/room/Rabcdef0123456789/members/count'),
        `想定外のURL: ${memberCall.url}`
      );
    });

    it('個人宛のときはメンバー数APIを叩かず1人として数える', async () => {
      const fetchMock = createFetchMock(OK_ROUTES);
      global.fetch = fetchMock;

      const result = await fetchQuotaStatus({ ...GROUP_CONFIG, LINE_USER_ID: 'U0000000000' });

      assert.strictEqual(result.data.memberCount, 1);
      assert.strictEqual(fetchMock.calls.some(call => call.url.includes('/members/count')), false);
    });

    it('アクセストークンをBearerヘッダーで送る', async () => {
      const fetchMock = createFetchMock(OK_ROUTES);
      global.fetch = fetchMock;

      await fetchQuotaStatus(GROUP_CONFIG);

      for (const call of fetchMock.calls) {
        assert.strictEqual(call.init.headers.Authorization, 'Bearer test_token');
      }
    });

    it('メンバー数の取得だけ失敗しても残数は返す', async () => {
      global.fetch = createFetchMock({
        ...OK_ROUTES,
        '/members/count': { status: 403, statusText: 'Forbidden', body: '{"message":"forbidden"}' }
      });

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.remaining, 139);
      assert.strictEqual(result.data.memberCount, null);
    });

    it('上限なしプランのとき limited:false を返す', async () => {
      global.fetch = createFetchMock({
        ...OK_ROUTES,
        '/message/quota': { body: '{"type":"none"}' }
      });

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.limited, false);
      assert.strictEqual(result.data.limit, null);
      assert.strictEqual(result.data.remaining, null);
      assert.strictEqual(result.data.used, 61);
    });

    it('使用数が上限を超えていても残数を0未満にしない', async () => {
      global.fetch = createFetchMock({
        ...OK_ROUTES,
        '/message/quota/consumption': { body: '{"totalUsage":215}' }
      });

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.data.remaining, 0);
    });

    it('quota APIが失敗したら success:false を返す', async () => {
      global.fetch = createFetchMock({
        ...OK_ROUTES,
        '/message/quota': { status: 401, statusText: 'Unauthorized', body: '{"message":"invalid token"}' }
      });

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /401/);
    });

    it('consumption APIが失敗したら success:false を返す', async () => {
      global.fetch = createFetchMock({
        ...OK_ROUTES,
        '/message/quota/consumption': { status: 500, statusText: 'Internal Server Error', body: '{}' }
      });

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.success, false);
    });

    it('ネットワーク例外を投げずに success:false へ畳み込む', async () => {
      global.fetch = createFetchMock({
        '/message/quota': { throws: new Error('fetch failed') }
      });

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.success, false);
      assert.match(result.error, /fetch failed/);
    });

    it('エラーメッセージにアクセストークンを残さない', async () => {
      global.fetch = createFetchMock({
        '/message/quota': { throws: new Error('failed with token test_token') }
      });

      const result = await fetchQuotaStatus(GROUP_CONFIG);

      assert.strictEqual(result.error.includes('test_token'), false, 'トークンがマスキングされていない');
    });

    it('アクセストークンや宛先IDが無いとき、APIを叩かず success:false を返す', async () => {
      const fetchMock = createFetchMock(OK_ROUTES);
      global.fetch = fetchMock;

      const result = await fetchQuotaStatus({ LINE_CHANNEL_ACCESS_TOKEN: '', LINE_USER_ID: '' });

      assert.strictEqual(result.success, false);
      assert.strictEqual(fetchMock.calls.length, 0);
    });

    it('応答しないAPIをタイムアウトで打ち切る', async () => {
      global.fetch = async (url, init) => {
        // AbortController の signal が中断されるまで解決しない
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      };

      const result = await fetchQuotaStatus(GROUP_CONFIG, { timeoutMs: 20 });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /タイムアウト/);
    });
  });
});
