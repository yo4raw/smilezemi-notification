# 夜通知の全員達成日をDiscordに記録する 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 夜通知で全ユーザーがストリーク要件を達成した日に、LINEには送らず断り行付きでDiscordだけに記録を送る。

**Architecture:** `src/broadcast.js` に第3の宛先ポリシー `broadcastToDiscordOnly()` を追加し、`src/index.js` の条件送信を「早期returnでスキップ」から「送信直前の宛先切り替え」に置き換える。差分比較・メッセージ整形・データ保存はすべて通常経路に合流させる。

**Tech Stack:** Node.js >= 24 / CommonJS / Node.js built-in test runner (`node --test`) / oxlint

## Global Constraints

- モジュールシステムは CommonJS（`require` / `module.exports`）。ESM は使わない
- I/O 関数は `{ success: boolean, data?/error? }` を返す。純粋関数は値を直接返す
- コード内コメント・ログ・Markdown はすべて日本語で書く
- 断り行の文言は次の1行を一字一句そのまま使う:
  `ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します(送信数節約)`
- `broadcastMessage()` と `broadcastToAll()` の外部契約（引数・戻り値・ログ文言）は変更しない
- テストコマンドは `npm test`（全件）。単一ファイルは `node --test --test-force-exit --experimental-test-isolation=none tests/<file>` （オプション2つは必須）
- lint は `npm run lint`（`--deny-warnings` で警告もエラー扱い）
- `src/index.js` に新しい `require` を追加したら `tests/index.test.js` の `MODULE_PATHS` とモック登録の追加が必須。本計画では新規 require を増やさず、必要な定数は `src/broadcast.js` から再エクスポートして回避する
- 作業ブランチは `feat/night-notification-discord-record`（作成済み、設計書コミット `d05d3ee` を含む）

---

### Task 1: `sendToDiscord()` を `postToDiscord()` へ整理する

理由行の要否判断を呼び出し側3関数に移し、Discord送信ヘルパを「送信と例外の畳み込みだけ」にする。これをやらないと Task 2 で「LINEの試行が存在しないのに偽の `{ success: true }` を渡す」ことになる。純粋なリファクタで、既存テストが無変更で通ることが完了条件。

**Files:**
- Modify: `src/broadcast.js`

**Interfaces:**
- Consumes: なし（本計画の最初のタスク）
- Produces: private `postToDiscord(body: string, config: object, options: object) => Promise<{success: boolean, error?: string}>` — Task 2 が使う

- [ ] **Step 1: 既存テストが通ることを確認する（リファクタ前のベースライン）**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js`
Expected: PASS（全件）

- [ ] **Step 2: `sendToDiscord()` を `postToDiscord()` に置き換える**

`src/broadcast.js` の `sendToDiscord()` 関数定義を、まるごと次に差し替える:

```js
/**
 * Discordへ送信する。想定外の例外も「Discord失敗」として畳み込む
 *
 * 本文はすでに完成した状態で渡される。理由行を付けるかどうかは
 * 呼び出し側の宛先ポリシーが決めることで、この関数はLINEの結果を知らない。
 *
 * 例外を畳み込むのは主に broadcastToAll() のため。LINE成功後にDiscordで例外が抜けると
 * 呼び出し元（月次清算）の後続処理に到達せず、清算メッセージはLINEに届いているのに
 * ボーナスがリセットされない = 翌月に同じ分が再清算される二重支給になる。
 *
 * @private
 * @param {string} body - 送信する本文（理由行の付加は呼び出し側で済ませておく）
 * @param {object} config - 設定オブジェクト
 * @param {object} options - 送信オプション
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function postToDiscord(body, config, options) {
  try {
    return await sendDiscordMessage(
      truncateToLimit(body, DISCORD_MAX_MESSAGE_LENGTH),
      config.DISCORD_WEBHOOK_URL,
      options
    );
  } catch (error) {
    // 例外メッセージはログに残るため、シークレット（Webhook URL・LINEトークン）を落としてから積む
    return {
      success: false,
      error: `Discord送信で予期しない例外が発生しました: ${maskConfigSecrets(error && error.message ? error.message : error, config)}`
    };
  }
}
```

- [ ] **Step 3: `broadcastMessage()` の呼び出しを差し替える**

`src/broadcast.js` の `broadcastMessage()` 内、`const discordResult = await sendToDiscord(message, config, options, lineResult);` の行を次に差し替える:

```js
  // ここに来る時点でLINEは失敗しているため、必ず理由行付きで転送される
  const discordResult = await postToDiscord(
    formatFallbackMessage(message, lineResult.error || '不明なエラー'),
    config,
    options
  );
```

直前にある `// ここに来る時点でLINEは失敗しているため、必ず理由行付きで転送される` のコメント行は重複するので削除する。

- [ ] **Step 4: `broadcastToAll()` の呼び出しを差し替える**

`src/broadcast.js` の `broadcastToAll()` 内、`const discordResult = await sendToDiscord(message, config, options, lineResult);` の行を次に差し替える:

```js
  // LINEが失敗している場合だけ理由行を付ける（成功時は本文をそのまま送る）
  const discordResult = await postToDiscord(
    lineResult.success ? message : formatFallbackMessage(message, lineResult.error || '不明なエラー'),
    config,
    options
  );
```

直前にある `// LINEが失敗している場合だけ理由行を付ける（成功時は本文をそのまま送る）` のコメント行は重複するので削除する。

- [ ] **Step 5: テストと lint を実行する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js && npm run lint`
Expected: PASS。テストは1件も書き換えずに全件通ること。`sendToDiscord` への参照が残っていれば `ReferenceError` で落ちるので、その場合は残った呼び出しを探して差し替える

- [ ] **Step 6: コミットする**

```bash
git add src/broadcast.js
git commit -m "refactor: Discord送信ヘルパから理由行の判断を呼び出し側へ移す"
```

---

### Task 2: `broadcastToDiscordOnly()` を追加する

**Files:**
- Modify: `src/broadcast.js`
- Test: `tests/broadcast.test.js`

**Interfaces:**
- Consumes: private `postToDiscord(body, config, options)`（Task 1）
- Produces:
  - `broadcastToDiscordOnly(message: string, config: object, options?: object) => Promise<{success: boolean, skipped?: boolean, results: Array<{channel: string, success: boolean, error?: string}>}>`
  - `DISCORD_MAX_MESSAGE_LENGTH: number`（`src/discord.js` からの再エクスポート、値は 2000）
  - どちらも Task 3 が使う

- [ ] **Step 1: 失敗するテストを書く**

`tests/broadcast.test.js` の `describe('broadcastToAll() ...')` ブロックの**閉じ括弧の直後**（ファイル末尾の一番外側の `});` の手前）に、次の describe を追加する:

```js
  describe('broadcastToDiscordOnly() - Discord単独送信（夜通知の全員達成日用）', () => {
    it('正常系: LINEを呼ばずDiscordだけに送る', async () => {
      const result = await broadcast.broadcastToDiscordOnly('記録メッセージ', defaultConfig);

      assert.strictEqual(result.success, true);
      assert.strictEqual(callLog.filter(c => c.type === 'line').length, 0, 'LINEを呼ばないこと');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 1);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].channel, 'discord');
      assert.strictEqual(result.skipped, undefined, '送信した場合はskippedを付けないこと');
    });

    it('正常系: 本文に転送の理由行を付けずそのまま送る', async () => {
      await broadcast.broadcastToDiscordOnly('記録メッセージ', defaultConfig);

      const [sentMessage, webhookUrl] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage, '記録メッセージ', '転送ヘッダを付けないこと');
      assert.strictEqual(webhookUrl, 'https://discord.com/api/webhooks/123/abc');
    });

    it('正常系: Discordへは2000文字に切り詰めて渡す', async () => {
      await broadcast.broadcastToDiscordOnly('あ'.repeat(5000), defaultConfig);

      const [sentMessage] = callLog.find(c => c.type === 'discord').args;
      assert.strictEqual(sentMessage.length <= 2000, true, 'Discordの上限に収めること');
    });

    it('異常系: Discord送信が失敗したらsuccessはfalse（skippedは付かない）', async () => {
      setupMocks({
        sendDiscordMessage: async (...args) => {
          callLog.push({ type: 'discord', args });
          return { success: false, error: 'Discord API エラー: 404 Not Found - Unknown Webhook' };
        }
      });

      const result = await broadcast.broadcastToDiscordOnly('記録メッセージ', defaultConfig);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.skipped, undefined, '送信を試みた失敗はskippedにしないこと');
      assert.strictEqual(result.results.length, 1);
      assert.match(result.results[0].error, /Unknown Webhook/);
    });

    it('異常系: sendDiscordMessageが例外を投げても失敗として畳み込む', async () => {
      setupMocks({
        sendDiscordMessage: async () => {
          throw new Error('想定外の例外');
        }
      });

      const result = await broadcast.broadcastToDiscordOnly('記録メッセージ', defaultConfig);

      assert.strictEqual(result.success, false);
      assert.match(result.results[0].error, /想定外の例外/);
    });

    it('正常系: Webhook未設定なら送信せずskipped:trueを返す', async () => {
      const result = await broadcast.broadcastToDiscordOnly('記録メッセージ', {
        ...defaultConfig,
        DISCORD_WEBHOOK_URL: undefined
      });

      assert.strictEqual(result.success, false, '届いていないのでsuccessはfalse');
      assert.strictEqual(result.skipped, true, '宛先がないことをskippedで示すこと');
      assert.strictEqual(callLog.filter(c => c.type === 'discord').length, 0, 'Discordを呼ばないこと');
      assert.deepStrictEqual(result.results, []);
    });

    it('正常系: DISCORD_MAX_MESSAGE_LENGTHをエクスポートする', () => {
      assert.strictEqual(broadcast.DISCORD_MAX_MESSAGE_LENGTH, 2000);
    });
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js`
Expected: FAIL。`broadcast.broadcastToDiscordOnly is not a function` （`DISCORD_MAX_MESSAGE_LENGTH` のテストは `undefined !== 2000` で失敗）

- [ ] **Step 3: `broadcastToDiscordOnly()` を実装する**

`src/broadcast.js` の `broadcastToAll()` 関数定義の直後、`module.exports` の手前に追加する:

```js
/**
 * メッセージをDiscordだけへ送る（LINEには送らない）
 *
 * 夜通知で全ユーザーが当日のストリーク要件を達成した日に使う。LINEグループへのpushは
 * 人数分カウントされ無料枠(月200)が逼迫しているため、この日はLINEを消費しない。
 * 一方Discordには月間送信数の上限がないので、記録としては必ず残す。
 *
 * success の意味は broadcastMessage() と同じく「1つ以上の宛先に届いたか」。
 * DISCORD_WEBHOOK_URL 未設定のときは「宛先がないから送らなかった」ことを skipped で示す。
 * この設定は任意扱いのため、未設定環境で毎晩ワークフローが赤くなるのを避けたい呼び出し側が
 * 「送って失敗した(success:false)」と区別できるようにしている。
 *
 * 本文に転送の理由行は付けない。LINEを試していないので「失敗して転送した」わけではなく、
 * 送らなかった理由を知っているのは呼び出し側（src/index.js）だからである。
 *
 * 設計: docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md
 *
 * @param {string} message - 送信するメッセージ（切り詰めは本関数が行う）
 * @param {{DISCORD_WEBHOOK_URL?: string}} config
 * @param {object} [options] - 送信オプション（maxRetries / retryDelay / timeoutMs）
 * @returns {Promise<{success: boolean, skipped?: boolean, results: Array<{channel: string, success: boolean, error?: string}>}>}
 */
async function broadcastToDiscordOnly(message, config, options = {}) {
  if (!config.DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、Discordへの送信をスキップします');
    return { success: false, skipped: true, results: [] };
  }

  console.log('📤 Discordへ送信しています...');
  const discordResult = await postToDiscord(message, config, options);

  if (!discordResult.success) {
    console.error('❌ Discordへの送信に失敗しました:', discordResult.error);
  }

  return {
    success: discordResult.success,
    results: [{ channel: 'discord', success: discordResult.success, error: discordResult.error }]
  };
}
```

- [ ] **Step 4: エクスポートを追加する**

`src/broadcast.js` 末尾の `module.exports` を次に差し替える:

```js
module.exports = {
  broadcastMessage,
  broadcastToAll,
  broadcastToDiscordOnly,
  formatFallbackMessage,
  LINE_MAX_MESSAGE_LENGTH,
  // 呼び出し側（DRY_RUNプレビュー）が宛先ごとの上限で切り詰められるよう再エクスポートする
  DISCORD_MAX_MESSAGE_LENGTH
};
```

- [ ] **Step 5: ファイル冒頭のモジュール説明コメントを更新する**

`src/broadcast.js` 冒頭のブロックコメント内、`- broadcastToAll:   LINEの成否にかかわらずDiscordへも送る（月次清算だけが使う）` の直後に1行追加する:

```js
 * - broadcastToDiscordOnly: Discordだけへ送る（夜通知の全員達成日だけが使う）
```

あわせて、その下の `設計:` の参照リストに1行追加する:

```js
 *       docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md
```

- [ ] **Step 6: テストと lint を実行する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/broadcast.test.js && npm run lint`
Expected: PASS（新規7件を含む全件）

- [ ] **Step 7: コミットする**

```bash
git add src/broadcast.js tests/broadcast.test.js
git commit -m "feat: Discordだけに送るbroadcastToDiscordOnlyを追加する"
```

---

### Task 3: 夜通知の全員達成日をDiscord送信に切り替える

**Files:**
- Modify: `src/index.js`
- Test: `tests/index.test.js`

**Interfaces:**
- Consumes: `broadcastToDiscordOnly(message, config, options?)` と `DISCORD_MAX_MESSAGE_LENGTH`（Task 2、いずれも `./broadcast` から）
- Produces: なし（エントリポイントの内部変更）

- [ ] **Step 1: `tests/index.test.js` の broadcast モックを拡張する**

`tests/index.test.js` の `require.cache[resolveModule('../src/broadcast')]` の `exports` オブジェクトを次に差し替える（`broadcastMessage` の定義はそのまま残し、2つのキーを追加する）:

```js
      exports: {
        broadcastMessage: overrides.broadcastMessage || (async (...args) => {
          callLog.push({ type: 'broadcastMessage', args });
          return { success: true, results: [{ channel: 'line', success: true }] };
        }),
        broadcastToDiscordOnly: overrides.broadcastToDiscordOnly || (async (...args) => {
          callLog.push({ type: 'broadcastToDiscordOnly', args });
          return { success: true, results: [{ channel: 'discord', success: true }] };
        }),
        LINE_MAX_MESSAGE_LENGTH: 5000,
        DISCORD_MAX_MESSAGE_LENGTH: 2000
      }
```

`MODULE_PATHS` は変更不要（新しいモジュールへの require は増やさない）。

- [ ] **Step 2: 失敗するテストを書く**

`tests/index.test.js` の既存テスト `it('正常系: 全ユーザーがストリーク要件達成済みの日は夜通知を送信しない(送信数節約)', ...)` （ブロック全体、`it(` から対応する `});` まで）を、次の4つのテストに差し替える:

```js
    it('正常系: 全ユーザーがストリーク要件達成済みの日はDiscordのみに送る(LINE送信数節約)', async () => {
      setupMocks({
        isStudied: () => true
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);

      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastMessage').length, 0,
        '全員達成の日はLINE経路(broadcastMessage)を使わないこと'
      );
      assert.strictEqual(
        callLog.filter(c => c.type === 'broadcastToDiscordOnly').length, 1,
        '全員達成の日はDiscordのみに1回送ること'
      );

      const saveCalls = callLog.filter(c => c.type === 'saveData');
      assert.strictEqual(saveCalls.length, 1, 'データは保存されること');
    });

    it('正常系: 全員達成の日のDiscord本文には断り行が先頭に付く', async () => {
      setupMocks({
        isStudied: () => true,
        formatDetailedMessage: () => 'テスト詳細メッセージ'
      });

      await mainModule.main();

      const [sentMessage] = callLog.find(c => c.type === 'broadcastToDiscordOnly').args;
      assert.match(
        sentMessage,
        /^ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します\(送信数節約\)\n\n/,
        '断り行と空行が先頭に付くこと'
      );
      assert.match(sentMessage, /テスト詳細メッセージ/, '本文が保持されること');
    });

    it('異常系: 全員達成の日にDiscord送信が失敗したら終了コード1になる', async () => {
      setupMocks({
        isStudied: () => true,
        broadcastToDiscordOnly: async (...args) => {
          callLog.push({ type: 'broadcastToDiscordOnly', args });
          return { success: false, results: [{ channel: 'discord', success: false, error: 'Discord API エラー: 404' }] };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1, 'どこにも届かないので赤くすること');
    });

    it('正常系: Webhook未設定(skipped)なら赤くせず正常終了する', async () => {
      setupMocks({
        isStudied: () => true,
        broadcastToDiscordOnly: async (...args) => {
          callLog.push({ type: 'broadcastToDiscordOnly', args });
          return { success: false, skipped: true, results: [] };
        }
      });

      const result = await mainModule.main();

      assert.strictEqual(result.success, true, '宛先がないだけなので赤くしないこと');
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(callLog.filter(c => c.type === 'saveData').length, 1, 'データは保存されること');
    });
```

続けて、既存テスト `it('正常系: ドライラン+全員達成の日は送信もデータ保存も行わない', ...)` の中の次の1行:

```js
        assert.strictEqual(callLog.filter(c => c.type === 'broadcastMessage').length, 0);
```

を次の2行に差し替える:

```js
        assert.strictEqual(callLog.filter(c => c.type === 'broadcastMessage').length, 0);
        assert.strictEqual(callLog.filter(c => c.type === 'broadcastToDiscordOnly').length, 0, 'ドライランではDiscordにも送らないこと');
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js`
Expected: FAIL。「全員達成の日はDiscordのみに1回送ること」で `0 !== 1`（現状は早期returnで何も送らないため）

- [ ] **Step 4: `src/index.js` の require と定数を追加する**

`src/index.js` の12行目を次に差し替える:

```js
const { broadcastMessage, broadcastToDiscordOnly, LINE_MAX_MESSAGE_LENGTH, DISCORD_MAX_MESSAGE_LENGTH } = require('./broadcast');
```

続けて、`const path = require('path');` の直後（`main()` の JSDoc の手前）に定数を追加する:

```js
/**
 * 全員がストリーク要件を達成した日にDiscordへ付ける断り行
 *
 * DiscordにはLINE失敗時のフォールバック転送（先頭が「⚠️ LINEへの送信に失敗した…」）も
 * 届くため、受信側が両者を区別できるよう、送らなかった理由を明示する。
 */
const DISCORD_ONLY_NOTICE = 'ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します(送信数節約)';
```

- [ ] **Step 5: 条件送信の早期returnを削除する**

`src/index.js` の `// 6.6 送信要否の判定` コメントから、その直後の `if (!hasUnqualifiedUser) { ... }` ブロックの閉じ括弧までを**まるごと削除**する（削除範囲は `// 6.6 送信要否の判定` の行から、`saveData` を含むブロックを閉じる `}` の行まで。直後の `// 7. データ比較（変更検出）` は残す）。

`hasUnqualifiedUser` の算出（`currentData.forEach` のループを含む、`// 6.6` より前の部分）は削除しない。

- [ ] **Step 6: 宛先の切り替えを実装する**

`src/index.js` の `const message = formatDetailedMessage(...)` の呼び出し（`});` で閉じる）の直後に、次を追加する:

```js
    // 送信先の決定
    // 夜通知は速報のため、全員が当日のストリーク要件を達成済みの日はLINEに送らない。
    // 送信先グループへのpushは人数分カウントされ無料枠(月200)が逼迫しているため、
    // 「このままだと記録更新できないユーザーがいる」= 夜のうちに促す価値がある日だけLINEに送る。
    // ただしDiscordには月間送信数の上限がないため、全員達成の日も記録として必ず送る。
    // 確定通知は翌朝の朝通知が毎日必ず送る。
    // 詳細: docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md
    const discordOnly = !hasUnqualifiedUser;
    const outgoingMessage = discordOnly ? `${DISCORD_ONLY_NOTICE}\n\n${message}` : message;
```

- [ ] **Step 7: DRY_RUN プレビューを宛先に合わせる**

`src/index.js` の DRY_RUN 分岐のうち、プレビュー出力の3行:

```js
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(truncateToLimit(message, LINE_MAX_MESSAGE_LENGTH));
      console.log('=== プレビュー終了 ===\n');
```

を次に差し替える:

```js
      console.log('\n📋 === 通知メッセージプレビュー ===');
      console.log(truncateToLimit(outgoingMessage, discordOnly ? DISCORD_MAX_MESSAGE_LENGTH : LINE_MAX_MESSAGE_LENGTH));
      console.log('=== プレビュー終了 ===\n');
      console.log(discordOnly
        ? 'ℹ️ 全員達成のため、実行時はDiscordのみに送信します'
        : 'ℹ️ 実行時はLINEに送信します(失敗時はDiscordへ転送)');
```

あわせて、その直前のコメント `// 実送信ではbroadcastが宛先ごとに切り詰めるため、プレビューもLINEの上限で切って表示する` とその次行のコメントを、次の2行に差し替える:

```js
      // 実送信ではbroadcastが宛先ごとに切り詰めるため、プレビューも実際の宛先の上限で切って表示する
      // （送信経路には手を入れず、表示だけを実際の文面に合わせる）
```

- [ ] **Step 8: 送信呼び出しと結果判定を差し替える**

`src/index.js` の次の部分（`broadcastMessage` の呼び出しから `errors.push` を含む if/else の閉じ括弧まで）:

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

を次に差し替える:

```js
    // 通知送信（リトライ・タイムアウト・切り詰め・マスキングは送信層に委譲）
    const notifyResult = discordOnly
      ? await broadcastToDiscordOnly(outgoingMessage, config)
      : await broadcastMessage(outgoingMessage, config);

    if (notifyResult.success) {
      console.log('✅ 通知の送信が完了しました');
    } else if (notifyResult.skipped) {
      // 宛先が1つも設定されていないだけなので、ワークフローは赤くしない
      console.warn('⚠️ DISCORD_WEBHOOK_URL が未設定のため、全員達成日の記録を送信しませんでした');
    } else {
      console.error('❌ 通知の送信に全宛先で失敗しました');
      errors.push('通知が全宛先で失敗しました');
    }
```

- [ ] **Step 9: テストと lint を実行する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/index.test.js && npm run lint`
Expected: PASS（新規4件と書き換えた1件を含む全件）

- [ ] **Step 10: 全テストを実行する**

Run: `npm test`
Expected: PASS（全ファイル）

- [ ] **Step 11: コミットする**

```bash
git add src/index.js tests/index.test.js
git commit -m "feat: 夜通知の全員達成日をDiscordのみに記録する"
```

---

### Task 4: ドキュメントを更新する

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md`

**Interfaces:**
- Consumes: Task 3 完了後の実装
- Produces: なし

- [ ] **Step 1: `CLAUDE.md` のエントリポイント説明を更新する**

`CLAUDE.md` の「Three Entry Points」1項目目の末尾、次の部分:

```text
**送信数節約のため、当日のストリーク要件未達のユーザーが1人でもいる日だけ送信**（全員達成日はデータ保存のみ）
```

を次に差し替える:

```text
**LINE送信数節約のため、当日のストリーク要件未達のユーザーが1人でもいる日だけLINEに送信**（全員達成日はLINEに送らず、断り行を付けてDiscordのみに記録する）
```

- [ ] **Step 2: `CLAUDE.md` の Project Structure を更新する**

`CLAUDE.md` の次の行:

```text
└── broadcast.js              # 送信層 (broadcastMessage: LINE→失敗時のみDiscord / broadcastToAll: 常に両方)
```

を次に差し替える:

```text
└── broadcast.js              # 送信層 (broadcastMessage: LINE→失敗時のみDiscord / broadcastToAll: 常に両方 / broadcastToDiscordOnly: Discordのみ)
```

- [ ] **Step 3: `CLAUDE.md` の「LINE送信数の制約」節を更新する**

同節の本文中、次の部分:

```text
対策として**夜通知は「当日のストリーク要件未達のユーザーが1人でもいる日」だけ送信**し（全員達成の日はスキップ。朝・月次は無条件送信）、週間レポート通知は廃止した。詳細: `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md`
```

を次に差し替える:

```text
対策として**夜通知は「当日のストリーク要件未達のユーザーが1人でもいる日」だけLINEに送信**し（全員達成の日はLINEに送らず、断り行付きでDiscordのみに記録。朝・月次は無条件送信）、週間レポート通知は廃止した。詳細: `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md` と `docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md`
```

続けて同節の箇条書きのうち、次の行の冒頭部分:

```text
- Discordは日次通知ではフォールバック専用で、LINEが成功している限り呼ばれない。
```

を次に差し替える（同じ行の残り、「Webhookの失効を検知するため、…」以降はそのまま残す）:

```text
- Discordは日次通知では原則フォールバック専用で、LINEが成功している限り呼ばれない。例外は夜通知の全員達成日で、この日はLINEを使わずDiscordのみに記録する（`src/broadcast.js` の `broadcastToDiscordOnly`）。
```

- [ ] **Step 4: 既存設計書から新設計書への参照を張る**

`docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md` の「### 夜通知の条件送信」節の箇条書きの末尾（`- 朝通知・週間レポート・月次ボーナスは無条件送信のまま変更なし` の行の直後）に、空行を挟んで次を追加する:

```text
> **追補 (2026-07-31)**: 全員達成の日も Discord には断り行付きで記録を送るよう変更した。LINE カウントの消費は 0 のままで、本節の見積もりに影響はない。詳細: `docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md`
```

- [ ] **Step 5: 変更内容を確認する**

Run: `git diff CLAUDE.md docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md`
Expected: 上記4箇所（`CLAUDE.md` 3箇所 + 既存設計書1箇所）のみが変更されていること

- [ ] **Step 6: コミットする**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md
git commit -m "docs: 夜通知の全員達成日をDiscordに記録する仕様を反映する"
```

---

### Task 5: DRY_RUN で実挙動を検証する

**Files:**
- 変更なし（検証のみ）

**Interfaces:**
- Consumes: Task 3 完了後の実装
- Produces: なし

- [ ] **Step 1: 全テストと lint を実行する**

Run: `npm test && npm run lint && npm run validate:all`
Expected: すべて PASS

- [ ] **Step 2: DRY_RUN で夜通知を実行する**

Run: `DRY_RUN=true node -r dotenv/config src/index.js`
Expected: 正常終了（終了コード0）。実行日の学習状況に応じて次のどちらかがログに出ること
- 全員達成: プレビュー本文の先頭に `ℹ️ 全員が本日のストリーク要件を達成したため、LINEには送らずDiscordのみに記録します(送信数節約)` があり、続いて `ℹ️ 全員達成のため、実行時はDiscordのみに送信します`
- 未達者あり: プレビュー本文に断り行がなく、`ℹ️ 実行時はLINEに送信します(失敗時はDiscordへ転送)`

`.env` が未整備で実行できない場合は、この Step の結果をユーザーに報告して判断を仰ぐ（`.env` を勝手に作らない）。

- [ ] **Step 3: 実行日の状況が片方だけだった場合、もう一方も確認する**

Step 2 で確認できなかった側は、`tests/index.test.js` の対応するテスト（「全員達成の日のDiscord本文には断り行が先頭に付く」／「未達ユーザーが1人でもいる日は夜通知を送信する」）が通っていることをもって検証済みとする。実サイトのデータを操作して条件を作らない。

- [ ] **Step 4: マージする**

```bash
git checkout main
git merge --no-ff feat/night-notification-discord-record -m "Merge branch 'feat/night-notification-discord-record'"
git push origin main
```

- [ ] **Step 5: CI の結果を確認する**

Run: `gh run list --limit 3`
Expected: push で起動した `CI` ワークフローが `success` になること。失敗していれば `gh run view <id> --log-failed` で原因を調べて修正する

---

## セルフレビュー結果

- **仕様カバレッジ**: 設計書の「変更内容」1〜4 はそれぞれ Task 1+2（`src/broadcast.js`）、Task 3（`src/index.js`）、Task 2+3（テスト）、Task 4（ドキュメント）が担当する。「検証」節は Task 5 が担当する。「エラー処理・エッジケース」の5項目は Task 2 Step 1（Discord失敗・Webhook未設定・切り詰め）、Task 3 Step 2（終了コード1・skipped・DRY_RUN）でテスト化されている。`dataReliable: false` は `hasUnqualifiedUser` の算出を変更しないため既存挙動が維持される
- **プレースホルダ**: なし。全ステップに実際のコードまたは実行コマンドを記載した
- **型・名前の一貫性**: `postToDiscord`（Task 1 で定義 → Task 2 で使用）、`broadcastToDiscordOnly`（Task 2 で定義 → Task 3 で使用）、`DISCORD_MAX_MESSAGE_LENGTH`（Task 2 で再エクスポート → Task 3 で使用）、`DISCORD_ONLY_NOTICE`（Task 3 で定義・使用）、`discordOnly` / `outgoingMessage`（Task 3 内で完結）。戻り値の `skipped` は Task 2 で `{ success: false, skipped: true, results: [] }` として定義し、Task 3 の結果判定と一致している
