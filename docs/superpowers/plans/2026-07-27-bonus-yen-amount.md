# 月次ボーナス清算の金額表示 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 月次ボーナス清算の通知に、コース別単価（小学生 1P=¥30 / 中学生 1P=¥50）で換算した金額と合計を載せる。

**Architecture:** 変更は `src/monthly-bonus-index.js` の `formatMonthlyBonusMessage()` 1関数だけ。単価はファイル先頭の定数に置く。コース情報はストリークデータに存在しないため、既存の `src/notifier.js` と同じ慣例で `userName` の文字列から判定する。清算・リセットのロジックには触らない。

**Tech Stack:** Node.js >= 24 / CommonJS / Node.js built-in test runner / oxlint

## Global Constraints

- 設計仕様: `docs/superpowers/specs/2026-07-27-bonus-yen-amount-design.md`。判断に迷ったらこの spec が正
- 単価は **小学生コース 1ポイント = ¥30、中学生コース 1ポイント = ¥50**
- **清算・リセットのロジックを変更しない**。`src/streak.js` の `settleBonuses()`、`main()` のリセット条件・終了コード判定には一切触らない。今回変わるのは表示だけ
- **夜通知・朝通知のメッセージを変更しない**（`src/notifier.js` は触らない）
- モジュールシステムは CommonJS。追加の npm 依存を入れない
- コード内のコメント・ドキュメント・コミットメッセージは日本語で書く
- テストデータの子供の名前は架空名（たろう・はなこ・じろう）を使う。実名は使わない
- テストは `node --test`。単一ファイル実行は `node --test --test-force-exit --experimental-test-isolation=none tests/<file>` （オプション2つは必須）

---

### Task 1: 金額表示と合計行の追加

**Files:**
- Modify: `src/monthly-bonus-index.js`
- Test: `tests/monthly-bonus-index.test.js`

**Interfaces:**
- Consumes: `settleBonuses()` が返す `settlements`（`Array<{userName: string, bonus: number}>`。コース情報は含まない）
- Produces: `formatMonthlyBonusMessage(settlements, monthLabel) → string`（シグネチャは変更なし。出力内容のみ変わる）

- [ ] **Step 1: 失敗するテストを書く**

`tests/monthly-bonus-index.test.js` の一番外側の `describe('月次ボーナス清算 (src/monthly-bonus-index.js)', ...)` の中に、新しい describe ブロックとして追加する:

```js
  describe('formatMonthlyBonusMessage - 金額表示', () => {
    it('小学生コースは1ポイント30円で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ (小学生コース)', bonus: 2 }],
        '7月'
      );

      assert.match(message, /👤 はなこ \(小学生コース\): 2ポイント → ¥60/);
    });

    it('中学生コースは1ポイント50円で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう (中学生コース)', bonus: 3 }],
        '7月'
      );

      assert.match(message, /👤 たろう \(中学生コース\): 3ポイント → ¥150/);
    });

    it('0ポイントのユーザーも0円として表示する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'じろう (小学生コース)', bonus: 0 }],
        '7月'
      );

      assert.match(message, /👤 じろう \(小学生コース\): 0ポイント → ¥0/);
    });

    it('合計行に全ユーザーの金額の合算を出す', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [
          { userName: 'たろう (中学生コース)', bonus: 3 },
          { userName: 'はなこ (小学生コース)', bonus: 2 },
          { userName: 'じろう (小学生コース)', bonus: 0 }
        ],
        '7月'
      );

      // 3×50 + 2×30 + 0×30 = 210
      assert.match(message, /合計: ¥210/);
    });

    it('4桁の金額は3桁区切りで表示する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'たろう (中学生コース)', bonus: 31 }],
        '7月'
      );

      // 31×50 = 1550
      assert.match(message, /31ポイント → ¥1,550/);
      assert.match(message, /合計: ¥1,550/);
    });

    it('コース表記のないユーザーは小学生単価(¥30)で換算する', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ', bonus: 2 }],
        '7月'
      );

      assert.match(message, /👤 はなこ: 2ポイント → ¥60/);
    });

    it('対象ユーザーが0人なら合計行を出さない', () => {
      const message = mainModule.formatMonthlyBonusMessage([], '7月');

      assert.match(message, /対象のユーザーがいませんでした。/);
      assert.doesNotMatch(message, /合計:/);
    });

    it('支給の案内文と月ラベルは従来どおり残る', () => {
      const message = mainModule.formatMonthlyBonusMessage(
        [{ userName: 'はなこ (小学生コース)', bonus: 2 }],
        '7月'
      );

      assert.match(message, /💰 ボーナスポイント清算\(7月分\)/);
      assert.match(message, /お小遣いとして支給してね!/);
    });
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: FAIL。金額表示のケースが「2ポイント」までしか出力せず `→ ¥60` を含まないため落ちる。「支給の案内文と月ラベル」「0人なら合計行を出さない」の2件は現状でも PASS する

- [ ] **Step 3: 単価の定数を追加する**

`src/monthly-bonus-index.js` の require 群の直後に追加する:

```js
// ボーナスポイント1点あたりの金額(円)。コース別に単価が違う。
// 単価を変えるときはここだけを書き換える
const BONUS_POINT_YEN = {
  elementary: 30,
  juniorHigh: 50
};
```

- [ ] **Step 4: コース判定と金額計算のヘルパーを追加する**

`getPreviousMonthLabel()` の直後に追加する:

```js
/**
 * ボーナスポイントを金額(円)に換算する
 *
 * settleBonuses() が返す settlements にはコース情報が含まれず、ストリークデータにも
 * 保存されていないため、クローラーが組み立てた表示名からコースを判定する。
 * 判定方法は src/notifier.js と同じ慣例に揃えている(コース表記なしは小学生扱い)。
 *
 * @param {string} userName - 表示名(例: "はなこ (小学生コース)")
 * @param {number} bonus - ボーナスポイント数
 * @returns {number} 金額(円)
 */
function toBonusYen(userName, bonus) {
  const rate = userName.includes('中学生コース')
    ? BONUS_POINT_YEN.juniorHigh
    : BONUS_POINT_YEN.elementary;

  return bonus * rate;
}
```

- [ ] **Step 5: `formatMonthlyBonusMessage()` を書き換える**

既存の関数本体を以下に置き換える（JSDoc も更新する）:

```js
/**
 * 清算リストを通知メッセージに整形する
 *
 * ポイント数に加えて、コース別単価で換算した金額と全員分の合計を載せる。
 * 受け取る側がそのまま現金を渡せる状態にするため。
 *
 * @param {Array<{userName: string, bonus: number}>} settlements
 * @param {string} monthLabel - 例: "7月"
 * @returns {string}
 */
function formatMonthlyBonusMessage(settlements, monthLabel) {
  const lines = [`💰 ボーナスポイント清算(${monthLabel}分)`, ''];

  if (settlements.length === 0) {
    lines.push('対象のユーザーがいませんでした。');
    return lines.join('\n');
  }

  let totalYen = 0;

  settlements.forEach(settlement => {
    const yen = toBonusYen(settlement.userName, settlement.bonus);
    totalYen += yen;
    lines.push(`👤 ${settlement.userName}: ${settlement.bonus}ポイント → ¥${yen.toLocaleString('ja-JP')}`);
  });

  lines.push('');
  lines.push(`合計: ¥${totalYen.toLocaleString('ja-JP')}`);
  lines.push('ボーナスポイントはお小遣いとして支給してね!');

  return lines.join('\n');
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `node --test --test-force-exit --experimental-test-isolation=none tests/monthly-bonus-index.test.js`
Expected: PASS（新規8ケースと既存ケースの全部）

既存テストのうち `assert.match(message, /じろう \(小学生コース\): 2ポイント/)` のように「Nポイント」で終わる前提のアサーションがあれば、`→ ¥60` が続く形になっても正規表現は部分一致なので通る。もし行末を固定している（`$` を使っている）アサーションがあれば、金額表示を含む形に直すこと。

- [ ] **Step 7: 全テストと lint を通す**

Run: `npm test && npm run lint`
Expected: すべて PASS、lint エラーなし

- [ ] **Step 8: DRY_RUN でメッセージを目視確認する**

Run: `DRY_RUN=true node -r dotenv/config src/monthly-bonus-index.js`
Expected: プレビューに各ユーザーの `Nポイント → ¥M` と `合計: ¥M` が表示され、exit 0 で終了する。送信・リセットは行われない

（ローカルに `data/streak_data.json` がない場合は対象0人となり「対象のユーザーがいませんでした。」が出る。その場合は合計行が出ないことを確認すれば足りる）

- [ ] **Step 9: コミットする**

```bash
git add src/monthly-bonus-index.js tests/monthly-bonus-index.test.js
git commit -m "feat: 月次ボーナス清算に金額と合計を表示する

小学生コース1P=¥30、中学生コース1P=¥50でコース別に換算する。
コース情報はストリークデータにないため、既存のnotifier.jsと同じ慣例で
表示名の文字列から判定する。清算・リセットのロジックは変更していない。"
```

---

### Task 2: ドキュメント更新とマージ

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: `CLAUDE.md` を更新する**

`### ストリーク（連続学習日数）機能` 節の中にある、ボーナスポイントを説明している箇所を探す。現在は次の記述が含まれている:

```markdown
（満タン中はマイルストーン判定なし。`bonus`フィールド。リセットでも消えず、毎月1日の月次清算通知で0にリセットしてお小遣いとして支給）
```

この直後に続く形で、単価を明記する一文を同じ箇条書き内に足す:

```markdown
月次清算通知ではコース別単価（小学生コース 1P=¥30 / 中学生コース 1P=¥50）で金額に換算して表示する。単価は `src/monthly-bonus-index.js` の `BONUS_POINT_YEN` に集約
```

- [ ] **Step 2: 全検証を通す**

Run: `npm test && npm run lint && npm run validate:all`
Expected: すべて PASS

- [ ] **Step 3: コミットする**

```bash
git add CLAUDE.md
git commit -m "docs: ボーナスポイントのコース別単価をCLAUDE.mdに記載する"
```

- [ ] **Step 4: main にマージして push する**

```bash
git checkout main
git merge --no-ff feat/bonus-yen-amount -m "Merge branch 'feat/bonus-yen-amount'"
git push origin main
```

- [ ] **Step 5: CI を確認してブランチを削除する**

```bash
gh run list --limit 2
git branch -d feat/bonus-yen-amount
```
Expected: main への push で走った CI が success
