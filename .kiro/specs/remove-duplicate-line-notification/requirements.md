# Requirements Document

## Project Description (Input)
現在一回の通知で2回LINEにメッセージが送信されるが、最初のメッセージは必要ないので削除したい

## Introduction

スマイルゼミクローラーシステムは現在、1回の実行で2つの異なるLINE通知を送信しています：

1. **ユーザー一覧通知**（`src/index.js:100-114`）- ユーザー名とインデックスのリスト
2. **詳細データ通知**（`src/index.js:234-276`）- 学習データ、ミッション情報、点数変化等の詳細情報

ユーザーエクスペリエンス向上のため、最初のユーザー一覧通知は冗長であり削除が必要です。詳細データ通知にはユーザー名も含まれているため、情報の欠落なく統合可能です。

## Requirements

### Requirement 1: ユーザー一覧通知の削除

**Objective:** システム管理者として、冗長なユーザー一覧通知を削除し、1回の実行で1つのLINE通知のみが送信されるようにしたい。これにより、通知の重複を排除し、ユーザーエクスペリエンスを向上させる。

#### Acceptance Criteria

1. When クローリング処理が完了した時、the LINE通知システム shall 詳細データ通知のみを送信する
2. The LINE通知システム shall ユーザー一覧通知（`sendUserListNotification`呼び出し）を実行しない
3. When 通知送信処理が実行された時、the システム shall ログに1回の通知送信記録のみを出力する
4. The システム shall `src/index.js` の100-114行目のユーザー一覧通知コードブロックを削除する
5. If エラーが発生した場合、then the システム shall エラー通知を1回のみ送信する

### Requirement 2: 詳細データ通知の維持

**Objective:** ユーザーとして、必要な情報（ユーザー名、学習データ、ミッション情報、点数変化）を全て含む1つの通知を受け取りたい。これにより、情報の完全性を保ちながら通知の簡潔性を実現する。

#### Acceptance Criteria

1. The 詳細データ通知 shall ユーザー名、学習時間、ミッション情報、点数変化を含む
2. When 詳細データが取得された時、the システム shall `formatDetailedMessage` 関数を使用してメッセージをフォーマットする
3. The 通知メッセージ shall 既存のフォーマット（日付、学習時間、ミッション一覧、点数変化アイコン）を維持する
4. The システム shall ミッション変化情報（NEW ✨、上昇 📈、下降 📉）を引き続き表示する
5. When 複数ユーザーが存在する場合、the 通知 shall 各ユーザーのデータをセクション分けして表示する

### Requirement 3: コード整合性とクリーンアップ

**Objective:** 開発者として、不要なコードとインポートを削除し、コードベースの保守性を向上させたい。これにより、将来の変更が容易になり、技術的負債を削減する。

#### Acceptance Criteria

1. The システム shall `sendUserListNotification` 関数の呼び出しを `src/index.js` から削除する
2. If `sendUserListNotification` 関数が他の場所で使用されていない場合、then the システム shall 当該関数を `src/notifier.js` から削除する
3. If `formatUserListMessage` 関数が他の場所で使用されていない場合、then the システム shall 当該関数を `src/notifier.js` から削除する
4. The システム shall 関連するコメントやドキュメンテーションを更新する
5. The システム shall 削除後も既存のエラーハンドリングロジックを維持する

### Requirement 4: ログ出力とデバッグ情報

**Objective:** 運用担当者として、変更後も適切なログ出力により通知処理の状態を追跡できるようにしたい。これにより、問題発生時の診断が容易になる。

#### Acceptance Criteria

1. When ユーザー一覧取得が完了した時、the システム shall ユーザー数をログに出力する（通知送信なし）
2. When 詳細データ通知を送信する時、the システム shall 送信前にログメッセージを出力する
3. When 通知送信が成功した時、the システム shall 成功ログメッセージを出力する
4. If 通知送信が失敗した場合、then the システム shall エラーログとエラー詳細を出力する
5. The ログ出力 shall GitHub Actionsのワークフローログで確認可能である

### Requirement 5: 後方互換性とテスト

**Objective:** 品質保証担当者として、変更が既存の機能に悪影響を与えないことを検証したい。これにより、安全なデプロイを保証する。

#### Acceptance Criteria

1. The システム shall LINE Messaging API（Push Message API）との統合を維持する
2. When クローリングが実行された時、the システム shall 既存のデータ取得フローを変更しない
3. The システム shall `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_USER_ID` の環境変数を引き続き使用する
4. When 通知フォーマット処理が実行された時、the システム shall メッセージ長制限（5000文字）を遵守する
5. The システム shall 既存のリトライロジックとタイムアウト処理を維持する
6. When テストが実行された時、the システム shall 通知が1回のみ送信されることを検証可能である

## Non-Functional Requirements

### Performance

- The システム shall 通知送信処理の実行時間を増加させない（削除により若干改善が期待される）

### Security

- The システム shall GitHub Secretsに保存された認証情報の取り扱いを変更しない
- The ログ出力 shall 認証情報を自動マスキングする機能を維持する

### Maintainability

- The コードベース shall ユーザー一覧通知関連のコード削除により、保守性が向上する
- The システム shall 単一責任原則に従い、詳細データ通知のみを担当する

## Out of Scope

以下は本仕様の範囲外とする：

- 詳細データ通知のフォーマット変更
- LINE Messaging APIのエンドポイント変更
- 新しい通知タイプの追加
- 通知スケジュールの変更
- ユーザー一覧データの取得処理の削除（内部処理として維持）

