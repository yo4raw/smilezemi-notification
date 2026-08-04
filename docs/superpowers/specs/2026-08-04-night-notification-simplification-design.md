# 夜通知の簡素化と未達警告の強調 設計書

作成日: 2026-08-04

## 背景

夜通知（`src/index.js`、JST 20:00）は当日の速報として、ストリーク行（連続学習日数・おたすけ・ボーナス）と勉強時間を表示している。しかしこれらはいずれも翌朝の朝通知（`src/morning-index.js`、JST 7:00）が前日確定分として表示するため、夜に出す必要がない。

夜通知に残すべき価値は「このままだと今日の記録更新に届かないユーザーがいる」と夜のうちに気づかせることであり、これは未達警告行が担っている。現状の警告行は先頭が `⚠️` の1行だけで目立たない。

## 目的

1. 夜通知からストリーク行と勉強時間行を削除し、当日の学習内容の速報に純化する
2. 未達警告行を目立つ見た目に変え、文言から「連続学習」への言及を外す
3. 朝通知は確定報告なので、同じ警告行を過去形の文言にする

## 変更内容

### 夜通知のメッセージ構成

削除するもの:

- ストリーク行（`🔥 連続学習: 20日目  🛟 おたすけ: 3/3  💰 ボーナス: 2P`）
- 勉強時間行（`⏱️ 勉強時間: 00:13`）

残すもの: 学習件数行、未達警告行（文言変更）、ミッション詳細。

変更後の例:

```text
📊 スマイルゼミ 学習状況

👤 たろうさん
✅ 学習2件（ミッション0・自主2）
🚨🚨 あと2件! がんばろう! 🚨🚨

📋 ミッション詳細:
  ・6級 3 つの かずの けいさん: 90点（NEW）（自主） ✨
  ・国語テスト(2年生：夏): 20点（NEW）（自主） ✨

👤 はなこさん
✅ 学習5件（ミッション2・自主3）

📋 ミッション詳細:
  ・…
```

### 朝通知のメッセージ構成

ストリーク行・勉強時間行はそのまま残す。未達警告行の文言だけを過去形にする。

```text
😢😢 あと2件たりなかった… 😢😢
```

### `formatDetailedMessage()` のインターフェース

`src/notifier.js` の `options` に2つ追加する。

| オプション | 型（既定値） | 夜通知 | 朝通知 |
| --- | --- | --- | --- |
| `showStudyTime` | boolean（`true`） | `false` | 指定なし |
| `missionWarningStyle` | `'today'` / `'past'`（`'past'`） | `'today'` | `'past'` |

ストリーク行は既存仕様として `streaks` を渡さなければ出力されない。夜通知は `streaks` を渡すのをやめるだけでよく、関数側の変更は不要。

警告文言は定数テーブルで2種類を持つ。

```js
const MISSION_WARNING_STYLES = {
  today: remaining => `🚨🚨 あと${remaining}件! がんばろう! 🚨🚨`,
  past: remaining => `😢😢 あと${remaining}件たりなかった… 😢😢`
};
```

`remaining` は `しきい値 - 完了数`。新文言はコースごとの単位ラベル（小学生=「学習」/中学生=「講座」）を含まないため、警告行のコース別出し分けは不要になる。警告を出すかどうかの条件（`dataReliable !== false`、朝の完全未学習日は出さない）は現状のまま変更しない。

トレードオフとして、新文言では完了数としきい値（`2/4件`）が消える。直上の学習件数行と「あと◯件」から読み取れるため、目立たせることを優先した。

### `src/index.js` の簡素化

夜通知はストリーク行を出さなくなるため、`streak_data.json` を一切読まなくなる。

- `loadStreakData` / `formatStreakInfo` / `createInitialState` の require とストリーク読み込みブロックを削除する
- LINE送信の可否を決める `hasUnqualifiedUser` は `isStudied()` と `getRequirementForCourse()` だけで算出できるため維持する（ストリーク状態は不要）
- `formatDetailedMessage()` の呼び出しから `streaks` を外し、`showStudyTime: false` と `missionWarningStyle: 'today'` を渡す

副作用として、ストリークデータ読み込み失敗時に `errors` へ積む経路が夜通知から消える。ストリークの確定・保存は元から朝通知だけが行うため、ストリーク値の挙動は変わらない。

### `src/morning-index.js`

`formatDetailedMessage()` の呼び出しに `missionWarningStyle: 'past'` を追加する。ストリークの確定・保存ロジックとその他の表示は変更しない。

## 影響範囲

| ファイル | 変更 |
| --- | --- |
| `src/notifier.js` | `showStudyTime` / `missionWarningStyle` オプション追加、警告文言テーブル追加 |
| `src/index.js` | ストリーク読み込み削除、`formatDetailedMessage()` の引数変更 |
| `src/morning-index.js` | `missionWarningStyle: 'past'` を追加 |
| `tests/notifier.test.js` | 新オプションのテスト追加、既存の警告文言アサーション更新 |
| `tests/index.test.js` | `streaks` を渡さないことの検証に反転 |
| `CLAUDE.md` | 日次通知の説明を更新 |

LINE送信数への影響はない。夜にLINEを送る条件（当日のストリーク要件未達のユーザーが1人でもいる日）は変更しない。

## テスト方針

`tests/notifier.test.js`:

- `showStudyTime: false` で勉強時間行が出ないこと、省略時は従来どおり出ること
- `missionWarningStyle: 'today'` で `🚨🚨 あと2件! がんばろう! 🚨🚨` が出ること
- `missionWarningStyle: 'past'` で `😢😢 あと2件たりなかった… 😢😢` が出ること
- 小学生コースと中学生コースで警告文言が同一になること
- 既存の「4件完了しないと連続学習にカウントされないよ」を検証する2箇所（585行付近・971行付近）を新文言に更新

`tests/index.test.js`:

- `formatDetailedMessage()` に `streaks` が渡されないこと（既存の2件を反転）
- `showStudyTime: false` と `missionWarningStyle: 'today'` が渡されること
- 全員達成／未達ユーザーありでの送信先の切り替えが従来どおり動くこと

`tests/morning-index.test.js` はエクスポート確認のみの軽量パターンのため変更しない。

実行確認は `DRY_RUN=true node -r dotenv/config src/index.js` と `DRY_RUN=true node -r dotenv/config src/morning-index.js` のプレビュー出力で行う。

## 関連ドキュメント

- `docs/superpowers/specs/2026-07-13-streak-notification-design.md`
- `docs/superpowers/specs/2026-07-26-line-quota-reduction-design.md`
- `docs/superpowers/specs/2026-07-31-night-notification-discord-record-design.md`
