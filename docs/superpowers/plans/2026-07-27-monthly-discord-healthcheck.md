# 月次清算の Discord 常時送信（Webhook 失効検知）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 月次ボーナス清算のときだけ LINE の成否にかかわらず Discord にも送り、Webhook の失効を年12回の定期実行で検知できるようにする。

**Architecture:** 既存の `src/broadcast.js` に、全宛先へ送る `broadcastToAll()` を追加する。既存の `broadcastMessage()`（LINE失敗時のみ転送）は変更しない。両者で重複する「LINE送信の例外ガード」と「Discord送信」を内部ヘルパーに切り出して共有する。`src/monthly-bonus-index.js` は `broadcastToAll()` に切り替え、「ボーナスをリセットするか」と「終了コード」を別々の条件で判定する。

**Tech Stack:** Node.js >= 24 / CommonJS / グローバル `fetch`（追加依存なし）/ Node.js built-in test runner / oxlint

## Global Constraints

- 設計仕様: `docs/superpowers/specs/2026-07-27-monthly-discord-healthcheck-design.md`。判断に迷ったらこの spec が正
- モジュールシステムは CommonJS。`require` / `module.exports` を使う
- 追加の npm 依存を入れない
- I/O 関数の戻り値は `{success: boolean, ...}` パターン
- **`broadcastMessage()` の挙動は変更しない**。夜通知・朝通知は引き続き「LINE失敗時のみDiscordへ転送」
- **`broadcastToAll()` の `success` の意味は `broadcastMessage()` と同じ「1つ以上の宛先に届いたか」**。関数によって `success` の意味を変えない
- Discord メッセージ上限は 2000 文字、LINE は 5000 文字
- コード内のコメント・ドキュメント・コミットメッセージは日本語で書く
- テストは `node --test`。単一ファイル実行は `node --test --test-force-exit --experimental-test-isolation=none tests/<file>` （オプション2つは必須）
- テストデータの子供の名前は架空名（たろう・はなこ・じろう）を使う。実名は使わない

---

### Task 1: `broadcastToAll()` の追加と共通処理の切り出し

**Files:**
- Modify: `src/broadcast.js`
- Test: `tests/broadcast.test.js`

**Interfaces:**
- Consumes: `sendPushMessage(message, accessToken, userId, options)` / `truncateToLimit(message, maxLength)`（`src/notifier.js`）、`sendDiscordMessage(message, webhookUrl, options)` / `DISCORD_MAX_MESSAGE_LENGTH`（`src/discord.js`）
- Produces: `broadcastToAll(message: string, config: {LINE_CHANNEL_ACCESS_TOKEN: string, LINE_USER_ID: string, DISCORD_WEBHOOK_URL?: string}, options?: object) → Promise<{success: boolean, results: Array<{channel: 'line'|'discord', success: boolean, error?: string}>}>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/broadcast.test.js` の一番外側の `describe('送信フォールバック層 (src/broadcast.js)', ...)` の中に、新しい describe ブロックとして追加する（既存の `setupMocks` / `defaultConfig` / `callLog` をそのまま使う）:

```js
  describe('broadcastToAll() - 全宛先送信（月次清算の疎通確認用）', () => {
    it('正常系: LINEが成功してもDiscordにも送る', async () => {
      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true);
      assert.strictEqual(callLog.filter(c => c.type === 'line').length, 1);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1, 'LINE成功でもDiscordを呼ぶこと');
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[0].channel, 'line');
      assert.strictEqual(result.results[1].channel, 'discord');
    });

    it('正常系: LINE成功時、Discordには理由行のない本文をそのまま送る', async () => {
      await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage, '清算メッセージ', '転送ヘッダを付けないこと');
    });

    it('正常系: LINE失敗時はDiscordのメッセージに理由行が付く', async () => {
      setupMocks({
        sendPushMessage: async (...args) => {
          callLog.push({ type: 'line', args });
          return { success: false, error: 'LINE API エラー: 429 Too Many Requests' };
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, 'Discordに届いていれば成功扱い');
      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.match(sentMessage, /^⚠️ LINEへの送信に失敗したためDiscordに転送しました/);
      assert.match(sentMessage, /理由: LINE API エラー: 429/);
      assert.match(sentMessage, /清算メッセージ/);
    });

    it('正常系: LINE成功・Discord失敗でもsuccessはtrue（resultsに失敗が残る）', async () => {
      setupMocks({
        sendDiscordMessage: async (...args) => {
          callLog.push({ type: 'discord', args });
          return { success: false, error: 'Discord API エラー: 404 Not Found - Unknown Webhook' };
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true, 'LINEに届いているので成功扱い');
      const discordResult = result.results.find(r => r.channel === 'discord');
      assert.strictEqual(discordResult.success, false);
      assert.match(discordResult.error, /Unknown Webhook/, '失効を判別できる理由が残ること');
    });

    it('異常系: 両方失敗したらsuccessはfalse', async () => {
      setupMocks({
        sendPushMessage: async () => ({ success: false, error: 'LINE API エラー: 429' }),
        sendDiscordMessage: async () => ({ success: false, error: 'Discord API エラー: 404' })
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.results.length, 2);
    });

    it('正常系: Webhook未設定ならDiscordを呼ばず、resultsにdiscordが入らない', async () => {
      const result = await broadcast.broadcastToAll('清算メッセージ', {
        ...defaultConfig,
        DISCORD_WEBHOOK_URL: undefined
      });

      assert.strictEqual(result.success, true, 'LINEに届いているので成功');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0);
      assert.strictEqual(result.results.length, 1, 'LINEの結果だけが残ること');
      assert.strictEqual(result.results.find(r => r.channel === 'discord'), undefined);
    });

    it('正常系: LINE送信が例外を投げてもDiscordへ送る', async () => {
      setupMocks({
        sendPushMessage: async () => {
          throw new Error('想定外の例外');
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      assert.strictEqual(result.success, true);
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1, '例外でもDiscordへ送ること');
      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.match(sentMessage, /想定外の例外/, '例外の理由が転送メッセージに載ること');
    });

    it('セキュリティ: 例外メッセージに含まれるトークンはDiscordへ転送されない', async () => {
      setupMocks({
        sendPushMessage: async () => {
          throw new Error('failed with token=test_token and user=U0000000000');
        }
      });

      const result = await broadcast.broadcastToAll('清算メッセージ', defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.includes('test_token'), false, 'LINEトークンが漏れないこと');
      assert.strictEqual(sentMessage.includes('U0000000000'), false, 'ユーザーIDが漏れないこと');
      const lineResult = result.results.find(r => r.channel === 'line');
      assert.strictEqual(lineResult.error.includes('test_token'), false);
    });

    it('正常系: Discordへは2000文字に切り詰めて渡す', async () => {
      await broadcast.broadcastToAll('あ'.repeat(5000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.length <= 2000, true);
    });

    it('正常系: LINEへは5000文字に切り詰めて渡す', async () => {
      await broadcast.broadcastToAll('あ'.repeat(9000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'line').args;
      assert.strictEqual(sentMessage.length <= 5000, true);
    });
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js`
Expected: FAIL。`broadcast.broadcastToAll is not a function` で新規ケースが落ちる。既存ケースはすべて PASS のままであること

- [ ] **Step 3: 共通処理を内部ヘルパーに切り出す**

`src/broadcast.js` の `maskConfigSecrets()` の直後に、2つのヘルパーを追加する:

```js
/**
 * LINEへ送信する。想定外の例外も「LINE失敗」として畳み込む
 *
 * 例外がここを素通りするとDiscordが一度も呼ばれず通知が無音になるため、
 * 「LINEがどう失敗してもDiscordに回る」という不変条件をこのtry/catchで保証する。
 *
 * @private
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendToLine(message, config, options) {
  try {
    return await sendPushMessage(
      truncateToLimit(message, LINE_MAX_MESSAGE_LENGTH),
      config.LINE_CHANNEL_ACCESS_TOKEN,
      config.LINE_USER_ID,
      options
    );
  } catch (error) {
    // 例外メッセージはDiscordの理由行に載るため、シークレットを落としてから積む
    return {
      success: false,
      error: `LINE送信で予期しない例外が発生しました: ${maskConfigSecrets(error && error.message ? error.message : error, config)}`
    };
  }
}

/**
 * Discordへ送信する
 *
 * lineError が渡された場合は転送であることを示す理由行を先頭に付ける。
 * null の場合（LINEが成功しているケース）は本文をそのまま送る。
 *
 * @private
 * @param {string} message - 本文
 * @param {object} config - 設定オブジェクト
 * @param {object} options - 送信オプション
 * @param {string|null} lineError - LINE送信のエラー文字列。成功していれば null
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendToDiscord(message, config, options, lineError) {
  const body = lineError ? formatFallbackMessage(message, lineError) : message;
  return sendDiscordMessage(
    truncateToLimit(body, DISCORD_MAX_MESSAGE_LENGTH),
    config.DISCORD_WEBHOOK_URL,
    options
  );
}
```

- [ ] **Step 4: `broadcastMessage()` をヘルパー利用に書き換える**

既存の `broadcastMessage()` の本体を以下に置き換える。**外部から見た挙動は一切変えない**:

```js
async function broadcastMessage(message, config, options = {}) {
  const results = [];

  const lineResult = await sendToLine(message, config, options);
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
  const discordResult = await sendToDiscord(message, config, options, lineResult.error);
  results.push({ channel: 'discord', success: discordResult.success, error: discordResult.error });

  if (discordResult.success) {
    console.warn('⚠️ LINEには届きませんでしたが、Discordへの転送に成功しました');
  } else {
    console.error('❌ Discordへの転送にも失敗しました:', discordResult.error);
  }

  return { success: discordResult.success, results };
}
```

- [ ] **Step 5: `broadcastToAll()` を実装する**

`broadcastMessage()` の直後に追加する:

```js
/**
 * メッセージをLINEとDiscordの両方へ送る
 *
 * LINEの成否にかかわらずDiscordへも送る。月次ボーナス清算だけがこれを使う。
 * Discordはフォールバック専用のままだとLINEが成功する限り一度も叩かれず、
 * Webhookが失効しても「LINEが落ちた当日」まで気づけない。年12回必ず走る
 * 月次清算を定期的な疎通確認に使うことで、失効を最大1か月で検知する。
 *
 * success の意味は broadcastMessage() と同じく「1つ以上の宛先に届いたか」。
 * Discord単体の失敗をどう扱うかは呼び出し側が results を見て決める。
 *
 * @param {string} message - 送信するメッセージ（切り詰めは本関数が宛先ごとに行う）
 * @param {{LINE_CHANNEL_ACCESS_TOKEN: string, LINE_USER_ID: string, DISCORD_WEBHOOK_URL?: string}} config
 * @param {object} [options] - 送信オプション（maxRetries / retryDelay / timeoutMs）。両宛先に渡る
 * @returns {Promise<{success: boolean, results: Array<{channel: string, success: boolean, error?: string}>}>}
 */
async function broadcastToAll(message, config, options = {}) {
  const results = [];

  const lineResult = await sendToLine(message, config, options);
  results.push({ channel: 'line', success: lineResult.success, error: lineResult.error });

  if (!lineResult.success) {
    console.error('❌ LINEへの送信に失敗しました:', lineResult.error);
  }

  if (!config.DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、Discordへの送信をスキップします');
    return { success: lineResult.success, results };
  }

  console.log('📤 Discordへ送信しています...');
  // LINEが失敗している場合だけ理由行を付ける（成功時は本文をそのまま送る）
  const discordResult = await sendToDiscord(
    message,
    config,
    options,
    lineResult.success ? null : lineResult.error
  );
  results.push({ channel: 'discord', success: discordResult.success, error: discordResult.error });

  if (!discordResult.success) {
    console.error('❌ Discordへの送信に失敗しました:', discordResult.error);
  }

  return { success: lineResult.success || discordResult.success, results };
}
```

`module.exports` に `broadcastToAll` を追加する:

```js
module.exports = {
  broadcastMessage,
  broadcastToAll,
  formatFallbackMessage,
  LINE_MAX_MESSAGE_LENGTH
};
```

ファイル冒頭のモジュール説明コメントも実態に合わせて更新する:

```js
/**
 * 送信層
 *
 * 1本のメッセージをどの宛先へどの順序で送るかだけを担う。
 * - broadcastMessage: LINEに送り、失敗したときだけDiscordへ転送する（日次の通知が使う）
 * - broadcastToAll:   LINEの成否にかかわらずDiscordへも送る（月次清算だけが使う）
 *
 * 設計: docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md
 *       docs/superpowers/specs/2026-07-27-monthly-discord-healthcheck-design.md
 */
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js`
Expected: PASS（新規10ケースと既存ケースの全部）

- [ ] **Step 7: 全テストと lint を通す**

Run: `npm test && npm run lint`
Expected: すべて PASS、lint エラーなし。`broadcastMessage` の挙動は変えていないので、`tests/index.test.js` / `tests/monthly-bonus-index.test.js` も無修正で通ること

- [ ] **Step 8: コミットする**

```bash
git add src/broadcast.js tests/broadcast.test.js
git commit -m "feat: 全宛先へ送る broadcastToAll を追加する

月次清算でLINEの成否にかかわらずDiscordへも送るための関数。
Discordはフォールバック専用だとLINEが成功する限り叩かれず、Webhook失効を
検知できないため、年12回走る月次清算を疎通確認に使う。
LINE送信の例外ガードとDiscord送信は両関数で共有する内部ヘルパーに切り出した。"
```

---

### Task 2: 月次清算の切り替えと終了コード判定

**Files:**
- Modify: `src/monthly-bonus-index.js`
- Modify: `CLAUDE.md`
- Test: `tests/monthly-bonus-index.test.js`

**Interfaces:**
- Consumes: `broadcastToAll(message, config)` → `{success, results}`（Task 1）
- Produces: なし（エントリポイントの内部変更）

- [ ] **Step 1: 失敗するテストを書く**

`tests/monthly-bonus-index.test.js` の `setupMocks()` にある broadcast モックを `broadcastToAll` に差し替える。修正後の `src/monthly-bonus-index.js` は `broadcastMessage` を一切呼ばなくなるため、そのモックエントリは削除する:

```js
    require.cache[resolveModule('../src/broadcast')] = {
      id: resolveModule('../src/broadcast'), filename: resolveModule('../src/broadcast'), loaded: true,
      exports: {
        broadcastToAll: overrides.broadcastToAll || (async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return {
            success: true,
            results: [
              { channel: 'line', success: true },
              { channel: 'discord', success: true }
            ]
          };
        })
      }
    };
```

既存テストのうち `callLog.filter(c => c.type === 'broadcastMessage')` を見ているもの、および `overrides.broadcastMessage` で失敗を注入しているものは、すべて `broadcastToAll` に読み替えて書き換える。`overrides` のキー名も `broadcastToAll` にすること。

そのうえで `describe('main() - 清算フロー', ...)` の末尾に次を追加する:

```js
    it('正常系: LINE成功・Discord失敗のときリセットはするが終了コード1で失効を知らせる', async () => {
      setupMocks({
        broadcastToAll: async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return {
            success: true,
            results: [
              { channel: 'line', success: true },
              { channel: 'discord', success: false, error: 'Discord API エラー: 404 Not Found - Unknown Webhook' }
            ]
          };
        }
      });

      const result = await mainModule.main();

      const saveCalls = callLog.filter(c => c.type === 'saveStreakData');
      assert.strictEqual(saveCalls.length, 1, 'LINEに届いているのでリセットすること(二重支給防止)');
      assert.strictEqual(saveCalls[0].users['じろう (小学生コース)'].bonus, 0);
      assert.strictEqual(result.exitCode, 1, 'Webhook失効に気づけるよう終了コード1にすること');
    });

    it('正常系: Webhook未設定のときはリセットして終了コード0(任意項目のため失敗にしない)', async () => {
      setupMocks({
        broadcastToAll: async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 1);
      assert.strictEqual(result.exitCode, 0, 'Discordの結果がなければ終了コードに影響させないこと');
    });

    it('異常系: 両方失敗したらリセットせず終了コード1(清算持ち越し)', async () => {
      setupMocks({
        broadcastToAll: async () => ({
          success: false,
          results: [
            { channel: 'line', success: false, error: 'LINE API エラー: 429' },
            { channel: 'discord', success: false, error: 'Discord API エラー: 404' }
          ]
        })
      });

      const result = await mainModule.main();

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 0, '全滅時は保存しないこと');
    });

    it('正常系: LINE失敗・Discord成功ならリセットして終了コード0', async () => {
      setupMocks({
        broadcastToAll: async (...args) => {
          callLog.push({ type: 'broadcastToAll', args });
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

      assert.strictEqual(callLog.filter(c => c.type === 'saveStreakData').length, 1);
      assert.strictEqual(result.exitCode, 0, 'LINE単体の失敗ではワークフローを赤くしないこと');
    });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: FAIL。`src/monthly-bonus-index.js` がまだ `broadcastMessage` を呼ぶため `broadcastToAll` の呼び出しが 0 件になり、Discord 失敗ケースの終了コードも 0 のままになる

- [ ] **Step 3: `src/monthly-bonus-index.js` を修正する**

require 行を差し替える:

```js
const { broadcastToAll } = require('./broadcast');
```

障害通知（ストリークデータ読み込み失敗時）の送信も `broadcastToAll` に変える。障害通知こそ確実に届いてほしく、かつ同じ実行内で Discord の疎通も確かめられるため:

```js
      const errorNotifyResult = await broadcastToAll(errorMessage, config);
      if (!errorNotifyResult.success) {
        console.error('❌ エラー通知の送信に全宛先で失敗しました');
      }
```

清算通知の送信部を差し替える:

```js
  // 5. 通知送信（LINEとDiscordの両方へ。Discordは年12回の疎通確認を兼ねる）
  console.log('📤 通知を送信しています...');
  const notifyResult = await broadcastToAll(message, config);

  if (!notifyResult.success) {
    // 全宛先で失敗したときはリセットせず持ち越す(次回実行で再清算できる)
    console.error('❌ 通知の送信に全宛先で失敗しました');
    return { success: false, exitCode: 1, error: '清算通知が全宛先で失敗しました' };
  }

  // どこか1つでも届いていればリセットする。届いているのに持ち越すと、
  // 次回実行で同じ月の清算が再送・再支給されてしまうため
  console.log('✅ 月次ボーナス清算の通知が完了しました');
```

リセット保存の直後（`errors.push(saveResult.error)` の閉じ括弧の後）に、Discord の疎通判定を追加する:

```js
  // Discordへ送ったのに失敗した場合は、Webhookが失効している可能性がある。
  // 清算そのものはLINEに届いているためリセットは済ませたうえで、
  // 終了コードで知らせる(Discordはフォールバック専用で普段は叩かれないため、
  // この月次実行が唯一の定期的な疎通確認になっている)
  const discordResult = notifyResult.results.find(result => result.channel === 'discord');
  if (discordResult && !discordResult.success) {
    console.error('❌ Discordへの送信に失敗しました。Webhookが失効している可能性があります:', discordResult.error);
    errors.push(`Discordへの疎通確認に失敗しました: ${discordResult.error}`);
  }
```

既存の末尾の戻り値（`errors.length` で成否と終了コードを決める形）はそのまま使う。

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: PASS（新規4ケースと既存ケースの全部）

- [ ] **Step 5: `CLAUDE.md` を更新する**

`### LINE送信数の制約（重要）` 節の次の行を書き換える:

```markdown
- Discordはフォールバック専用で、LINEが成功している限り一度も呼ばれない。そのため Webhook が失効しても気づけない（`docs/superpowers/specs/2026-07-27-discord-fallback-notification-design.md` の「既知の制約」参照）
```

置き換え後:

```markdown
- Discordは日次通知ではフォールバック専用で、LINEが成功している限り呼ばれない。Webhookの失効を検知するため、**月次ボーナス清算だけはLINEの成否にかかわらずDiscordにも送る**（`src/broadcast.js` の `broadcastToAll`）。年12回の疎通確認になり、Discord送信が失敗した月は終了コード1でワークフローが赤くなる。詳細: `docs/superpowers/specs/2026-07-27-monthly-discord-healthcheck-design.md`
```

あわせて `## Project Structure` の `src/` ツリーにある broadcast.js の行を更新する:

```text
└── broadcast.js              # 送信層 (broadcastMessage: LINE→失敗時のみDiscord / broadcastToAll: 常に両方)
```

`### Three Entry Points` の月次ボーナス清算の説明にも一文追加する（「クロール不要のためブラウザを起動しない」の後）:

```markdown
LINEの成否にかかわらずDiscordにも送り、Webhook失効の定期検知を兼ねる
```

- [ ] **Step 6: 全テストと lint を通す**

Run: `npm test && npm run lint`
Expected: すべて PASS、lint エラーなし

- [ ] **Step 7: DRY_RUN で回帰がないことを確認する**

Run: `DRY_RUN=true node -r dotenv/config src/monthly-bonus-index.js`
Expected: 清算プレビューが表示され、「ドライランモード」のログで正常終了（exit 0）。送信は行われない

- [ ] **Step 8: コミットする**

```bash
git add src/monthly-bonus-index.js tests/monthly-bonus-index.test.js CLAUDE.md
git commit -m "feat: 月次清算をDiscord常時送信にしWebhook失効を検知する

broadcastToAll に切り替え、リセット条件と終了コードを分離した。
Discordだけ失敗した場合もLINEに届いていればリセットする(持ち越すと翌月に
二重支給になるため)。失効は終了コード1で知らせる。"
```

---

### Task 3: 実機検証とマージ

**Files:** なし

- [ ] **Step 1: Discord 常時送信の経路を実機で確認する**

使い捨てのワンライナーで、LINE が成功する状況で Discord にも届くことを確認する。LINE の月間枠は現在枯渇しており 429 が返るため、実際には「LINE失敗・Discord成功」の経路が走る。どちらの経路でも Discord に届くことがこのタスクの確認事項である。

Run:
```bash
node -r dotenv/config -e "
require('./src/broadcast').broadcastToAll('💰 [検証] 月次清算の疎通確認テストです', {
  LINE_CHANNEL_ACCESS_TOKEN: 'invalid_token_for_healthcheck_test',
  LINE_USER_ID: process.env.LINE_USER_ID,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL
}).then(r => console.log(JSON.stringify(r, null, 2)))
"
```
Expected:
- `success: true`、`results` に line=false / discord=true
- Discord にメッセージが届く
- 出力のどこにもトークンの生値が出ていない

無効なトークンを使うのは LINE の月間カウントを消費しないため（401 はカウントされない）。**本物の LINE トークンでの送信は行わない。**

- [ ] **Step 2: 最終確認**

Run: `npm test && npm run lint && npm run validate:all`
Expected: すべて PASS

- [ ] **Step 3: main にマージして push する**

```bash
git checkout main
git merge --no-ff feat/monthly-discord-healthcheck -m "Merge branch 'feat/monthly-discord-healthcheck'"
git push origin main
```

- [ ] **Step 4: CI を確認する**

Run: `gh run list --limit 3`
Expected: main への push で走った CI が success

- [ ] **Step 5: 使い終わったブランチを削除する**

```bash
git branch -d feat/monthly-discord-healthcheck
```
