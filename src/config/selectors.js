/**
 * DOMセレクタ定義
 *
 * 調査日: 2025-12-25
 * 調査方法: 実サイトをPlaywrightで調査
 */

module.exports = {
  // ログインページのセレクタ
  login: {
    url: 'https://smile-zemi.jp/mimamoru-net/ui/login',
    usernameField: 'input[name="userId"]',       // type="email"
    passwordField: 'input[name="password"]',     // type="password"
    submitButton: 'button:has-text("ログイン")'
  },

  // 待機戦略設定
  waitStrategies: {
    pageLoad: 'domcontentloaded',
    timeout: 60000,  // 60秒

    // ユーザー切り替え後の待機時間
    userSwitchDelay: 3000,

    // 追加の安定化待機
    stabilizationDelay: 1000,

    // タイムライン日付要素の表示待ち上限
    timelineDateTimeout: 3000,

    // コース選択画面の再表示待ち上限（旧固定待機 2000ms 以上）
    courseSelectionAppearTimeout: 5000
  },

  // サイドバー / ユーザー切り替えUIのセレクタと待機設定
  // 追加日: 2026-06-10 (固定待機の条件ベース化対応)
  sidebar: {
    // サイドバー表示の判定に使うヘッダー
    childrenHeader: 'text="お子さま"',
    // ユーザーエリアクリックで誤ってプロフィールページへ遷移した場合の検出
    profileSettings: 'text="プロフィール設定"',
    // サイドバー表示待ちの上限（旧固定待機 2000-3000ms 以上）
    openTimeout: 10000,
    // メニュー展開後にユーザー名が現れるまでの上限（旧固定待機 2000ms 以上）
    menuItemTimeout: 5000
  },

  // コース選択のセレクタ
  // DOM調査日: 2026-01-16
  courseSelection: {
    // ユーザー選択後に表示されるコース選択画面
    juniorHighSchool: 'text="中学生コース"',
    elementarySchool: 'text="小学生コース"',
    // コース選択確認用の待機時間
    courseSelectionWaitTime: 2000
  },

  // 小学生コース タイムラインのセレクタ
  // DOM調査日: 2026-07-30 (docs/DOM_STRUCTURE.md 参照)
  // 日ブロックが構造として分離されているため、Y座標計算は不要
  // クラス名は CSS Modules のハッシュ付きのため、すべて前方一致で指定する
  elementaryTimeline: {
    dayBlock: '[class*="dailyTimeline__"]',       // 1日分のブロック
    dateLabel: '[class*="date__"]',               // 日ブロック内の日付 "07/30(木)"
    totalStudyTime: '[class*="totalStudyTime__"] [class*="minute__"]', // "15分"
    courseList: '[class*="courseList__"]',        // 学習行リスト
    accordion: '[class*="accordionRoot__"]',      // スターアプリ行(カウント対象外)
    missionBadge: '[class*="missionIcon__"]',     // ミッションバッジ
    courseTitle: '[class*="title__"]',            // 講座名
    scoreNumber: '[class*="scoreNumber__"]',      // 点数タイプ "93"
    correctAnswerCount: '[class*="correctAnswerCount__"]', // 正答数タイプ "9"
    questionCount: '[class*="questionCount__"]'   // 正答数タイプ "/10"
  },

  // 中学生コース タイムラインのセレクタ
  // DOM調査日: 2026-04-02 (Playwrightで実サイト調査)
  // 中学生コースのURL: /study/c/timeline（小学生コースの /study/s/timeline とは別UI）
  juniorHighTimeline: {
    dailyRoot: '.dailyRoot__a754V',      // 1日分のブロック
    dateLabel: '.date__FKSSm',           // 日付 "07/30(木)"
    studyDateInner: '.studyDateInner__s0Jtj', // 日付の下の勉強時間 "6分"
    subjectGroup: '.subject__bWHro',     // 教科ごとのグループ
    subjectName: '.name__TRpmJ',         // 教科名 "数学"
    course: '.course__KrAEA',            // 講座1件
    courseName: '.name__nAtRj',          // 講座名 "いろいろな図形"
    courseResult: '.current__PxOK0'      // 結果 "66%"
  }
};
