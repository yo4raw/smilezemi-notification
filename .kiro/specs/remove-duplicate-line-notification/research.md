# Research & Design Decisions

## Summary
- **Feature**: `remove-duplicate-line-notification`
- **Discovery Scope**: Extension (既存システムからの機能削除)
- **Key Findings**:
  - ユーザー一覧通知と詳細データ通知の2つの異なる通知フローが存在
  - 詳細データ通知にはユーザー名が既に含まれており、情報の重複が発生
  - `sendUserListNotification`関数は`src/index.js`でのみ使用されており、削除による影響範囲は限定的

## Research Log

### 既存通知アーキテクチャの分析

- **Context**: 現在のLINE通知実装パターンを理解し、安全な削除方法を決定するため
- **Sources Consulted**:
  - `src/index.js:92-119` - ユーザー一覧通知の実装
  - `src/index.js:234-276` - 詳細データ通知の実装
  - `src/notifier.js:243-348` - 通知関数の実装
  - `docs/API_NOTIFIER.md` - API ドキュメント
- **Findings**:
  - **ユーザー一覧通知** (`sendUserListNotification`):
    - 関数呼び出し箇所: `src/index.js:102-106`のみ
    - フォーマット関数: `formatUserListMessage` (`src/notifier.js:340-348`)
    - 通知内容: ユーザー数のみ（登録ユーザー数: N名）
    - リトライロジック: 3回まで、指数バックオフ
  - **詳細データ通知** (直接fetch API):
    - 実装箇所: `src/index.js:234-276`
    - フォーマット関数: `formatDetailedMessage` (`src/notifier.js:358-`)
    - 通知内容: ユーザー名、学習時間、ミッション情報、点数変化
    - リトライロジック: なし（直接fetch実装）
  - **重複の確認**: 詳細データ通知の`formatDetailedMessage`はユーザー名を含むため、ユーザー一覧通知は冗長
- **Implications**:
  - ユーザー一覧通知の削除は詳細データ通知に影響しない（独立した実装）
  - `sendUserListNotification`と`formatUserListMessage`は他で使用されていないため安全に削除可能
  - エラーハンドリングとログ出力パターンは維持する必要がある

### LINE Messaging API統合確認

- **Context**: 削除後もLINE API統合が正しく動作することを確認
- **Sources Consulted**:
  - LINE Messaging API Push Message API仕様
  - `src/notifier.js` - API統合実装
  - `.kiro/steering/tech.md` - 技術スタック定義
- **Findings**:
  - **API エンドポイント**: `https://api.line.me/v2/bot/message/push` (両通知で共通)
  - **認証**: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` (環境変数)
  - **宛先**: `LINE_USER_ID` (環境変数)
  - **メッセージ制限**: 5000文字 (`truncateToLimit`関数で制御)
  - **詳細通知の実装**: 直接fetch APIを使用（`sendUserListNotification`とは異なるパターン）
- **Implications**:
  - 環境変数とAPI契約は変更不要
  - 詳細通知は既存のLINE API統合を維持
  - リトライロジックの不一致（詳細通知にはリトライなし）は既存の技術的負債として認識

### 影響範囲とファイル分析

- **Context**: 削除対象の特定と影響範囲の明確化
- **Sources Consulted**:
  - `grep -r "sendUserListNotification\|formatUserListMessage"` 実行結果
  - `src/index.js`, `src/notifier.js`, `docs/API_NOTIFIER.md`
- **Findings**:
  - **削除対象ファイル**:
    1. `src/index.js:100-114` - ユーザー一覧通知呼び出しブロック
    2. `src/notifier.js:243-332` - `sendUserListNotification`関数
    3. `src/notifier.js:340-348` - `formatUserListMessage`関数
    4. `docs/API_NOTIFIER.md` - 関数ドキュメント（該当セクション）
  - **保持される処理**:
    - `getUserList` (line 94) - ユーザー一覧取得は詳細データクローリングで必要
    - 詳細データ通知 (line 234-276) - 完全に保持
    - エラー配列への追加とログ出力パターン
- **Implications**:
  - 削除は4ファイルに限定される
  - `getUserList`の結果は後続のクローリング処理で使用されるため維持
  - ログメッセージは更新が必要（"ユーザー一覧の取得が完了"は維持、"LINE通知"部分のみ削除）

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 完全削除 | `sendUserListNotification`と`formatUserListMessage`を完全削除 | コードベースの簡素化、保守性向上 | なし（関数は他で未使用） | **選択**: ステアリング原則（単一責任、YAGNI）に整合 |
| 非推奨化 | 関数を残して`@deprecated`マーク | 将来の再利用可能性 | 技術的負債の蓄積、コード肥大化 | 却下: 他で使用されていないため不要 |
| リファクタリング統合 | 詳細通知に統合して単一関数化 | 通知ロジックの統一 | スコープ外、詳細通知フォーマットの変更が必要 | 却下: 要求仕様の範囲外 |

## Design Decisions

### Decision: ユーザー一覧通知の完全削除

- **Context**:
  - 重複通知によるユーザーエクスペリエンス低下
  - 詳細データ通知にユーザー名が既に含まれている
  - `sendUserListNotification`関数の使用箇所は1箇所のみ
- **Alternatives Considered**:
  1. **完全削除** - 関数とその呼び出しを完全に削除
  2. **条件付き無効化** - 環境変数で制御（フラグベース）
  3. **通知統合** - 2つの通知を1つにマージ
- **Selected Approach**: 完全削除
  - `src/index.js:100-114`の通知呼び出しブロック削除
  - `src/notifier.js`から`sendUserListNotification`と`formatUserListMessage`削除
  - 関連ドキュメント更新
- **Rationale**:
  - **YAGNI原則**: 将来の再利用予定なし、条件分岐は不要な複雑性
  - **単一責任**: 詳細データ通知のみに責務を集中
  - **保守性**: 未使用コードの削除で技術的負債を削減
  - **影響範囲**: 限定的（1ファイルの1箇所のみ）
- **Trade-offs**:
  - **利点**: コード簡素化、通知重複解消、保守性向上
  - **妥協**: ロールバックには関数の再実装が必要（Git履歴から復元可能）
- **Follow-up**:
  - 削除後の手動テスト: GitHub Actionsで通知が1回のみ送信されることを確認
  - ログ出力の検証: ユーザー一覧取得ログは維持、通知送信ログは削除を確認

### Decision: ユーザー一覧取得処理の維持

- **Context**: `getUserList`呼び出し（line 94）はユーザー一覧通知のトリガーだが、後続処理で使用される可能性
- **Alternatives Considered**:
  1. **維持** - `getUserList`呼び出しと結果ログを維持
  2. **削除** - ユーザー一覧取得自体を削除
- **Selected Approach**: 維持
  - `getUserList`呼び出しは保持
  - ユーザー数のログ出力は維持（"ユーザー一覧の取得が完了しました（N名）"）
  - 通知送信ブロック（line 100-114）のみ削除
- **Rationale**:
  - ユーザー一覧は後続の詳細データクローリングで各ユーザーのデータ取得に使用される
  - スコープ外の変更を避ける（要求仕様: "ユーザー一覧データの取得処理の削除（内部処理として維持）"）
  - ログ出力はデバッグと監視に有用
- **Trade-offs**:
  - **利点**: 既存のデータフローを保持、スコープ遵守
  - **妥協**: なし
- **Follow-up**: なし

### Decision: ログ出力パターンの更新

- **Context**: ユーザー一覧通知関連のログメッセージを更新し、一貫性を維持
- **Selected Approach**:
  - **維持**: "ユーザー一覧の取得が完了しました（N名）" (line 98)
  - **削除**: "ユーザー一覧をLINEに通知しています..." (line 101)
  - **削除**: "ユーザー一覧のLINE通知が完了しました" (line 109)
  - **削除**: "ユーザー一覧のLINE通知に失敗しました" (line 111)
- **Rationale**:
  - データ取得ログは運用監視に必要
  - 通知関連ログは削除により不要
  - GitHub Actionsログの明確性を維持
- **Trade-offs**:
  - **利点**: ログの一貫性、監視の継続性
  - **妥協**: なし

## Risks & Mitigations

- **リスク1**: ユーザー一覧通知の削除により、ユーザーが通知を受け取れなくなる
  - **軽減策**: 詳細データ通知にユーザー名が含まれているため、情報欠落なし。要求仕様で明示的に承認済み
- **リスク2**: `getUserList`の削除により、後続のクローリング処理が失敗する
  - **軽減策**: `getUserList`呼び出しは維持し、通知送信ブロックのみ削除。データフローは変更なし
- **リスク3**: ドキュメントの更新漏れにより、開発者が誤った情報を参照する
  - **軽減策**: `docs/API_NOTIFIER.md`の該当セクション削除をタスクに含める。実装時にドキュメント更新を検証
- **リスク4**: 詳細通知のリトライロジック欠如（既存の技術的負債）
  - **軽減策**: スコープ外として記録。将来の改善タスクとして別仕様で対応を推奨

## References

- [LINE Messaging API - Push Message](https://developers.line.biz/en/reference/messaging-api/#send-push-message) - 公式API仕様
- `src/index.js:92-119` - ユーザー一覧通知実装（削除対象）
- `src/index.js:234-276` - 詳細データ通知実装（維持）
- `src/notifier.js:243-348` - 通知関数実装（削除対象）
- `.kiro/steering/tech.md` - 技術スタックとLINE Messaging API統合方針
- `.kiro/steering/structure.md` - コード組織化原則（単一責任、エラーハンドリング）
