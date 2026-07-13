# 中学生コース: 曜日別ストリーク必要講座数(平日3・土日5)設計

日付: 2026-07-13
ステータス: 承認済み

## 目的

中学生コースのストリーク(連続学習日数)更新に必要な完了講座数を、固定値3から**曜日別(平日3・土日5)**に変更する。学校がある平日は3講座、時間に余裕のある土日は5講座を求めることで、学習量のバランスを取る。

## 要件

- 判定対象日(=学習した日。朝通知では前日)の曜日で必要講座数を決める
  - 土曜・日曜: 5講座
  - 月〜金曜: 3講座
- **祝日は考慮しない**(曜日のみで判定)。祝日データの保守を不要にするための意図的な割り切り
- 曜日はJSTのカレンダー日付(`dateString`: YYYY-MM-DD)から求める。実行環境のタイムゾーンに影響されないこと
- 朝通知の未達警告行(`⚠️ 講座完了 x/N個 …`)も同じ曜日別しきい値に追従する
- 小学生コース(完了ミッション4個)は変更しない

### 判定例

| 朝通知の実行日 | 判定対象日(前日) | 必要講座数 |
|---|---|---|
| 月曜 7:00 | 日曜 | 5 |
| 土曜 7:00 | 金曜 | 3 |
| 日曜 7:00 | 土曜 | 5 |

## 設計

### src/streak.js

- `STREAK_REQUIREMENTS` の形を変更:

  ```js
  const STREAK_REQUIREMENTS = {
    elementaryMissions: 4,                        // 小学生コース(変更なし)
    juniorHighCourses: { weekday: 3, weekend: 5 } // 中学生コース: 平日/土日
  };
  ```

- 純粋関数 `getJuniorHighRequirement(dateString)` を追加してエクスポートする
  - `dateString`(YYYY-MM-DD)を `Date.UTC` ベースで解釈し `getUTCDay()` で曜日を求める(YYYY-MM-DD はJSTのカレンダー日付なのでそのまま曜日を引ける。実行環境TZの影響を受けない)
  - 土曜(6)・日曜(0)なら `juniorHighCourses.weekend`、それ以外は `juniorHighCourses.weekday` を返す
- `isStudied` / `confirmDay` / `updateStreaks` のインターフェースは無変更(`minCompletedMissions` に数値を渡す方式のまま)

### src/morning-index.js

- `getJuniorHighRequirement(targetDates.dateString)` で判定対象日の必要講座数を求め、以下の2箇所に渡す:
  - `updateStreaks` の `{ minCompletedMissions }`
  - `formatDetailedMessage` の `missionWarningThreshold`
- 警告文はしきい値を動的に埋め込む既存実装のため、文言変更は不要

### 影響範囲

- `streak_data.json` にしきい値は保存されないため、データ移行は不要
- 夜通知(`src/index.js`)は `STREAK_REQUIREMENTS.elementaryMissions` のみ参照するため無変更
- 週次レポート・月次ボーナス清算は無関係

## テスト

- `tests/streak.test.js`:
  - `STREAK_REQUIREMENTS` の形状テストを新形式(`juniorHighCourses.weekday` / `.weekend` が正の整数)に更新
  - `getJuniorHighRequirement` のテストを追加: 金曜(2026-07-10)→3、土曜(2026-07-11)→5、日曜(2026-07-12)→5、月曜(2026-07-13)→3
- `tests/index.test.js`: モックの `STREAK_REQUIREMENTS` を実物と同じ形に更新(`index.js` は `elementaryMissions` のみ使用のため動作影響なし)
- `tests/notifier.test.js`: `missionWarningThreshold` は数値を受け取る既存インターフェースのまま変更不要

## エラーハンドリング

- 既存のグレースフルデグラデーション方針を踏襲。`getJuniorHighRequirement` は純粋関数で例外を投げない(不正な日付文字列は想定外だが、`getTargetDates` が常に正しいYYYY-MM-DDを返す前提)

## ドキュメント

- `CLAUDE.md` のストリーク仕様記述「中学生コースは完了講座3個以上」を「平日3個・土日5個(祝日は曜日のみで判定)」に更新
