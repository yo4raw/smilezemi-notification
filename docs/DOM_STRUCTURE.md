# みまもるネット DOM構造リファレンス

実サイトをクロールして確認したDOM構造の記録。**毎回クローリングして調べ直さなくて済むように**、
画面構成・クラス名・データの粒度をここに集約する。

- 調査日: 2026-07-30
- 調査方法: Playwright (headless Chromium) で実ログインし、各画面のHTML・スクリーンショット・
  クラス出現頻度をダンプして解析
- 注意: クラス名は CSS Modules のハッシュ付き（`root__HlHQq` 等）。ハッシュはビルドで変わりうるため、
  実装では `[class*="dailyTimeline__"]` のような前方一致セレクタを併用する

---

## 1. 画面構成とURL

### 小学生コース

| タブ | サブタブ | URL |
| --- | --- | --- |
| とりくみ | 日々のとりくみ | `/mimamoru-net/ui/study/s/timeline` |
| とりくみ | 指導レポート | （未調査） |
| 学習のきろく | 月の学習 | `/mimamoru-net/ui/study/s/history` |
| 学習のきろく | コアトレ | `/mimamoru-net/ui/study/s/history/core-training` |
| 学習のきろく | 英語プレミアム | `/mimamoru-net/ui/study/s/history/eigo-premium` |
| 成績 | 学力診断テスト / 英語プレミアム | `/mimamoru-net/ui/study/s/...` |

### 中学生コース

| タブ | サブタブ / カード | URL |
| --- | --- | --- |
| 取り組み | 日 | `/mimamoru-net/ui/study/c/timeline` |
| 取り組み | 週 | `/mimamoru-net/ui/study/c/timeline/weekly` |
| 取り組み | 月 | `/mimamoru-net/ui/study/c/timeline/monthly` |
| 学習進捗 | （ハブ画面） | `/mimamoru-net/ui/study/c/history` |
| 学習進捗 | 通常学習 | `/mimamoru-net/ui/study/c/normal-study` |
| 学習進捗 | 定期テスト対策 | `/mimamoru-net/ui/study/c/periodic-exam` |
| 学習進捗 | 季節講習 | `/mimamoru-net/ui/study/c/seasonal-course` |
| 学習進捗 | つまずき解析 | `/mimamoru-net/ui/study/c/solving-analyze` |
| 成績/対策 | （ハブ画面） | `/mimamoru-net/ui/study/c/achievement` |
| 成績/対策 | 確認テスト | `/mimamoru-net/ui/study/c/normal-exam` |
| 成績/対策 | 模擬テスト | `/mimamoru-net/ui/study/c/exam/scores` |
| 成績/対策 | 英検・模擬テスト | `/mimamoru-net/ui/study/c/eiken` |

**中学生コースにコアトレ画面は存在しない。** `/study/c/history/core-training` を直接叩いても
`/study/c/timeline` にリダイレクトされる。

これらのサブ画面は SPA で、URL を直接 `goto` すると要素が描画されないことがある。
調査時はタイムラインから開始してタブ → カードの順にクリックして辿ること。
またカードのテキストは `page.getByText(名前, { exact: true })` で掴む
（`text="模擬テスト"` 形式のセレクタでは掴めないケースを確認）。

---

## 2. 小学生コース タイムライン (`/study/s/timeline`)

### 2.1 全体構造

```text
[class*="dailyTimeline__"]          ← 1日分のブロック（実装確認: dailyTimeline__oIL1z）
├── .overview__ZOgz1                ← 左カラム（日付・スター・学習時間・写真）
│   ├── .date__gE2Ua                ← "07/30(木)"
│   │   ├── div > span "07/" + span.day__MnysY "30"
│   │   └── .weekday__mSB07 "(木)"
│   ├── .totalStar__PIFEA           ← その日のスター獲得数 "2"
│   ├── .totalStudyTime__ZyyiE
│   │   ├── .clockIcon__jepzZ
│   │   └── .minute__SnMnp          ← "15分"（★スターアプリの時間は含まない）
│   └── .picture__E29Xg > .cameraIcon__G9PD7 (または .grayCameraIcon__gCvkz)
└── [class*="courseList__"]         ← その日の学習行リスト（実装確認: courseList__GXznJ）
    ├── .root__HlHQq                ← 通常の学習行（1件 = 1講座）
    └── .root__OF9o7                ← アコーディオン行（スターアプリ）
```

**日ブロックが構造として分離されている**ため、日付ごとの切り分けに boundingBox の Y座標計算は不要。
`src/crawler.js` の `extractElementaryDay()` はこの日ブロック単位で切り分けている。

タイムラインは**直近7日分**を保持する。スクロールしても8日目以降は読み込まれない。

### 2.2 通常の学習行 `.root__HlHQq`

```text
.root__HlHQq
└── .root__AaQDD
    ├── .subjectIcon__JFcsG <教科>__<hash>   ← 教科アイコン
    ├── .courseNameColumn__UNbOx
    │   ├── .subIcon__p_BWc                  ← バッジ枠（常に存在。空のこともある）
    │   │   └── .missionIcon__i6nW8 > span "ミッション"   ← ★ミッションのときだけ存在
    │   │   （NEWラベルもここに入り "NEWミッション" となる）
    │   └── .title__C3bzF > span.limit2Line__abeiB  ← 講座名
    └── .commonStudyResult__FRu0M
        ├── 点数系（どちらか）
        │   ├── .score__vyJrX                       ← 点数タイプ
        │   │   ├── .scoreLabel__LpVbL "前回 93点" / "目標80点"
        │   │   └── span.scoreNumber__g3fIK "93" + span.scoreUnit__pS3U4
        │   └── span.correctAnswerCount__P56lT "9" + span.questionCount__tnMz1 "/10"
        │                                            ← 正答数タイプ（ミニテスト等）
        └── .studyTime__OoPAn "1分"
```

教科アイコンの修飾クラス（確認済み）:
`kokugo__sllgI`(国語) / `sansu__dGqba`(算数) / `rika__uCK2v`(理科) / `shakai__TaCla`(社会) /
`kanken___nhws`(漢検ドリル) / `calc__CAxeI`(計算ドリル)

### 2.3 ミッション行と非ミッション行の見分け方

**行内に `[class*="missionIcon__"]` があるかどうか**が唯一の判定材料。

| 例 | ミッションバッジ | 学習結果 |
| --- | --- | --- |
| 「こそあど言葉」 | あり | 93点 / 1分 |
| 「8級 同じ漢字の読み」 | あり | 目標80点 → 90点 / 7分 |
| 「漢字のミニテスト」 | **なし** | 9/10 / 5分 |
| 「ふしぎ探検 世界遺産」 | **なし**（NEWのみ） | 4分 |

同じ講座名でも、ミッションとして配信されればバッジが付き、子どもが自主的に選べば付かない
（例: 「漢字のミニテスト」はユーザーによってバッジ有無が分かれた）。

`src/crawler.js` の `extractElementaryDay()` は行ごとにこのバッジの有無を見て `isMission` を立て、
`summarizeStudyRows()` がミッションと自主学習の両方を `studyItemCount` として数える。
ストリーク判定はこの `studyItemCount` を使う。

### 2.4 スターアプリ行 `.root__OF9o7`（アコーディオン）

```text
.root__OF9o7
└── .accordionRoot__g3IEV.accordion__n5GUk
    ├── .summary__AaZLV                     ← クリックで開閉
    │   └── .summaryRoot__KwUcW.summary__HqYvZ
    │       ├── .summaryContent__cQJX_ > .caption__x2_6H
    │       │   ├── .subjectIcon__bw6DF > .star___INn6
    │       │   ├── .courseName___o4rB > span "スターアプリ"
    │       │   └── .studyResult__h3Wtk
    │       │       └── span.studyResultNumber__hB0X_ "29" + span.studyResultUnit__TsaTy "分"
    │       └── .iconSpace__UFHF_ > svg      ← 開閉シェブロン
    └── .details__CKayM                      ← 初期状態は空。クリック後に描画される
        └── .starAppList__RhTW4
            └── .starAppResultRow__SL2SZ (×アプリ数)
                ├── .starAppName__KAgPg "ハムなかまっちならべ～"
                └── .starAppTime__XK_uC "9分"
```

- 合計時間（例: 29分）は**閉じたままでも** `.studyResultNumber__hB0X_` から取れる
- アプリ別内訳は `.summary__AaZLV` をクリックしないと DOM に存在しない
- **左カラムの `.minute__SnMnp`（例: 15分）にスターアプリの時間は含まれない。** つまり
  「学習時間15分・スターアプリ29分」の日は、実際の端末利用は44分

---

## 3. 中学生コース タイムライン (`/study/c/timeline`)

```text
.dailyRoot__a754V                    ← 1日分（学習ゼロの日はブロックごと存在しない）
├── .studyDate__GL9tf
│   └── .studyDateInner__s0Jtj
│       ├── .date__FKSSm > div "7/28(火)"   ← ★ゼロパディングなし
│       ├── .timeIcon__DA1S6
│       └── div > span "15分"                ← その日の合計学習時間
└── .subjects__eHK8S
    └── .subject__bWHro (×教科数)
        ├── .summary__raEvD <教科>__<hash>
        │   ├── .name__TRpmJ.limit2Line__ytOut > span "数学"
        │   ├── span "時間"
        │   └── div > span.time__Pn3gb "6" + span "分"
        └── .courses__hoi9b
            └── .course__KrAEA (×講座数)
                └── .courseRoot__ZkWpA
                    ├── .name__nAtRj      ← 講座名
                    └── .current__PxOK0   ← 学習結果 "75%" / "ワーク" / "100%"
```

教科の修飾クラス: `mat__UGFXH`(数学) / `eng__MSBwV`(英語) / `jpn__xAsi2`(国語) /
`sci__aLibx`(理科) / 社会・英検も同様のパターン

日ブロックは**学習した日にしか存在しない**（未学習日は行ごと消える）。保持は直近5日程度で、
スクロールしても増えない。

### 中学生コースには「ミッション」概念がない

タイムラインに載る行はすべて学習実績で、ミッションバッジに相当する要素は存在しない。
教科欄には通常5教科のほか「英検」なども現れる（`7/27` の例: 数学・社会・英検）。
つまり**中学生コースは既に「ミッション以外の学習」も含めて取得できている**。

学習結果の表記バリエーション: `75%` / `100%` / `ワーク` / `目標80.0点中39.1点` /
`初回:71%`（反復時） / `詳細`（確認テスト。クリックで `/study/c/normal-exam` へ遷移）

タイムラインに現れる講座の種類（実測）: 通常講座、`トレーニング`、`ワーク`、`スピーキング`、
`確認テスト:`、`ちょいと確認:`、`ステップアップ:`、`漢字：`、英検の級別講座。
**確認テストもタイムラインに載る**（`7/25` 理科「確認テスト:地震」、
`7/26` 社会「確認テスト:世界の人々の生活」）。

---

## 4. タイムライン以外の画面のデータ粒度

日次のストリーク判定に使えるかどうかの観点で整理する。

| 画面 | 取れるもの | 日別か |
| --- | --- | --- |
| 小学生 とりくみ>日々のとりくみ | 講座ごとの学習行・時間・点数、スターアプリ | **日別（7日分）** |
| 小学生 学習のきろく>月の学習 | 今月の学習日数 (27日/31日)、1日平均学習時間、受講講座数、日別グラフ | 集計値。グラフはSVGで数値抽出が要調査 |
| 小学生 学習のきろく>コアトレ | ステージ、レベル、**週間学習数**(7/27〜8/2)、分野別累計学習数 | **日別データなし** |
| 小学生 学習のきろく>英語プレミアム | 覚えた語句数、Lesson進捗 | **日別データなし** |
| 中学生 取り組み>日 | 教科ごとの講座・時間（確認テスト等も含む） | **日別（学習した日のみ、直近5日程度）** |
| 中学生 取り組み>週 | 初めて取り組んだ講座数、復習講座数、週合計時間、教科別時間、講評文 | 週次 |
| 中学生 取り組み>月 | 教科別の取り組み目安 (56/51 等) | 月次 |
| 中学生 学習進捗>通常学習 | 教科書の章・節ごとの進捗（`P. 20 - 28` / `目標 Clear`） | 日別データなし |
| 中学生 学習進捗>定期テスト対策 | 試験日、テスト結果（手入力）、教科別の出題範囲 | 日別データなし |
| 中学生 学習進捗>季節講習 | 夏期講習等の講座一覧と `未着手` / 学習結果 | 日別データなし |
| 中学生 学習進捗>つまずき解析 | 単元ごとの `実施日：26/6/24` と `対策に取り組んだ日：26/6/25` | **日付あり**（数学のみ） |
| 中学生 成績/対策>確認テスト | 単元ごとの `実施日：26/7/20` と正答率 | **日付あり** |
| 中学生 成績/対策>模擬テスト | 点数と対策 / 偏差値推移 / 合格判定 | **未受験のため構造不明** |
| 中学生 成績/対策>英検・模擬テスト | 英検の級別結果 | **未受験のため構造不明** |

**コアトレはみまもるネット上で日別に取得できない。** 週間学習数のスナップショットを
実行ごとに保存して差分を取る以外に、日単位で「コアトレをやったか」を知る方法はない。

**確認テスト・つまずき解析の対策は、タイムラインにも講座行として載る。**
専用画面は過去分の一覧・正答率を持つが、日次の学習検出という観点ではタイムラインで足りる。

**模擬テスト・英検模擬テストは 2026-07-30 時点で未受験**（「模擬テストを受けると表示されます」）。
受験後にタイムラインへ講座行として載るかは未検証。他のテスト系（確認テスト）が載っている以上
載る可能性が高いが、実受験後に確認すること。

---

## 5. 調査の再現方法

`.env` に認証情報がある前提で、Playwright を直接叩くスクリプトを書いて調べる。

```js
const { chromium } = require('playwright');
const { loadConfig } = require('./src/config');
const { login } = require('./src/auth');
const crawler = require('./src/crawler');

const config = loadConfig();                       // 戻り値は SMILEZEMI_USERNAME 等のフラット構造
const browser = await chromium.launch({ headless: true });
const { page } = await login(browser, {
  username: config.SMILEZEMI_USERNAME,
  password: config.SMILEZEMI_PASSWORD
});
const users = (await crawler.getUserList(page)).users;
await crawler.switchToUser(page, users[0].name);
await page.keyboard.press('Escape');               // サイドバーが開いたままだと innerText に混ざる
```

調査のコツ:

- `document.body.innerText` を落とすと画面の全体像が最速で掴める。ただしサイドバーが開いていると
  メニュー項目（「みまもるトーク」「ログアウト」等）が先頭に混ざるので Escape で閉じてから取る
- クラス名の当たりを付けるには、全要素の `classList` を集計して出現頻度を見る
- 構造を知りたいときは HTML を保存し、`page.setContent()` でオフライン再読込して解析すると
  実サイトへの再アクセスが要らない
- ユーザー名は実名なので、ドキュメント化する際はマスクするか架空名に置き換える

---

## 6. 現行実装との対応

| 現行コード | 本ドキュメントとの関係 |
| --- | --- |
| `src/config/selectors.js` の `elementaryTimeline` | §2 の構造に対応。すべて前方一致セレクタ |
| `src/config/selectors.js` の `juniorHighTimeline` | §3 の構造と一致（確認済み） |
| `src/crawler.js` の `extractElementaryDay()` | §2.1〜2.4。`dailyTimeline__` 単位で日を切り分け、行を分類する |
| `src/crawler.js` の `summarizeStudyRows()` | §2.3 のミッション/自主の分類を集計する純粋関数 |
| `src/streak.js` の `countStudyItems()` | 学習件数（ミッション＋自主）でストリークを判定する |
