# DOM Selector Investigation

## 目的
みまもるネットの実際のDOM構造を調査し、セレクタを定義する。実装前にこのドキュメントを完成させること。

## 調査対象ページ

### 1. ログインページ
**URL**: `https://smile-zemi.jp/mimamoru-net/ui/login`

**調査項目**:
- [x] ユーザー名入力フィールド
  - セレクタ候補: `input[name="username"]`, `#username`, `input[type="text"]`
  - **実際のセレクタ**: `input[name="userId"]`
  - **type属性**: `email`
  - **class**: `input__CJbG6`
  - **補足**: username ではなく userId という name 属性を使用

- [x] パスワード入力フィールド
  - セレクタ候補: `input[name="password"]`, `#password`, `input[type="password"]`
  - **実際のセレクタ**: `input[name="password"]`
  - **type属性**: `password`
  - **class**: `input__CJbG6 passwordInput__YtsUi`

- [x] ログインボタン
  - セレクタ候補: `button[type="submit"]`, `input[type="submit"]`, `.login-button`
  - **実際のセレクタ**: `button:has-text("ログイン")`
  - **補足**: テキストベースのセレクタが最も安定

- [x] ログイン状態保持チェックボックス
  - **実際のセレクタ**: `input[name="rememberMe"]`
  - **type属性**: `checkbox`
  - **class**: `input__O94L9`
  - **補足**: オプション機能

- [ ] ログイン後URL確認
  - ログイン成功時のURL: _（要再調査：初回ログイン時URLが変わらず）_
  - リダイレクト先: _（要再調査）_
  - **課題**: 認証情報での自動ログインが失敗した可能性

### 2. 学習状況ページ
**URL**: _（ログイン後のURL、調査後記入）_

**調査項目**:
- [ ] ユーザー選択UI（画面右上）
  - セレクタ候補: `.user-selector`, `select[name="user"]`, `#user-select`
  - 実際のセレクタ: _（調査後記入）_
  - UIタイプ: ドロップダウン / ボタン / その他（_記入_）

- [ ] ユーザー名取得
  - ユーザー一覧のセレクタ: _（調査後記入）_
  - 各ユーザー名のセレクタ: _（調査後記入）_
  - ユーザーID取得方法: data属性 / テキスト / その他（_記入_）

- [ ] 当日日付の学習日要素
  - 日付表示形式: `YYYY-MM-DD` / `YYYY/MM/DD` / その他（_記入_）
  - 日付要素のセレクタ: _（調査後記入）_
  - 当日データ特定方法: _（調査後記入）_

- [ ] ミッション数表示要素
  - セレクタ候補: `.mission-count`, `[data-mission]`, `.completed-missions`
  - 実際のセレクタ: _（調査後記入）_
  - 表示形式: `5ミッション` / `5` / その他（_記入_）
  - 数値抽出方法: _（調査後記入）_

### 3. ページ読み込み待機
- [ ] DOM読み込み完了判定
  - 待機戦略: `waitForLoadState('networkidle')` / `waitForSelector()` / その他
  - タイムアウト設定: _（ms、調査後記入）_

- [ ] ユーザー切り替え後の待機
  - ページ更新検出方法: _（調査後記入）_
  - 安定判定条件: _（調査後記入）_

## 調査手順

### ステップ1: Docker環境準備
```bash
# .envファイル作成（.env.exampleをコピー）
cp .env.example .env

# 実際の認証情報を.envに記入
# SMILEZEMI_USERNAME=実際のユーザー名
# SMILEZEMI_PASSWORD=実際のパスワード
# LINE_CHANNEL_ACCESS_TOKEN=（まだ不要）
# LINE_USER_ID=（まだ不要）
```

### ステップ2: Playwrightで手動調査
```bash
# Playwrightインストール
npm install playwright
npx playwright install chromium

# デバッグモードでブラウザ起動
npx playwright codegen https://smile-zemi.jp/mimamoru-net/ui/login
```

### ステップ3: セレクタ記録
1. Playwright Inspectorでログインフォーム要素を検査
2. 各セレクタを記録（上記「調査項目」に記入）
3. ログイン後の学習状況ページでも同様に検査
4. スクリーンショットを保存（`screenshots/investigation/`）

### ステップ4: セレクタ検証
```javascript
// 簡易検証スクリプト例
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // ログインページ
  await page.goto('https://smile-zemi.jp/mimamoru-net/ui/login');

  // セレクタテスト
  const usernameField = await page.locator('実際のセレクタ');
  console.log('Username field found:', await usernameField.isVisible());

  // ... 他のセレクタもテスト

  await browser.close();
})();
```

## セレクタ定義ファイル作成

調査完了後、以下のファイルを作成：

### `src/config/selectors.js`
```javascript
module.exports = {
  login: {
    usernameField: '実際のセレクタ',
    passwordField: '実際のセレクタ',
    submitButton: '実際のセレクタ',
    successUrl: '実際のURL'
  },
  dashboard: {
    userSelector: '実際のセレクタ',
    userListItem: '実際のセレクタ',
    currentDate: '実際のセレクタ',
    missionCount: '実際のセレクタ'
  },
  waitStrategies: {
    pageLoad: 'networkidle',
    timeout: 30000, // ms
    userSwitchDelay: 2000 // ms
  }
};
```

## DOM構造メモ

### ログインページ構造
```html
<!-- 2025-12-25 調査結果 -->
<!-- ユーザー名フィールド -->
<input class="input__CJbG6"
       enterkeyhint="send"
       type="email"
       name="userId"
       style="">

<!-- パスワードフィールド -->
<input class="input__CJbG6 passwordInput__YtsUi"
       enterkeyhint="send"
       type="password"
       name="password"
       style="margin: 0px;">

<!-- ログイン状態保持チェックボックス -->
<input class="input__O94L9"
       type="checkbox"
       value="rememberMe"
       name="rememberMe"
       style="">

<!-- ログインボタン -->
<button type="submit">ログイン</button>
```

**調査ファイル**: `screenshots/investigation/01-login-page.html`

### 学習状況ページ構造
```html
<!-- 調査後、実際のHTML構造を記録 -->
```

## 注意事項

- **data属性優先**: `data-testid`, `data-*`属性があれば優先的に使用
- **ID優先**: 固有のIDがあればID選択を使用
- **クラス名は最終手段**: 変更されやすいため、他に選択肢がない場合のみ
- **セレクタの安定性**: 将来のDOM変更に強いセレクタを選択
- **フォールバック戦略**: 第一候補が失敗した場合の代替セレクタも定義

## 調査完了チェックリスト

- [x] ログインページの全セレクタ確認済み
- [ ] 学習状況ページの全セレクタ確認済み（ログイン失敗のため未実施）
- [ ] ユーザー切り替えUIの動作確認済み（ログイン失敗のため未実施）
- [ ] ミッション数取得ロジック確認済み（ログイン失敗のため未実施）
- [x] スクリーンショット保存済み（`screenshots/investigation/`）
- [x] `src/config/selectors.js`ファイル作成済み
- [ ] セレクタの安定性テスト実施済み（次タスクで実施予定）

---

**調査実施者**: Claude Code (AI Assistant)
**調査実施日**: 2025-12-25
**調査方法**: Playwright自動調査スクリプト (`scripts/investigate-selectors.js`)
**調査範囲**: ログインページのみ（ログイン後ページは認証エラーのため未調査）

### 保存されたファイル

- `screenshots/investigation/01-login-page.png` - ログインページスクリーンショット
- `screenshots/investigation/01-login-page.html` - ログインページHTML
- `screenshots/investigation/02-login-filled.png` - ログイン情報入力後
- `screenshots/investigation/03-after-login.png` - ログインボタンクリック後
- `screenshots/investigation/03-after-login.html` - ログイン後HTML
- `screenshots/investigation/04-dashboard.png` - ダッシュボード（未ロード）

### 未解決の課題

1. ログイン成功の検証方法（URLが変わらなかった）
2. ダッシュボードのセレクタ調査（ログイン後にアクセス必要）
3. 自動ログインの成功条件確認
