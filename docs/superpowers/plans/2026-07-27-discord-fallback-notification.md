# Discord フォールバック通知 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LINE への通知送信が失敗したときだけ Discord Webhook へ転送し、LINE の月間無料枠が尽きても通知が消滅しないようにする。

**Architecture:** Discord 送信だけを担う `src/discord.js` と、LINE→Discord のフォールバック順序・成否集約だけを担う `src/broadcast.js` を新設する。3 つのエントリポイント（夜・朝・月次）は `broadcastMessage(message, config)` だけを呼ぶ形に統一し、宛先ごとの文字数制限も `broadcast.js` が吸収する。既存の `src/notifier.js` は LINE 送信とメッセージ整形の責務のまま変更しない（`truncateToLimit` の引数追加のみ）。

**Tech Stack:** Node.js >= 24 / CommonJS / グローバル `fetch`（追加依存なし）/ Node.js built-in test runner / oxlint

## Global Constraints

- 設計仕様: `docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md`。判断に迷ったらこの spec が正
- モジュールシステムは CommonJS。`require` / `module.exports` を使う。ESM は使わない
- I/O 関数の戻り値は `{success: boolean, data?/error?}` パターンに従う。純粋関数は値を直接返す
- 追加の npm 依存を入れない。HTTP はグローバル `fetch` を使う
- Discord メッセージ上限は 2000 文字、LINE は 5000 文字
- `DISCORD_WEBHOOK_URL` は**任意**の環境変数。未設定でも全機能が従来どおり動作すること。`REQUIRED_SECRETS` には追加しない
- Webhook URL はパスワード同等。ログ・エラーメッセージには必ずマスキングして出す
- 夜通知の「全員がストリーク要件を達成した日は送信スキップ」判定（`src/index.js`）は変更しない
- テストは `node --test`。単一ファイル実行は `node --test --test-force-exit --experimental-test-isolation=none tests/<file>` （オプション 2 つは必須）
- コード内のコメント・ドキュメント・コミットメッセージは日本語で書く
- 実名は使わない。テストデータの子供の名前は「たろう」「はなこ」「じろう」等の架空名を使う

---

### Task 1: Discord Webhook 送信モジュール

**Files:**
- Create: `src/discord.js`
- Test: `tests/discord.test.js`

**Interfaces:**
- Consumes: なし（グローバル `fetch` のみ）
- Produces:
  - `sendDiscordMessage(message: string, webhookUrl: string, options?: {maxRetries?: number, retryDelay?: number, timeoutMs?: number}) → Promise<{success: boolean, error?: string}>`
  - `maskWebhookUrl(text: string, webhookUrl?: string) → string`
  - `DISCORD_MAX_MESSAGE_LENGTH: number` （値は 2000）

- [ ] **Step 1: 失敗するテストを書く**

`tests/discord.test.js` を新規作成する:

```js
/**
 * Discord通知モジュールのテスト
 * LINE送信失敗時のフォールバック先として使う Webhook 送信をテストする
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const discord = require('../src/discord');

const TEST_WEBHOOK_URL = 'https://discord.com/api/webhooks/1234567890/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

describe('Discord通知モジュール (src/discord.js)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('sendDiscordMessage()', () => {
    it('正常系: Webhookに content として POST する', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true, status: 204, statusText: 'No Content', text: async () => ''
      }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL);

      assert.strictEqual(result.success, true);
      assert.strictEqual(mockFetch.mock.calls.length, 1, 'fetchが1回呼ばれること');

      const [url, options] = mockFetch.mock.calls[0].arguments;
      assert.strictEqual(url, TEST_WEBHOOK_URL, 'Webhook URLにPOSTすること');
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers['Content-Type'], 'application/json');

      const body = JSON.parse(options.body);
      assert.strictEqual(body.content, 'テストメッセージ', 'contentフィールドで送ること');
    });

    it('異常系: Webhook URLが未設定なら送信せず失敗を返す', async () => {
      const mockFetch = mock.fn(async () => ({ ok: true, status: 204, statusText: 'No Content' }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', '');

      assert.strictEqual(result.success, false);
      assert.strictEqual(mockFetch.mock.calls.length, 0, 'fetchを呼ばないこと');
    });

    it('異常系: 4xxはリトライせず即失敗する(Webhook削除・ペイロード不正)', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false, status: 404, statusText: 'Not Found',
        text: async () => '{"message": "Unknown Webhook", "code": 10015}'
      }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 3, retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(mockFetch.mock.calls.length, 1, '4xxはリトライしないこと');
      assert.match(result.error, /404/, 'ステータスがエラー文に含まれること');
      assert.match(result.error, /Unknown Webhook/, 'レスポンスボディの理由が含まれること');
    });

    it('異常系: 5xxはリトライし、最終的に失敗を返す', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false, status: 500, statusText: 'Internal Server Error', text: async () => ''
      }));
      global.fetch = mockFetch;

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 3, retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(mockFetch.mock.calls.length, 3, '5xxは指定回数リトライすること');
    });

    it('正常系: 5xxの後に成功したら成功を返す', async () => {
      let callCount = 0;
      global.fetch = mock.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' };
        }
        return { ok: true, status: 204, statusText: 'No Content', text: async () => '' };
      });

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 3, retryDelay: 1
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(callCount, 2);
    });

    it('異常系: タイムアウトするとタイムアウト理由を返す', async () => {
      global.fetch = mock.fn(async (_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      });

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 1, retryDelay: 1, timeoutMs: 20
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /タイムアウト/);
    });

    it('セキュリティ: エラー文にWebhookトークンが含まれない', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error(`request to ${TEST_WEBHOOK_URL} failed`);
      });

      const result = await discord.sendDiscordMessage('テストメッセージ', TEST_WEBHOOK_URL, {
        maxRetries: 1, retryDelay: 1
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(
        result.error.includes('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
        false,
        'Webhookトークンが漏れないこと'
      );
      assert.match(result.error, /\*\*\*/, 'マスキングされていること');
    });
  });

  describe('maskWebhookUrl()', () => {
    it('Webhook URLのトークン部分を伏せる', () => {
      const masked = discord.maskWebhookUrl(`POST ${TEST_WEBHOOK_URL} failed`, TEST_WEBHOOK_URL);

      assert.match(masked, /webhooks\/1234567890\/\*\*\*/, 'ID は残しトークンだけ伏せること');
      assert.strictEqual(masked.includes('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'), false);
    });

    it('第2引数なしでもURLパターンからトークンを伏せる', () => {
      const masked = discord.maskWebhookUrl(`POST ${TEST_WEBHOOK_URL} failed`);

      assert.strictEqual(masked.includes('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'), false);
    });

    it('URLを含まない文字列はそのまま返す', () => {
      assert.strictEqual(discord.maskWebhookUrl('ネットワークエラー'), 'ネットワークエラー');
    });
  });

  describe('エクスポート', () => {
    it('必要な関数と定数をエクスポートしている', () => {
      assert.strictEqual(typeof discord.sendDiscordMessage, 'function');
      assert.strictEqual(typeof discord.maskWebhookUrl, 'function');
      assert.strictEqual(discord.DISCORD_MAX_MESSAGE_LENGTH, 2000);
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/discord.test.js`
Expected: FAIL。`Cannot find module '../src/discord'` で全ケースが落ちる

- [ ] **Step 3: `src/discord.js` を実装する**

```js
/**
 * Discord通知モジュール - Webhook送信
 *
 * LINE送信が失敗したときのフォールバック先。
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 */

// Discordメッセージの最大長（Discord APIの制限。LINEの5000より短い）
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// Webhook URL のトークン部分（末尾セグメント）を検出する
const WEBHOOK_URL_PATTERN = /(https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+)\/[\w-]+/g;

/**
 * Webhook URL のトークン部分をマスキングする
 *
 * Webhook URL は実質的なパスワードで、漏れると誰でもそのチャンネルに投稿できる。
 * ログ・エラーメッセージに出す前に必ず通すこと。
 *
 * @param {string} text - マスキング対象の文字列
 * @param {string} [webhookUrl] - 既知のWebhook URL（パターンに合わない形式への保険）
 * @returns {string} マスキング済み文字列
 */
function maskWebhookUrl(text, webhookUrl) {
  if (typeof text !== 'string') {
    return text;
  }

  let masked = text.replace(WEBHOOK_URL_PATTERN, '$1/***');

  // パターンに合わないホストで運用された場合に備え、既知のトークン文字列も直接置換する
  if (webhookUrl) {
    const token = webhookUrl.split('/').pop();
    if (token && token.length >= 8 && masked.includes(token)) {
      masked = masked.split(token).join('***');
    }
  }

  return masked;
}

/**
 * Discord Webhook にメッセージを送信する
 *
 * @param {string} message - 送信するメッセージ（2000文字以内に切り詰め済みであること）
 * @param {string} webhookUrl - Discord Webhook URL
 * @param {object} [options] - オプション設定
 * @param {number} [options.maxRetries=3] - 最大リトライ回数
 * @param {number} [options.retryDelay=1000] - リトライ間隔（ms、指数バックオフ）
 * @param {number} [options.timeoutMs=10000] - 1試行あたりのHTTPタイムアウト（ms）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendDiscordMessage(message, webhookUrl, options = {}) {
  const { maxRetries = 3, retryDelay = 1000, timeoutMs = 10000 } = options;

  if (!webhookUrl) {
    return { success: false, error: 'Discord Webhook URLが設定されていません' };
  }

  if (!message) {
    return { success: false, error: '送信するメッセージが空です' };
  }

  const requestBody = { content: message };
  let lastError = 'Discord送信に失敗しました';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await attemptSendDiscord(requestBody, webhookUrl, timeoutMs);

    if (result.success) {
      return { success: true };
    }

    lastError = result.error;

    // 4xx はリトライしても解決しない（404=Webhook削除, 400=ペイロード不正, 401=認証）
    if (!result.retryable) {
      return { success: false, error: lastError };
    }

    if (attempt < maxRetries) {
      const delay = retryDelay * Math.pow(2, attempt - 1); // 指数バックオフ
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: `${lastError}（${maxRetries}回試行）` };
}

/**
 * 1回の送信試行
 * @private
 * @returns {Promise<{success: boolean, error?: string, retryable?: boolean}>}
 */
async function attemptSendDiscord(requestBody, webhookUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      // Discordはエラー理由をボディで返す（例: {"message": "Unknown Webhook"}）。
      // 原因調査に必須のためエラーメッセージに含める。取得失敗時はstatusのみで続行
      let detail = '';
      try {
        if (typeof response.text === 'function') {
          const body = (await response.text()).trim();
          if (body) {
            detail = ` - ${body}`;
          }
        }
      } catch {
        // ボディ取得失敗は無視（statusだけでも報告する）
      }

      return {
        success: false,
        retryable: response.status >= 500,
        error: maskWebhookUrl(
          `Discord API エラー: ${response.status} ${response.statusText}${detail}`,
          webhookUrl
        )
      };
    }

    return { success: true };

  } catch (error) {
    const masked = maskWebhookUrl(error.message, webhookUrl);

    if (error.name === 'AbortError' || masked.includes('abort')) {
      return {
        success: false,
        retryable: true,
        error: `タイムアウト: Discord Webhookが${timeoutMs}ms以内に応答しませんでした`
      };
    }

    return { success: false, retryable: true, error: `Discord送信エラー: ${masked}` };

  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sendDiscordMessage,
  maskWebhookUrl,
  DISCORD_MAX_MESSAGE_LENGTH
};
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/discord.test.js`
Expected: PASS（全ケース）

- [ ] **Step 5: lint を通す**

Run: `npm run lint`
Expected: エラー・警告なし

- [ ] **Step 6: コミットする**

```bash
git add src/discord.js tests/discord.test.js
git commit -m "feat: Discord Webhook 送信モジュールを追加

LINE送信失敗時のフォールバック先として使う。4xxは非リトライ、
5xx・ネットワーク・タイムアウトはリトライする。Webhook URLの
トークン部分はログ・エラー文から必ずマスキングする。"
```

---

### Task 2: 設定への `DISCORD_WEBHOOK_URL` 追加

**Files:**
- Modify: `src/config.js`
- Test: `tests/config.test.js`（追記）

**Interfaces:**
- Consumes: なし
- Produces: `loadConfig()` の戻り値に `DISCORD_WEBHOOK_URL: string | undefined` が追加される。未設定・空文字のときは `undefined`

- [ ] **Step 1: 失敗するテストを書く**

`tests/config.test.js` の `describe('loadConfig', ...)` ブロックの末尾に以下を追加する:

```js
    it('DISCORD_WEBHOOK_URLが設定されていれば設定オブジェクトに含める', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';

      const config = loadConfig();

      assert.strictEqual(config.DISCORD_WEBHOOK_URL, 'https://discord.com/api/webhooks/123/abc');
    });

    it('DISCORD_WEBHOOK_URLは任意: 未設定でもエラーにならずundefinedになる', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      delete process.env.DISCORD_WEBHOOK_URL;

      const config = loadConfig();

      assert.strictEqual(config.DISCORD_WEBHOOK_URL, undefined);
    });

    it('DISCORD_WEBHOOK_URLが空文字なら未設定扱い(undefined)にする', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.DISCORD_WEBHOOK_URL = '   ';

      const config = loadConfig();

      assert.strictEqual(config.DISCORD_WEBHOOK_URL, undefined);
    });
```

さらに `describe('maskSensitiveData', ...)` ブロックの末尾に以下を追加する（ブロック名は既存ファイルの記述に合わせること）:

```js
    it('webhookを含むフィールドをマスキングする', () => {
      const masked = maskSensitiveData({
        userName: 'たろう',
        discordWebhookUrl: 'https://discord.com/api/webhooks/123/secret'
      });

      assert.strictEqual(masked.discordWebhookUrl, '***');
      assert.strictEqual(masked.userName, 'たろう');
    });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/config.test.js`
Expected: FAIL。`DISCORD_WEBHOOK_URL` が `undefined` になる（1件目）、`discordWebhookUrl` がマスキングされない

- [ ] **Step 3: `src/config.js` を修正する**

`SENSITIVE_FIELDS` に `'webhook'` を追加する:

```js
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'channelAccessToken',
  'accessToken',
  'secret',
  'key',
  'webhook'
];
```

`loadConfig()` のデバッグログに 1 行追加する（既存の 4 行の直後）:

```js
    console.log(`  DISCORD_WEBHOOK_URL: ${process.env.DISCORD_WEBHOOK_URL ? '存在 (任意)' : '未設定 (任意: LINE失敗時のフォールバックが無効)'}`);
```

`secrets` オブジェクトの直後に任意設定を読み込み、戻り値に含める:

```js
  const validation = validateSecrets(secrets);

  if (!validation.valid) {
    throw new Error(
      `必須環境変数が設定されていません: ${validation.missing.join(', ')}`
    );
  }

  // 任意設定: 未設定ならLINE失敗時のDiscordフォールバックが無効になるだけで、
  // 通知そのものは従来どおり動く。そのためREQUIRED_SECRETSには含めない
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();

  return {
    SMILEZEMI_USERNAME: secrets.SMILEZEMI_USERNAME,
    SMILEZEMI_PASSWORD: secrets.SMILEZEMI_PASSWORD,
    LINE_CHANNEL_ACCESS_TOKEN: secrets.LINE_CHANNEL_ACCESS_TOKEN,
    LINE_USER_ID: secrets.LINE_USER_ID,
    DISCORD_WEBHOOK_URL: discordWebhookUrl || undefined
  };
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/config.test.js`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/config.js tests/config.test.js
git commit -m "feat: DISCORD_WEBHOOK_URL を任意設定として読み込む

未設定でも従来どおり動作させるため REQUIRED_SECRETS には含めない。
maskSensitiveData のマスキング対象に webhook を追加した。"
```

---

### Task 3: フォールバック層（`broadcast.js`）

**Files:**
- Create: `src/broadcast.js`
- Modify: `src/notifier.js`（`truncateToLimit` に第 2 引数を追加）
- Test: `tests/broadcast.test.js`
- Test: `tests/notifier.test.js`（`truncateToLimit` のテストを追記）

**Interfaces:**
- Consumes:
  - `sendPushMessage(message, accessToken, userId, options)` （`src/notifier.js` 既存）
  - `truncateToLimit(message, maxLength)` （本タスクで第 2 引数を追加）
  - `sendDiscordMessage(message, webhookUrl, options)`、`DISCORD_MAX_MESSAGE_LENGTH` （Task 1）
- Produces:
  - `broadcastMessage(message: string, config: {LINE_CHANNEL_ACCESS_TOKEN: string, LINE_USER_ID: string, DISCORD_WEBHOOK_URL?: string}, options?: object) → Promise<{success: boolean, results: Array<{channel: 'line'|'discord', success: boolean, error?: string}>}>`
  - `formatFallbackMessage(message: string, lineError: string) → string`
  - `truncateToLimit(message, maxLength = 5000)` （`src/notifier.js`）

- [ ] **Step 1: `truncateToLimit` の失敗するテストを書く**

`tests/notifier.test.js` の一番外側の `describe('通知モジュール (src/notifier.js)', ...)` の中に、新しい describe ブロックとして追加する:

```js
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
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: FAIL。「上限を明示すれば〜」のケースが失敗する（現状は第 2 引数を無視して 5000 固定のため 3000 文字がそのまま返る）

- [ ] **Step 3: `src/notifier.js` の `truncateToLimit` を修正する**

既存の実装を以下に置き換える:

```js
/**
 * メッセージを指定文字数以内に切り詰める
 *
 * 上限は宛先ごとに異なる（LINE=5000, Discord=2000）ため引数で受け取る。
 * Requirements: 4.5
 *
 * @param {string} message - メッセージ文字列
 * @param {number} [maxLength=5000] - 上限文字数
 * @returns {string} - 切り詰められたメッセージ
 */
function truncateToLimit(message, maxLength = MAX_MESSAGE_LENGTH) {
  if (message.length <= maxLength) {
    return message;
  }

  const suffix = '\n\n...（メッセージが長すぎるため省略）';
  return message.substring(0, maxLength - suffix.length) + suffix;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/notifier.test.js`
Expected: PASS

- [ ] **Step 5: `broadcast.js` の失敗するテストを書く**

`tests/broadcast.test.js` を新規作成する。`src/notifier` と `src/discord` は require.cache 注入でモックする:

```js
/**
 * 送信フォールバック層のテスト
 * LINE送信が失敗したときだけDiscordへ転送する順序と成否集約を検証する
 *
 * require.cache 直接注入で notifier / discord をモックする
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

const MODULE_PATHS = ['../src/notifier', '../src/discord', '../src/broadcast'];

function resolveModule(p) {
  return require.resolve(p);
}

function clearModuleCache() {
  for (const p of MODULE_PATHS) {
    delete require.cache[resolveModule(p)];
  }
}

describe('送信フォールバック層 (src/broadcast.js)', () => {
  let broadcast;
  let callLog;

  const defaultConfig = {
    LINE_CHANNEL_ACCESS_TOKEN: 'test_token',
    LINE_USER_ID: 'U0000000000',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc'
  };

  function setupMocks(overrides = {}) {
    callLog = [];
    clearModuleCache();

    require.cache[resolveModule('../src/notifier')] = {
      id: resolveModule('../src/notifier'), filename: resolveModule('../src/notifier'), loaded: true,
      exports: {
        sendPushMessage: overrides.sendPushMessage || (async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: true };
        }),
        // 切り詰めは本物と同じ挙動を使いたいので簡易実装で代替する
        truncateToLimit: (message, maxLength = 5000) =>
          message.length <= maxLength ? message : message.substring(0, maxLength)
      }
    };

    require.cache[resolveModule('../src/discord')] = {
      id: resolveModule('../src/discord'), filename: resolveModule('../src/discord'), loaded: true,
      exports: {
        sendDiscordMessage: overrides.sendDiscordMessage || (async (...args) => {
          callLog.push({ type: 'discord', args });
          return { success: true };
        }),
        DISCORD_MAX_MESSAGE_LENGTH: 2000
      }
    };

    broadcast = require('../src/broadcast');
  }

  beforeEach(() => {
    setupMocks();
  });

  afterEach(() => {
    clearModuleCache();
  });

  after(() => {
    clearModuleCache();
  });

  describe('broadcastMessage()', () => {
    it('正常系: LINEが成功したらDiscordは呼ばない', async () => {
      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, true);
      assert.strictEqual(callLog.filter(c => c.type === 'line').length, 1);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0, 'Discordを呼ばないこと');
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].channel, 'line');
    });

    it('正常系: LINEにはトークン・ユーザーIDを渡して送る', async () => {
      await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      const [message, token, userId] = callLog.find(c => c.type === 'line').args;
      assert.strictEqual(message, '本文メッセージ');
      assert.strictEqual(token, 'test_token');
      assert.strictEqual(userId, 'U0000000000');
    });

    it('正常系: LINE失敗時はDiscordへ転送し、届いたので成功扱いにする', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: false, error: 'LINE API エラー: 429 Too Many Requests - monthly limit' };
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, '1つ以上届けば成功扱い');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1, 'Discordへ転送すること');
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[0].channel, 'line');
      assert.strictEqual(result.results[0].success, false);
      assert.strictEqual(result.results[1].channel, 'discord');
      assert.strictEqual(result.results[1].success, true);
    });

    it('正常系: 転送メッセージの先頭にLINE失敗の理由行が付く', async () => {
      setupMocks({
        sendPushMessage: async () => ({
          success: false,
          error: 'LINE API エラー: 429 Too Many Requests - monthly limit'
        })
      });

      await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      const [sentMessage, webhookUrl] = callLog.find(c => c.type === 'discord').args;
      assert.match(sentMessage, /^⚠️ LINEへの送信に失敗したためDiscordに転送しました/, '転送である旨が先頭に付くこと');
      assert.match(sentMessage, /理由: LINE API エラー: 429/, '失敗理由が含まれること');
      assert.match(sentMessage, /本文メッセージ/, '本文が保持されること');
      assert.strictEqual(webhookUrl, 'https://discord.com/api/webhooks/123/abc');
    });

    it('正常系: Discordへは2000文字に切り詰めて渡す', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' })
      });

      await broadcast.broadcastMessage('あ'.repeat(5000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.length <= 2000, true, 'Discordの上限に収めること');
    });

    it('正常系: LINEへは5000文字に切り詰めて渡す', async () => {
      await broadcast.broadcastMessage('あ'.repeat(9000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'line').args;
      assert.strictEqual(sentMessage.length <= 5000, true, 'LINEの上限に収めること');
    });

    it('異常系: 両方失敗したら失敗を返す', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' }),
        sendDiscordMessage: async () => ({ success: false, error: 'Discord API エラー: 404' })
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', defaultConfig);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[1].error, 'Discord API エラー: 404');
    });

    it('異常系: Webhook未設定でLINEが失敗したら転送せず失敗を返す', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: false, error: 'LINE API エラー: 429' };
        }
      });

      const result = await broadcast.broadcastMessage('本文メッセージ', {
        ...defaultConfig,
        DISCORD_WEBHOOK_URL: undefined
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0, 'Discordを呼ばないこと');
      assert.strictEqual(result.results.length, 1, 'LINEの結果だけが残ること');
    });
  });

  describe('formatFallbackMessage()', () => {
    it('理由行と本文を空行で区切って返す', () => {
      const result = broadcast.formatFallbackMessage('本文', 'LINE API エラー: 429');

      assert.strictEqual(
        result,
        '⚠️ LINEへの送信に失敗したためDiscordに転送しました\n理由: LINE API エラー: 429\n\n本文'
      );
    });
  });
});
```

- [ ] **Step 6: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js`
Expected: FAIL。`Cannot find module '../src/broadcast'`

- [ ] **Step 7: `src/broadcast.js` を実装する**

```js
/**
 * 送信フォールバック層
 *
 * 1本のメッセージをどの宛先へどの順序で送るかだけを担う。
 * LINEに送り、成功したら終了。失敗したときだけDiscordへ転送する。
 *
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 */

const { sendPushMessage, truncateToLimit } = require('./notifier');
const { sendDiscordMessage, DISCORD_MAX_MESSAGE_LENGTH } = require('./discord');

// LINEメッセージの最大長（LINE APIの制限）
const LINE_MAX_MESSAGE_LENGTH = 5000;

/**
 * Discord転送用にフォールバックの理由行を先頭に付ける
 *
 * 受信者が「LINEの月間枠切れ」なのか「障害」なのかを判別できるように理由を載せる。
 * lineError は notifier 側でトークンがマスキング済みの文字列であること。
 *
 * @param {string} message - 本文
 * @param {string} lineError - LINE送信のエラー文字列
 * @returns {string}
 */
function formatFallbackMessage(message, lineError) {
  return [
    '⚠️ LINEへの送信に失敗したためDiscordに転送しました',
    `理由: ${lineError}`,
    '',
    message
  ].join('\n');
}

/**
 * メッセージをLINEへ送り、失敗した場合のみDiscordへ転送する
 *
 * success は「1つ以上の宛先に届いたか」を表す。LINEの月間枠が尽きている間ずっと
 * ワークフローが赤くなり毎日失敗通知が届く状態を避けるため、この定義にしている。
 *
 * @param {string} message - 送信するメッセージ（切り詰めは本関数が宛先ごとに行う）
 * @param {{LINE_CHANNEL_ACCESS_TOKEN: string, LINE_USER_ID: string, DISCORD_WEBHOOK_URL?: string}} config
 * @param {object} [options] - 送信オプション（maxRetries / retryDelay / timeoutMs）。両宛先に渡る
 * @returns {Promise<{success: boolean, results: Array<{channel: string, success: boolean, error?: string}>}>}
 */
async function broadcastMessage(message, config, options = {}) {
  const results = [];

  const lineResult = await sendPushMessage(
    truncateToLimit(message, LINE_MAX_MESSAGE_LENGTH),
    config.LINE_CHANNEL_ACCESS_TOKEN,
    config.LINE_USER_ID,
    options
  );
  results.push({ channel: 'line', success: lineResult.success, error: lineResult.error });

  if (lineResult.success) {
    return { success: true, results };
  }

  console.error('❌ LINEへの送信に失敗しました:', lineResult.error);

  if (!config.DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、Discordへのフォールバックをスキップします');
    return { success: false, results };
  }

  console.log('📤 Discordへフォールバック送信しています...');
  const fallbackMessage = truncateToLimit(
    formatFallbackMessage(message, lineResult.error),
    DISCORD_MAX_MESSAGE_LENGTH
  );
  const discordResult = await sendDiscordMessage(
    fallbackMessage,
    config.DISCORD_WEBHOOK_URL,
    options
  );
  results.push({ channel: 'discord', success: discordResult.success, error: discordResult.error });

  if (discordResult.success) {
    console.warn('⚠️ LINEには届きませんでしたが、Discordへの転送に成功しました');
  } else {
    console.error('❌ Discordへの転送にも失敗しました:', discordResult.error);
  }

  return { success: discordResult.success, results };
}

module.exports = {
  broadcastMessage,
  formatFallbackMessage,
  LINE_MAX_MESSAGE_LENGTH
};
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js`
Expected: PASS（全ケース）

- [ ] **Step 9: 全テストと lint を通す**

Run: `npm test && npm run lint`
Expected: すべて PASS、lint エラーなし

- [ ] **Step 10: コミットする**

```bash
git add src/broadcast.js src/notifier.js tests/broadcast.test.js tests/notifier.test.js
git commit -m "feat: LINE失敗時にDiscordへ転送するフォールバック層を追加

broadcastMessage は LINE に送り、失敗したときだけ理由行を付けて
Discord へ転送する。success は「1つ以上の宛先に届いたか」を表す。
宛先別の切り詰めのため truncateToLimit に上限引数を追加した。"
```

---

### Task 4: エントリポイント 3 つをフォールバック層経由に切り替え

**Files:**
- Modify: `src/index.js`
- Modify: `src/morning-index.js`
- Modify: `src/monthly-bonus-index.js`
- Test: `tests/index.test.js`
- Test: `tests/monthly-bonus-index.test.js`

**Interfaces:**
- Consumes: `broadcastMessage(message, config)` （Task 3）、`formatMessage(changes)` / `formatDetailedMessage(userData, missionChanges, options)` （`src/notifier.js` 既存）
- Produces: なし（エントリポイントの内部変更）

**注意:** `src/notifier.js` の `sendNotification()` はエントリポイントから使われなくなるが、LINE 単体送信の公開 API として残す（削除すると既存テスト約 200 行の書き換えが必要になり、本タスクの差分が焦点を失うため）。

- [ ] **Step 1: `tests/index.test.js` を broadcast モックに書き換える**

`MODULE_PATHS` に `'../src/broadcast'` を追加する:

```js
const MODULE_PATHS = [
  '../src/index', '../src/config', '../src/auth',
  '../src/crawler', '../src/data', '../src/notifier', '../src/broadcast', '../src/streak', 'playwright'
];
```

`setupMocks()` 内の notifier モックを以下に差し替える（`sendNotification` と `sendPushMessage` を除き、`formatMessage` を追加）:

```js
    require.cache[resolveModule('../src/notifier')] = {
      id: resolveModule('../src/notifier'), filename: resolveModule('../src/notifier'), loaded: true,
      exports: {
        formatMessage: overrides.formatMessage || ((changes) => `テスト基本メッセージ(${changes.length}件)`),
        formatDetailedMessage: overrides.formatDetailedMessage || (() => 'テスト詳細メッセージ')
      }
    };

    require.cache[resolveModule('../src/broadcast')] = {
      id: resolveModule('../src/broadcast'), filename: resolveModule('../src/broadcast'), loaded: true,
      exports: {
        broadcastMessage: overrides.broadcastMessage || (async (...args) => {
          callLog.push({ type: 'broadcastMessage', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        })
      }
    };
```

既存アサーションを次の方針で置き換える（対象は現行 193〜197 / 256 / 280〜284 / 293 / 305 / 359〜360 / 382 / 398 / 427〜428 / 512 行あたり）:

- `callLog.filter(c => c.type === 'sendPushMessage')` → `callLog.filter(c => c.type === 'broadcastMessage')`
- `overrides.sendPushMessage` → `overrides.broadcastMessage`、返り値は `{ success: false, results: [...] }` 形式にする
- テスト名の「sendPushMessage」表記も「broadcastMessage」に直す

`sendNotification` を参照している 2 つのテスト（現行 256 行付近・280 行付近）は、基本モードも broadcast 経由になるため次のように書き換える:

```js
    it('正常系: 基本モードにフォールバックした場合も通知はbroadcast経由で送られる', async () => {
      setupMocks({
        crawlDetailedResult: { success: false, error: '詳細取得エラー' }
      });

      await mainModule.main();

      const calls = callLog.filter(c => c.type === 'broadcastMessage');
      assert.strictEqual(calls.length, 1, '基本モードでも1回だけ通知すること');
      assert.match(calls[0].args[0], /テスト基本メッセージ/, 'formatMessageの結果が送られること');
    });

    it('異常系: 詳細も基本も失敗したら「変更なし」ではなく障害通知を送る', async () => {
      setupMocks({
        crawlDetailedResult: { success: false, error: '詳細取得エラー' },
        crawlBasicResult: { success: false, error: '基本取得エラー' }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      const calls = callLog.filter(c => c.type === 'broadcastMessage');
      assert.strictEqual(calls.length, 1, '障害通知が送られること');
      assert.match(calls[0].args[0], /⚠️/, '障害メッセージであること');
    });
```

`crawlDetailedResult` / `crawlBasicResult` は既存 `setupMocks()`（現行 58 行・64 行）が受け取る override キーで、それぞれ `getAllUsersDetailedData` / `getAllUsersMissionCounts` の返り値になる。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`
Expected: FAIL。`src/index.js` がまだ `sendPushMessage` / `sendNotification` を呼ぶため `broadcastMessage` の呼び出しが 0 件になる

- [ ] **Step 3: `src/index.js` を修正する**

require 行を差し替える:

```js
const { formatMessage, formatDetailedMessage } = require('./notifier');
const { broadcastMessage } = require('./broadcast');
```

障害通知（現行の基本クロールも失敗したケース）を差し替える。`broadcastMessage()` の戻り値に `error` フィールドはない（宛先ごとの理由は `results` に入り、broadcast 内で既にログ出力済み）ため、ここでは成否だけを見る:

```js
          const errorNotifyResult = await broadcastMessage(errorMessage, config);
          if (!errorNotifyResult.success) {
            console.error('❌ エラー通知の送信に全宛先で失敗しました');
          }
```

基本モードの通知を差し替える（`sendNotification` → `formatMessage` + `broadcastMessage`）:

```js
      const notifyResult = await broadcastMessage(
        formatMessage(compareResult.changes),
        config
      );

      if (notifyResult.success) {
        console.log('✅ 基本モードでの通知が完了しました');
      } else {
        console.error('❌ 基本モードでの通知に失敗しました');
        errors.push('基本モードの通知が全宛先で失敗しました');
      }
```

詳細モードの通知を差し替える。`message = truncateToLimit(message)` の行は削除する（切り詰めは broadcast が宛先ごとに行う）:

```js
    // 通知送信（宛先の切り替え・リトライ・タイムアウト・マスキングはbroadcastMessageに委譲）
    const notifyResult = await broadcastMessage(message, config);

    if (notifyResult.success) {
      console.log('✅ 通知の送信が完了しました');
    } else {
      console.error('❌ 通知の送信に全宛先で失敗しました');
      errors.push('通知が全宛先で失敗しました');
    }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`
Expected: PASS

- [ ] **Step 5: `src/morning-index.js` を修正する**

require 行を差し替える:

```js
const { formatDetailedMessage } = require('./notifier');
const { broadcastMessage } = require('./broadcast');
```

クロール失敗時の障害通知を差し替える:

```js
        const errorNotifyResult = await broadcastMessage(errorMessage, config);
        if (!errorNotifyResult.success) {
          console.error('❌ エラー通知の送信に全宛先で失敗しました');
        }
```

`message = truncateToLimit(message);` の行を削除し、送信部を差し替える:

```js
    console.log('📤 通知を送信しています...');
    const notifyResult = await broadcastMessage(message, config);

    if (notifyResult.success) {
      console.log('✅ 朝通知の送信が完了しました');
    } else {
      console.error('❌ 朝通知の送信に全宛先で失敗しました');
      errors.push('朝通知が全宛先で失敗しました');
    }
```

- [ ] **Step 6: 朝通知のテストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/morning-index.test.js`
Expected: PASS（エクスポート確認のみの軽量テスト。モジュールが読み込めれば通る）

- [ ] **Step 7: `tests/monthly-bonus-index.test.js` を broadcast モックに書き換える**

`MODULE_PATHS` を差し替える:

```js
const MODULE_PATHS = ['../src/config', '../src/broadcast', '../src/streak'];
```

`setupMocks()` の config モックに `DISCORD_WEBHOOK_URL` を足し、notifier モックを broadcast モックに差し替える:

```js
    require.cache[resolveModule('../src/config')] = {
      id: resolveModule('../src/config'), filename: resolveModule('../src/config'), loaded: true,
      exports: {
        loadConfig: overrides.loadConfig || (() => ({
          SMILEZEMI_USERNAME: 'test@example.com',
          SMILEZEMI_PASSWORD: 'password123',
          LINE_CHANNEL_ACCESS_TOKEN: 'test_token',
          LINE_USER_ID: 'test_user',
          DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc'
        }))
      }
    };

    require.cache[resolveModule('../src/broadcast')] = {
      id: resolveModule('../src/broadcast'), filename: resolveModule('../src/broadcast'), loaded: true,
      exports: {
        broadcastMessage: overrides.broadcastMessage || (async (...args) => {
          callLog.push({ type: 'broadcastMessage', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        })
      }
    };
```

既存テストの `sendPushMessage` を `broadcastMessage` に置き換える。引数の検証は `(message, config)` の 2 引数になるため、トークン検証の 2 行を config 検証に変える:

```js
      const [message, passedConfig] = pushCalls[0].args;
      assert.strictEqual(passedConfig.LINE_CHANNEL_ACCESS_TOKEN, 'test_token');
      assert.strictEqual(passedConfig.LINE_USER_ID, 'test_user');
```

「異常系: 送信失敗時はリセット保存せず終了コード1」の override を差し替える:

```js
      setupMocks({
        broadcastMessage: async () => ({
          success: false,
          results: [
            { channel: 'line', success: false, error: 'LINE API エラー: 429' },
            { channel: 'discord', success: false, error: 'Discord API エラー: 404' }
          ]
        })
      });
```

さらに新しいテストを `describe('main() - 清算フロー', ...)` の末尾に追加する:

```js
    it('正常系: Discordにだけ届いた場合もボーナスをリセットする(二重支給を防ぐ)', async () => {
      setupMocks({
        broadcastMessage: async (...args) => {
          callLog.push({ type: 'broadcastMessage', args });
          return {
            success: true,
            results: [
              { channel: 'line', success: false, error: 'LINE API エラー: 429' },
              { channel: 'discord', success: true }
            ]
          };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 0);
      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 1, 'Discordに届いていればリセットすること');
      assert.strictEqual(saveCalls[0].users['じろう (小学生コース)'].bonus, 0);
    });
```

- [ ] **Step 8: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: FAIL。`src/monthly-bonus-index.js` がまだ `sendPushMessage` を呼ぶため `broadcastMessage` の呼び出しが 0 件になる

- [ ] **Step 9: `src/monthly-bonus-index.js` を修正する**

require 行を差し替える:

```js
const { broadcastMessage } = require('./broadcast');
```

ストリークデータ読み込み失敗時の障害通知を差し替える:

```js
      const errorNotifyResult = await broadcastMessage(errorMessage, config);
      if (!errorNotifyResult.success) {
        console.error('❌ エラー通知の送信に全宛先で失敗しました');
      }
```

清算通知の送信部を差し替える。`success` は「1つ以上の宛先に届いた」を意味するので、リセット判定はこの値をそのまま使う:

```js
  // 5. 通知送信（LINE→失敗時のみDiscordへ転送）
  console.log('📤 通知を送信しています...');
  const notifyResult = await broadcastMessage(message, config);

  if (!notifyResult.success) {
    // 全宛先で失敗したときはリセットせず持ち越す(次回実行で再清算できる)
    console.error('❌ 通知の送信に全宛先で失敗しました');
    return { success: false, exitCode: 1, error: '清算通知が全宛先で失敗しました' };
  }

  // どこか1つでも届いていればリセットする。届いているのに持ち越すと、
  // 次回実行で同じ月の清算が再送・再支給されてしまうため
  console.log('✅ 月次ボーナス清算の通知が完了しました');
```

- [ ] **Step 10: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: PASS

- [ ] **Step 11: 全テストと lint を通す**

Run: `npm test && npm run lint`
Expected: すべて PASS、lint エラーなし

- [ ] **Step 12: DRY_RUN でクラッシュしないことを確認する**

Run: `DRY_RUN=true node -r dotenv/config src/monthly-bonus-index.js`
Expected: 清算プレビューが表示され、「ドライランモード」のログで正常終了（exit 0）。送信は行われない

- [ ] **Step 13: コミットする**

```bash
git add src/index.js src/morning-index.js src/monthly-bonus-index.js tests/index.test.js tests/monthly-bonus-index.test.js
git commit -m "feat: 3つのエントリポイントの通知をフォールバック層経由にする

通常通知・障害通知とも broadcastMessage 経由になり、LINEが失敗した
ときだけDiscordへ転送される。月次ボーナスのリセット条件は「1つ以上の
宛先に届いたら」に変更した(届いているのに持ち越すと二重支給になるため)。"
```

---

### Task 5: 設定ファイル・ワークフロー・ドキュメント

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `scripts/validate-env.js`
- Modify: `.github/workflows/crawler.yml`
- Modify: `.github/workflows/morning-crawler.yml`
- Modify: `.github/workflows/monthly-bonus.yml`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/GITHUB_ACTIONS_SETUP.md`

**Interfaces:**
- Consumes: 環境変数 `DISCORD_WEBHOOK_URL`
- Produces: なし

- [ ] **Step 1: `.env.example` に追記する**

LINE の認証情報ブロックの直後に追加する:

```bash
# Discord Webhook（任意: LINE送信が失敗したときのフォールバック先）
# 未設定でも動作する。その場合LINE失敗時に通知は届かない
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxx/yyyyy
```

- [ ] **Step 2: `docker-compose.yml` の environment に追記する**

`- LINE_USER_ID` の次の行に追加する:

```yaml
      - DISCORD_WEBHOOK_URL
```

- [ ] **Step 3: `scripts/validate-env.js` に任意変数のチェックを追加する**

`REQUIRED_ENV_VARS` の定義の直後に追加する:

```js
// 任意環境変数のリスト（未設定でもエラーにしない）
const OPTIONAL_ENV_VARS = [
  {
    name: 'DISCORD_WEBHOOK_URL',
    note: 'LINE送信失敗時のフォールバック先。未設定だとLINE失敗時に通知が届かない'
  }
];
```

必須変数のチェックループの直後（`console.log` で結果をまとめる前）に追加する:

```js
  console.log('\n📋 任意環境変数のチェック:\n');

  OPTIONAL_ENV_VARS.forEach(({ name, note }) => {
    if (process.env[name]) {
      console.log(`✅ ${name}: 設定済み`);
    } else {
      console.log(`ℹ️  ${name}: 未設定（${note}）`);
      warnings.push(`${name}が未設定です`);
    }
  });
```

（`hasError` には影響させない。任意項目なので検証は失敗させない）

- [ ] **Step 4: ワークフロー 3 本の .env 生成に追記する**

`.github/workflows/crawler.yml`、`morning-crawler.yml`、`monthly-bonus.yml` の「.envファイルを作成」ステップに、それぞれ 1 行追加する:

```yaml
          echo "DISCORD_WEBHOOK_URL=${{ secrets.DISCORD_WEBHOOK_URL }}" >> .env
```

Secret が未設定なら空文字が書かれ、`loadConfig()` が `undefined` として扱うため問題ない。**「環境変数を検証」ステップの必須 Secrets チェックには追加しない。**

- [ ] **Step 5: ワークフロー 3 本の失敗通知ステップに Discord フォールバックを追加する**

3 本とも「失敗をLINEに通知」ステップを以下に置き換える（ステップ名も変更する）:

```yaml
      - name: 失敗を通知（LINE→失敗時のみDiscord）
        if: failure()
        env:
          WORKFLOW_NAME: ${{ github.workflow }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          LINE_TOKEN: ${{ secrets.LINE_CHANNEL_ACCESS_TOKEN }}
          LINE_USER: ${{ secrets.LINE_USER_ID }}
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
        run: |
          message=$(printf '⚠️ GitHub Actions ワークフローが失敗しました\n\nワークフロー: %s\n実行ログ: %s' "$WORKFLOW_NAME" "$RUN_URL")
          payload=$(jq -n --arg to "$LINE_USER" --arg text "$message" '{to: $to, messages: [{type: "text", text: $text}]}')

          if curl -sS --fail-with-body -X POST https://api.line.me/v2/bot/message/push \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $LINE_TOKEN" \
            -d "$payload"; then
            exit 0
          fi

          echo "::warning::LINEへの失敗通知に失敗しました"

          if [ -z "$DISCORD_WEBHOOK_URL" ]; then
            echo "::warning::DISCORD_WEBHOOK_URL が未設定のためDiscordへの転送をスキップします"
            exit 0
          fi

          discord_message=$(printf '⚠️ LINEへの送信に失敗したためDiscordに転送しました\n\n%s' "$message")
          discord_payload=$(jq -n --arg content "$discord_message" '{content: $content}')
          curl -sS --fail-with-body -X POST "$DISCORD_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "$discord_payload" || echo "::warning::Discordへの失敗通知の送信にも失敗しました"
```

この通知自体の失敗でジョブを落とさない方針は維持する（最後に `|| echo` で握りつぶす、途中は `exit 0` で正常終了する）。

- [ ] **Step 6: `CLAUDE.md` を更新する**

以下の 3 箇所を更新する:

1. `## Project Structure` の `src/` ツリーに 2 行追加する:

```text
├── notifier.js               # LINE通知 (sendNotification, formatDetailedMessage, truncateToLimit)
├── discord.js                # Discord Webhook通知 (sendDiscordMessage, maskWebhookUrl)
└── broadcast.js              # 送信フォールバック層 (broadcastMessage: LINE→失敗時のみDiscord)
```

2. `## Environment Variables` の変数一覧の下に追加する:

```markdown
任意: `DISCORD_WEBHOOK_URL`（LINE送信失敗時のフォールバック先。未設定ならフォールバックせず従来どおりLINEのみ）
```

3. `### LINE送信数の制約（重要）` の末尾に追加する:

```markdown
- LINE送信が失敗した場合（429の枠切れ・401・ネットワーク障害すべて）は `src/broadcast.js` が Discord Webhook へ転送する。転送メッセージには失敗理由の行が付く。Discordには月間送信数の上限がない
- Discordはフォールバック専用で、LINEが成功している限り一度も呼ばれない。そのため Webhook が失効しても気づけない（`docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md` の「既知の制約」参照）
- 通知の成否は「1つ以上の宛先に届いたか」で判定する。LINEだけ失敗してもワークフローは赤くしない
```

- [ ] **Step 7: `README.md` と `docs/GITHUB_ACTIONS_SETUP.md` を更新する**

`README.md` の環境変数テーブル（現行 48 行の `| LINE_USER_ID | ... |` の直後）に 2 列形式で 1 行追加する:

```markdown
| `DISCORD_WEBHOOK_URL` | 任意: LINE送信失敗時のフォールバック先Webhook💬 |
```

`README.md` の `.env` サンプルブロック（現行 80 行の直後）に 1 行追加する:

```text
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxx/yyyyy
```

`docs/GITHUB_ACTIONS_SETUP.md` の Secrets テーブル（現行 32 行の直後）に 3 列形式で 1 行追加する:

```markdown
| `DISCORD_WEBHOOK_URL` | 任意: LINE送信失敗時の転送先。Discordのチャンネル設定 → 連携サービス → ウェブフック で作成 | `https://discord.com/api/webhooks/123.../abc...` |
```

- [ ] **Step 8: 検証コマンドを実行する**

Run: `npm run validate:all && npm test && npm run lint`
Expected: すべて PASS。`validate:env` は `DISCORD_WEBHOOK_URL: 設定済み` を表示する（ローカル `.env` に設定済みのため）

- [ ] **Step 9: ワークフローの YAML 構文を確認する**

Run: `node -e "const fs=require('fs');['crawler','morning-crawler','monthly-bonus'].forEach(f=>{const t=fs.readFileSync('.github/workflows/'+f+'.yml','utf8');if(!t.includes('DISCORD_WEBHOOK_URL'))throw new Error(f+' に DISCORD_WEBHOOK_URL がありません');console.log(f+': OK')})"`
Expected: 3 ファイルとも OK と表示される

- [ ] **Step 10: コミットする**

```bash
git add .env.example docker-compose.yml scripts/validate-env.js .github/workflows/ CLAUDE.md README.md docs/GITHUB_ACTIONS_SETUP.md
git commit -m "chore: DISCORD_WEBHOOK_URL を実行環境とドキュメントに追加

ワークフローの.env生成とdocker-composeに任意変数として渡す。
ワークフロー失敗通知(最後の砦)もLINE失敗時のみDiscordへ転送する。
validate-envは任意項目として未設定を警告するがエラーにしない。"
```

---

### Task 6: 実機検証

**Files:** なし（コード変更なし。使い捨てのワンライナーで確認する）

**Interfaces:**
- Consumes: `sendDiscordMessage`（Task 1）、`broadcastMessage`（Task 3）、ローカル `.env` の `DISCORD_WEBHOOK_URL` / `LINE_USER_ID`

**前提:** `DISCORD_WEBHOOK_URL` は GitHub Secrets とローカル `.env` の両方に登録済み。

- [ ] **Step 1: Discord Webhook の疎通を確認する**

Run:
```bash
node -r dotenv/config -e "require('./src/discord').sendDiscordMessage('✅ 疎通確認: Discordフォールバック通知の実装テストです', process.env.DISCORD_WEBHOOK_URL).then(r => console.log(JSON.stringify(r)))"
```
Expected: `{"success":true}` が表示され、Discord のチャンネルにメッセージが届く。LINE の枠は消費しない

- [ ] **Step 2: フォールバック経路を確認する**

無効な LINE トークンを渡して LINE を 401 で失敗させ、Discord へ転送されることを確認する（401 は LINE の月間カウントを消費しない）。

Run:
```bash
node -r dotenv/config -e "
require('./src/broadcast').broadcastMessage('📊 フォールバック検証メッセージ（本文はここに入ります）', {
  LINE_CHANNEL_ACCESS_TOKEN: 'invalid_token_for_fallback_test',
  LINE_USER_ID: process.env.LINE_USER_ID,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL
}).then(r => console.log(JSON.stringify(r, null, 2)))
"
```
Expected:
- 標準出力に `"success": true`、`results` に line=false / discord=true が並ぶ
- Discord に「⚠️ LINEへの送信に失敗したためDiscordに転送しました」「理由: 認証エラー: アクセストークンが無効です (401 Unauthorized)...」に続いて本文が届く
- 出力とログのどこにも LINE トークン・Webhook トークンの生値が出ていない

- [ ] **Step 3: 夜通知のドライランで回帰がないことを確認する**

Run: `DRY_RUN=true node -r dotenv/config src/index.js`
Expected: 通知メッセージプレビューが従来どおり表示され、「ドライランモード」で正常終了（exit 0）。送信は 1 件も行われない

- [ ] **Step 4: 朝通知のドライランで回帰がないことを確認する**

Run: `DRY_RUN=true node -r dotenv/config src/morning-index.js`
Expected: 前日分のプレビューが表示され、正常終了（exit 0）。ストリークデータは保存されない

- [ ] **Step 5: 検証結果をコミットする（コード変更がなければスキップ）**

検証で不具合が見つかった場合のみ修正してコミットする。問題がなければこのステップは何もしない。

---

### Task 7: main へのマージとリリース確認

**Files:** なし

- [ ] **Step 1: 全テストと lint の最終確認**

Run: `npm test && npm run lint && npm run validate:all`
Expected: すべて PASS

- [ ] **Step 2: 差分を確認する**

Run: `git diff main...HEAD --stat`
Expected: `src/discord.js` `src/broadcast.js` の新規追加、`src/config.js` `src/notifier.js` `src/index.js` `src/morning-index.js` `src/monthly-bonus-index.js` の変更、テスト・ワークフロー・ドキュメントの変更が並ぶ

- [ ] **Step 3: main にマージして push する**

```bash
git checkout main
git merge --no-ff feat/discord-fallback-notification -m "Merge branch 'feat/discord-fallback-notification'"
git push origin main
```

- [ ] **Step 4: 本番経路を手動実行して確認する**

Run: `gh workflow run morning-crawler.yml && sleep 60 && gh run list --workflow=morning-crawler.yml --limit 1`

（このワークフローは目標時刻まで待機する作りのため、完了までに時間がかかる。`gh run watch` で進捗を追い、ログに「✅ 朝通知の送信が完了しました」が出ること、LINE に通常どおり届き Discord には何も届かないこと（LINE が成功しているため）を確認する）

- [ ] **Step 5: 使い終わったブランチを削除する**

```bash
git branch -d feat/discord-fallback-notification
```
