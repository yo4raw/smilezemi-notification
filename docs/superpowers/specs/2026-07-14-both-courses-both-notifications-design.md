# 夜通知・朝通知の両コース対応 設計書

作成日: 2026-07-14

## 背景・目的

現状、コースごとに通知が分かれている。

- 夜通知(`src/index.js` / `crawler.yml`, JST 20:00): **小学生コース**の当日速報
- 朝通知(`src/morning-index.js` / `morning-crawler.yml`, JST 7:00): **中学生コース**の前日確定分

保護者から「夜通知でも中学生コースの当日速報を見たい」「朝通知でも小学生コースを見たい」という要望があり、**両方の通知が両コースを扱う対称形**に変更する。

## 現状のアーキテクチャ

| | 夜通知 `index.js` (20:00) | 朝通知 `morning-index.js` (7:00) |
|---|---|---|
| 対象 | 小学生コース(`courseFilter: 'elementary'`) | 中学生コース(`courseFilter: 'juniorHigh'`) |
| 対象日 | 当日(速報) + 前日(ストリーク確定用に追加クロール) | 前日のみ(確定データ) |
| ストリーク | 前日分で確定・当日は暫定+1表示・`streak_data.json`保存 | 前日分で確定・`streak_data.json`保存 |
| mission_data.json | 保存・差分比較あり | 保存なし |
| しきい値 | 単一(`STREAK_REQUIREMENTS.elementaryMissions` = 4) | 単一(`getJuniorHighRequirement(前日)` = 平日3/土日5) |

## 変更後のアーキテクチャ

両通知とも両コースを扱う。ストリークの**確定は朝通知に一本化**し、夜通知は表示専用にする。

| | 夜通知 `index.js` (20:00) | 朝通知 `morning-index.js` (7:00) |
|---|---|---|
| クロール | **当日・両コース**(速報) | **前日・両コース**(確定) |
| ストリーク | **表示のみ**(`streak_data.json`を読むだけ。確定・保存しない) | **両コースを確定・保存**(唯一の確定点) |
| mission_data.json | 保存・差分比較あり(従来通り) | 保存なし(従来通り) |
| しきい値 | コース別(小学生=4 / 中学生=当日曜日で3 or 5) | コース別(小学生=4 / 中学生=前日曜日で3 or 5) |

### ストリークの確定タイミング(重要)

- **夜通知 = 速報・暫定**: その日の実績から「今日この調子ならカウントされる」を暫定表示するのみ。`streak_data.json`は読むだけで書き換えない。表示は「確定済みストリーク +(当日しきい値達成なら暫定 +1)」。
- **朝通知 = 確定**: 前日の確定データでカウント/おたすけ消費/リセットを判定し `streak_data.json` を更新する。**唯一の確定点**。

タイムライン(ある日 D の学習分):

```
D日 20:00   夜通知 → 「今日D達成 → 暫定 N+1日目」と速報(未確定)
D+1日 7:00  朝通知 → 前日Dを確定 → streakをN+1に更新・保存
D+1日 20:00 夜通知 → 確定済みN+1を読み、D+1の暫定分を上乗せ表示
```

## 共通基盤の変更

### 1. クロールデータに `course` フィールドを追加 (`src/crawler.js`)

`getCourseData` が返す各ユーザーデータに `course: 'elementary' | 'juniorHigh'` を追加する。値は引数 `courseName`(明示時)、無ければ `isJuniorHighSchool(courseName, page)`(URLベース `/study/c/` 判定)から常に決定できる。

```js
// getCourseData 内
const course = isJuniorHighSchool(courseName, page) ? 'juniorHigh' : 'elementary';
return {
  success: true,
  data: {
    userName: displayName,
    course,           // 追加
    missionCount, date: dateString, studyTime, totalScore, missions, dataReliable
  },
  detailsAvailable
};
```

これがコース別しきい値・コース別ストリーク確定の土台になる。基本モードのフォールバック(`getAllUsersMissionCounts`)が返す v1.0 データには `course` は付かないが、そのパスはストリーク処理を行わないため問題ない。

### 2. コース別しきい値 (`src/notifier.js`)

`formatDetailedMessage` に新オプション `missionWarningThresholds: { elementary: number, juniorHigh: number }` を追加する。既存の単一数値オプション `missionWarningThreshold`(全ユーザー共通)は後方互換のため残す(既存テスト・単一コース利用のため)。両方指定時は `missionWarningThresholds` を優先。フォーマッタは各ユーザーの `course`(無ければ従来通り名前サフィックス `includes('中学生コース')` にフォールバック)で、しきい値・スコア単位(%/点)・ラベル(講座/ミッション)を選ぶ。

```js
const { missionWarningThresholds = null } = options;
// 各ユーザーのループ内:
const course = user.course || (user.userName.includes('中学生コース') ? 'juniorHigh' : 'elementary');
const isJuniorHigh = course === 'juniorHigh';
const threshold = missionWarningThresholds
  ? (isJuniorHigh ? missionWarningThresholds.juniorHigh : missionWarningThresholds.elementary)
  : null;
```

呼び出し元は `index.js` / `morning-index.js` の2箇所のみ。

### 3. ストリーク確定のコース別バッチ (`src/morning-index.js`)

前日データを `course` で分割し、`updateStreaks` をコース別のしきい値で2回呼んで結果をマージする。中学生は前日日付の曜日で `getJuniorHighRequirement(前日)` を使う。

```js
const elementaryData = crawlResult.data.filter(u => u.course === 'elementary');
const juniorHighData  = crawlResult.data.filter(u => u.course === 'juniorHigh');

const elemThreshold = STREAK_REQUIREMENTS.elementaryMissions;      // 4
const jhThreshold   = getJuniorHighRequirement(targetDates.dateString);

let users = previousStreakUsers;
const results = [];
for (const [data, threshold] of [[elementaryData, elemThreshold], [juniorHighData, jhThreshold]]) {
  const r = updateStreaks(users, data, targetDates.dateString, { minCompletedMissions: threshold });
  users = r.streakUsers;
  results.push(...r.results);
}
// users を保存、results から streaks 表示を構築
```

`updateStreaks` は入力を変更しない純粋関数で、`{ ...streakUsers }` を返すため、1回目の結果を2回目の入力に渡すチェーンで安全にマージできる。`streak.js` 自体の変更は不要。

## コンポーネント別の変更詳細

### 夜通知 `src/index.js`

1. 当日クロールの `courseFilter` を `'elementary'` → `null`(両コース)に変更。
2. **前日クロール・`updateStreaks`・`saveStreakData` を削除**(確定処理を朝へ移すため)。
3. ストリーク表示を「読み取り + 暫定」に変更:
   - `loadStreakData()` で現在の確定状態を読む(失敗時は従来通りエラー記録して空状態で続行)。
   - 各ユーザーについて `course` に応じたしきい値で当日学習判定し、`formatStreakInfo({ state, event: 'none' }, { todayStudied })` を生成。当日しきい値の中学生分は `getJuniorHighRequirement(getTargetDates(0).dateString)`。
   - `event: 'none'` 固定なので、milestone/bonus/grace/reset のイベント行は夜には出ない(確定は朝の責務)。
4. `formatDetailedMessage` に `missionWarningThresholds` を渡す。
5. `require('./streak')` の分割代入に `getJuniorHighRequirement` を追加(新規モジュールではないため `tests/index.test.js` の `MODULE_PATHS` 変更は不要)。
6. 対象ユーザー0件ガードのメッセージ文言を「小学生コースの対象ユーザーがいない」→「対象ユーザーがいない」に一般化。
7. mission_data.json の保存・差分は従来通り(対象が両コースに広がるだけ)。

### 朝通知 `src/morning-index.js`

1. 前日クロールの `courseFilter` を `'juniorHigh'` → `null`(両コース)に変更。
2. 上記「共通基盤 3」のコース別バッチ確定を適用。
3. `formatDetailedMessage` に `missionWarningThresholds`(小学生=4 / 中学生=前日曜日分)を渡す。`showNoStudyWarning: true` は両コースに適用(従来通り)。
4. `STREAK_REQUIREMENTS` を `require('./streak')` から追加 import。
5. mission_data.json は従来通り保存しない(前日=確定データのため差分不要)。

### ワークフロー (`.github/workflows/`)

処理コマンド(`node src/index.js` / `node src/morning-index.js`)は不変のため、YAMLの機能変更はない。可読性のため次を更新する:

- `morning-crawler.yml` の `name` を「スマイルゼミ 朝通知(中学生コース・前日分)」→「スマイルゼミ 朝通知(両コース・前日分)」等に更新。
- 両ファイル冒頭コメントの対象コース記述を実態に合わせる。

## エラー処理

既存パターンを踏襲する(新規の失敗系は増やさない)。

- クロール失敗時のグレースフルデグラデーション・エラー通知・スクリーンショット保存は現状のまま。
- 夜通知はストリークを確定・保存しないため、ストリーク保存失敗という失敗系が夜から消える(読み込み失敗時のみ従来同様に空状態で続行)。
- 朝通知のストリーク読み込み失敗時は従来通りエラー記録のうえ空状態で続行し、次回保存で自己修復。
- `dataReliable: false` のユーザーはコース別バッチでも従来通り誤確定をスキップ(`updateStreaks` 内の既存ロジックがそのまま働く)。

## テスト

- `tests/index.test.js`: 夜通知から前日クロール・`updateStreaks`・`saveStreakData` 呼び出しが消えることを反映。両コース混在の当日データで、コース別しきい値の暫定表示が出ることを検証。`require.cache` 注入モックの期待値(updateStreaks/saveStreakData が呼ばれない)を更新。
- `tests/morning-index.test.js`: 軽量(エクスポート確認)は維持。コース別バッチ確定の中核ロジックはできる限り純粋関数側(`updateStreaks` のチェーン)で検証する。
- `tests/streak.test.js`: `updateStreaks` を2回チェーンしたときにコース別しきい値で正しく確定され、入力が破壊されないことを確認するケースを追加。
- `notifier` のテスト: `missionWarningThresholds` によるコース別の警告出し分け(小学生4/中学生3or5)と単位(%/点)を検証。
- DRY_RUN での手動検証: `DRY_RUN=true node -r dotenv/config src/index.js` と `... src/morning-index.js` で両コースが1メッセージに出ること、夜が暫定/朝が確定になっていることをプレビューで確認。

## 既知のトレードオフ

- **朝通知が失敗した日は前日分が確定されない**。空白日として中立扱い(ペナルティなし・カウントもなし)。夜通知は表示専用でフォールバック確定をしないため、この日は取りこぼす。Option B 採用の唯一のトレードオフとして受容する。
- 本変更の初回夜通知では、mission_data.json に中学生コースの当日データが未登録のため、中学生ミッションが一度だけ「NEW」として差分表示される。一度きりのノイズとして受容する。

## 非対象(YAGNI)

- 中学生の当日データを夜通知で確定すること(=夜での二重確定)。冪等で安全だが責務が曖昧になるため行わない。
- コース別の表示順ソートやセクション見出しの追加。名前サフィックス「(小学生コース)/(中学生コース)」で判別可能なため不要。
- ワークフローのスケジュール・待機ロジックの変更。
- クローリングの並列化・高速化。

## 更新するドキュメント

- `CLAUDE.md`: 4エントリポイントの説明とストリーク仕様(夜=速報/朝=確定、両通知が両コース)を実態に合わせて更新。
