# Requirements Document

## Project Description (Input)
githubsecretsにログイン時のユーザ名とパスワードが登録されていることを前提として、https://smile-zemi.jp/mimamoru-net/ui/loginにログインし、サイト内部をクローリングしてlineに通知するGithubaction

## Introduction
本プロジェクトは、スマイルゼミの「みまもるネット」サイトに自動ログインし、サイト内の情報をクローリングしてLINE通知を送信するGitHub Actionsワークフローを実装します。GitHub Secretsに保存された認証情報を使用してセキュアに動作し、定期的または手動トリガーでの実行をサポートします。

## Requirements

### Requirement 1: GitHub Secrets統合
**Objective:** As a システム運用者, I want GitHub Secretsから認証情報を安全に取得する機能, so that 認証情報をコードに埋め込まずにセキュアに管理できる

#### Acceptance Criteria
1. When ワークフローが開始される, the Smile Zemi Crawlerワークフロー shall GitHub Secretsから`SMILEZEMI_USERNAME`を取得する
2. When ワークフローが開始される, the Smile Zemi Crawlerワークフロー shall GitHub Secretsから`SMILEZEMI_PASSWORD`を取得する
3. When ワークフローが開始される, the Smile Zemi Crawlerワークフロー shall GitHub Secretsから`LINE_CHANNEL_ACCESS_TOKEN`を取得する
4. When ワークフローが開始される, the Smile Zemi Crawlerワークフロー shall GitHub Secretsから`LINE_USER_ID`を取得する
5. If いずれかの必須Secretが存在しない, then the Smile Zemi Crawlerワークフロー shall エラーメッセージをログに出力してワークフローを終了する
6. The Smile Zemi Crawlerワークフロー shall 認証情報とトークン、User IDをログやコンソール出力にマスキングして表示しない

### Requirement 2: ログイン機能
**Objective:** As a ワークフロー実行者, I want みまもるネットに自動的にログインする機能, so that 手動操作なしでサイト情報にアクセスできる

#### Acceptance Criteria
1. When ワークフローが実行される, the Smile Zemi Crawlerワークフロー shall `https://smile-zemi.jp/mimamoru-net/ui/login`にアクセスする
2. When ログインページが読み込まれる, the Smile Zemi Crawlerワークフロー shall ユーザー名入力フィールドに`SMILEZEMI_USERNAME`を入力する
3. When ユーザー名が入力される, the Smile Zemi Crawlerワークフロー shall パスワード入力フィールドに`SMILEZEMI_PASSWORD`を入力する
4. When 認証情報が入力される, the Smile Zemi Crawlerワークフロー shall ログインボタンをクリックしてログイン処理を実行する
5. When ログインが成功する, the Smile Zemi Crawlerワークフロー shall ログイン後のページに遷移したことを確認する
6. If ログインが失敗する, then the Smile Zemi Crawlerワークフロー shall エラー詳細をログに記録してワークフローを終了する
7. The Smile Zemi Crawlerワークフロー shall セッションCookieを保持して認証状態を維持する

### Requirement 3: ミッション数取得機能
**Objective:** As a 保護者, I want 当日の学習日のこなしたミッション数を自動的に取得する機能, so that 子供の学習進捗をリアルタイムで確認できる

#### Acceptance Criteria
1. When ログインが完了する, the Smile Zemi Crawlerワークフロー shall 学習状況を表示するページに遷移する
2. When 学習状況ページが読み込まれる, the Smile Zemi Crawlerワークフロー shall DOMが完全に読み込まれるまで待機する
3. When ページが完全に読み込まれる, the Smile Zemi Crawlerワークフロー shall 当日の日付の学習日を特定する
4. When 当日の学習日が特定される, the Smile Zemi Crawlerワークフロー shall こなしたミッション数を表示する要素を特定する
5. When ミッション数要素が特定される, the Smile Zemi Crawlerワークフロー shall セレクタまたはXPathを使用してミッション数の数値を抽出する
6. When ミッション数が抽出される, the Smile Zemi Crawlerワークフロー shall ユーザー情報とともに構造化データ（JSON）として保存する
7. If ページ読み込みがタイムアウトする, then the Smile Zemi Crawlerワークフロー shall リトライ処理を最大3回実行する
8. If ミッション数要素が見つからない, then the Smile Zemi Crawlerワークフロー shall ミッション数をゼロとして記録する
9. The Smile Zemi Crawlerワークフロー shall 前回実行時のミッション数と比較して変更を検出する

### Requirement 8: 複数ユーザー対応
**Objective:** As a 保護者, I want 画面右上で選択可能な全てのユーザーの学習情報を取得する機能, so that 複数の子供の学習状況を一度に確認できる

#### Acceptance Criteria
1. When 学習状況ページが読み込まれる, the Smile Zemi Crawlerワークフロー shall 画面右上のユーザー選択要素を特定する
2. When ユーザー選択要素が特定される, the Smile Zemi Crawlerワークフロー shall 選択可能なユーザーのリストを取得する
3. When ユーザーリストが取得される, the Smile Zemi Crawlerワークフロー shall 各ユーザーの名前または識別子を抽出する
4. When ユーザーリストが抽出される, the Smile Zemi Crawlerワークフロー shall 各ユーザーに対して順次処理を実行する
5. When 各ユーザーを処理する, the Smile Zemi Crawlerワークフロー shall ユーザー選択UIをクリックしてユーザーを切り替える
6. When ユーザーが切り替わる, the Smile Zemi Crawlerワークフロー shall ページが更新されるまで待機する
7. When ページ更新が完了する, the Smile Zemi Crawlerワークフロー shall 当該ユーザーのミッション数を取得する（Requirement 3に従う）
8. When 全ユーザーの処理が完了する, the Smile Zemi Crawlerワークフロー shall 全ユーザーのデータを統合して保存する
9. If ユーザー切り替えが失敗する, then the Smile Zemi Crawlerワークフロー shall エラーをログに記録して次のユーザーに進む
10. The Smile Zemi Crawlerワークフロー shall 各ユーザーのデータを個別に識別可能な形式で保存する

### Requirement 4: LINE通知機能
**Objective:** As a 通知受信者, I want クローリング結果をLINEで受け取る機能, so that リアルタイムで情報を確認できる

#### Acceptance Criteria
1. When クローリングが完了する, the Smile Zemi Crawlerワークフロー shall LINE Messaging APIを使用して通知を送信する
2. When 通知を送信する, the Smile Zemi Crawlerワークフロー shall `LINE_CHANNEL_ACCESS_TOKEN`を認証ヘッダー（Authorization: Bearer）に含める
3. When 通知を送信する, the Smile Zemi Crawlerワークフロー shall Push Message APIエンドポイント（`https://api.line.me/v2/bot/message/push`）を使用する
4. When 通知を送信する, the Smile Zemi Crawlerワークフロー shall `LINE_USER_ID`を使用して通知先ユーザーを指定する
5. When 通知メッセージを作成する, the Smile Zemi Crawlerワークフロー shall 全ユーザーのミッション数を含めた要約を生成する
6. When 通知メッセージに複数ユーザーが含まれる, the Smile Zemi Crawlerワークフロー shall 各ユーザー名とミッション数を個別に表示する
7. When データに変更がある, the Smile Zemi Crawlerワークフロー shall 変更があったユーザーとミッション数の差分を強調表示して通知する
8. When データに変更がない, the Smile Zemi Crawlerワークフロー shall 「変更なし」のステータスメッセージを送信する
9. If LINE通知の送信が失敗する, then the Smile Zemi Crawlerワークフロー shall エラーをログに記録してリトライを3回実行する
10. The Smile Zemi Crawlerワークフロー shall 通知メッセージを最大5000文字に制限する
11. If メッセージが1000文字を超える, then the Smile Zemi Crawlerワークフロー shall 重要な情報（変更があったユーザー）を優先して表示する

### Requirement 5: GitHub Actionsワークフロー
**Objective:** As a DevOpsエンジニア, I want 定期的および手動でワークフローを実行できる機能, so that 柔軟なスケジューリングが可能になる

#### Acceptance Criteria
1. The Smile Zemi Crawlerワークフロー shall 毎日18時（JST）に自動実行されるcronスケジュールを設定する
2. The Smile Zemi Crawlerワークフロー shall cronスケジュールを`0 9 * * *`（UTC 9:00 = JST 18:00）で定義する
3. The Smile Zemi Crawlerワークフロー shall `workflow_dispatch`イベントで手動実行をサポートする
4. When ワークフローが実行される, the Smile Zemi Crawlerワークフロー shall Ubuntu最新版のランナーで実行する
5. When ワークフローが実行される, the Smile Zemi Crawlerワークフロー shall Node.js環境をセットアップする
6. When ワークフローが実行される, the Smile Zemi Crawlerワークフロー shall Playwrightブラウザをインストールする
7. When ワークフローが完了する, the Smile Zemi Crawlerワークフロー shall 実行ログをGitHub Actions UIで確認可能にする
8. The Smile Zemi Crawlerワークフロー shall 実行時間が30分を超えないように設計する
9. The Smile Zemi Crawlerワークフロー shall タイムゾーンの違いをREADMEに明記する（UTC vs JST）

### Requirement 6: Docker環境でのローカルテスト
**Objective:** As a 開発者, I want Docker環境でスクリプトの挙動を確認する機能, so that 本番稼働前に動作を検証できる

#### Acceptance Criteria
1. The Smile Zemi Crawlerスクリプト shall Docker環境で実行可能な構成を提供する
2. The Smile Zemi Crawlerスクリプト shall Dockerfileを含み、必要な依存関係を全てインストールする
3. When Docker環境で実行する, the Smile Zemi Crawlerスクリプト shall 環境変数から認証情報を取得する
4. When Docker環境で実行する, the Smile Zemi Crawlerスクリプト shall GitHub Actions環境と同一のコードベースで動作する
5. The Smile Zemi Crawlerスクリプト shall Docker Composeファイルを提供して環境変数の設定を簡素化する
6. When Docker環境でテストする, the Smile Zemi Crawlerスクリプト shall 実行ログを標準出力に表示する
7. When Docker環境でテストする, the Smile Zemi Crawlerスクリプト shall スクリーンショットやデータファイルをボリュームマウントで保存する
8. The Smile Zemi Crawlerスクリプト shall Dockerイメージのビルド手順をREADMEに記載する
9. The Smile Zemi Crawlerスクリプト shall ローカル実行用の.env.exampleファイルを提供する
10. The Smile Zemi Crawlerスクリプト shall GitHub ActionsとDocker環境で環境変数名を統一する

### Requirement 7: エラーハンドリング
**Objective:** As a システム運用者, I want エラーを適切に検出して報告する機能, so that 問題を迅速に特定して対処できる

#### Acceptance Criteria
1. If ネットワークエラーが発生する, then the Smile Zemi Crawlerワークフロー shall エラー詳細をログに記録してLINE通知を送信する
2. If タイムアウトエラーが発生する, then the Smile Zemi Crawlerワークフロー shall リトライ処理を実行する
3. If 認証エラーが発生する, then the Smile Zemi Crawlerワークフロー shall エラーメッセージをログに記録してワークフローを終了する
4. If DOM要素が見つからない, then the Smile Zemi Crawlerワークフロー shall セレクタエラーをログに記録してスクリーンショットを保存する
5. When エラーが発生する, the Smile Zemi Crawlerワークフロー shall エラーの種類、タイムスタンプ、スタックトレースを含める
6. When 致命的エラーが発生する, the Smile Zemi Crawlerワークフロー shall 終了コード1でワークフローを終了する
7. The Smile Zemi Crawlerワークフロー shall エラー発生時のスクリーンショットをアーティファクトとして保存する

### Requirement 9: セキュリティとプライバシー
**Objective:** As a セキュリティ担当者, I want 認証情報とユーザーデータを安全に扱う機能, so that セキュリティリスクを最小化できる

#### Acceptance Criteria
1. The Smile Zemi Crawlerワークフロー shall 認証情報をGitHub Secretsにのみ保存してコードに埋め込まない
2. The Smile Zemi Crawlerワークフロー shall Docker環境では.envファイルまたは環境変数で認証情報を管理する
3. The Smile Zemi Crawlerワークフロー shall .envファイルを.gitignoreに含めてリポジトリにコミットしない
4. The Smile Zemi Crawlerワークフロー shall ログ出力時に認証情報をマスキングする
5. The Smile Zemi Crawlerワークフロー shall 抽出データを暗号化してGitHubアーティファクトに保存する
6. The Smile Zemi Crawlerワークフロー shall セッションCookieをワークフロー終了時に削除する
7. The Smile Zemi Crawlerワークフロー shall HTTPS通信のみを使用してHTTP通信を禁止する
8. When 個人情報を含むデータを扱う, the Smile Zemi Crawlerワークフロー shall データ最小化の原則に従い必要最小限のみ取得する
9. The Smile Zemi Crawlerワークフロー shall 依存パッケージの脆弱性スキャンを定期的に実行する

