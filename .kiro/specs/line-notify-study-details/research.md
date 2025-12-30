# Research & Design Decisions

---
**Purpose**: 既存システム拡張のための調査結果とアーキテクチャ決定の根拠を記録

**Feature**: line-notify-study-details
**Discovery Type**: 軽量ディスカバリー（Extension）
**Date**: 2025-12-30

---

## Summary

- **Feature**: line-notify-study-details
- **Discovery Scope**: Extension（既存クローラーシステムの機能拡張）
- **Key Findings**:
  - 既存アーキテクチャは拡張に適している（Option A推奨）
  - DOM構造調査が最優先タスク
  - データバージョン管理により後方互換性を確保

## Research Log

### 既存コードベース構造の分析

**Context**: 新機能を既存システムにどう統合するかを判断するため

**Sources Consulted**:
- `src/crawler.js` - データ取得ロジック
- `src/notifier.js` - LINE通知フォーマット
- `src/data.js` - データ保存・比較
- `data/mission_data.json` - 現在のデータ構造
- `.kiro/specs/smile-zemi-crawler-line-notify/` - 既存仕様

**Findings**:
- **アーキテクチャパターン**: 単一責任原則に基づくモジュール分離
  - `auth.js`: 認証のみ
  - `crawler.js`: データ取得のみ
  - `notifier.js`: 通知のみ
  - `data.js`: データ管理のみ
- **エラーハンドリング**: 統一的な`{success: boolean, error?: string}`レスポンス形式
- **セキュリティ**: `maskSensitiveData()`による認証情報の自動マスキング
- **再利用可能なコンポーネント**:
  - `switchToUser()`: ユーザー切り替え（右上ユーザー名検証機能付き）
  - `getTodayMissionCount()`: 今日のミッション数取得
  - `sendNotification()`: リトライ機能付きLINE通知
  - `compareData()`: 変更検出ロジック

**Implications**:
- 既存のモジュール構造を維持しながら拡張可能
- 各モジュールに新関数を追加する形で実装
- 既存のエラーハンドリングパターンを踏襲

### 現在のデータ構造

**Context**: データモデルの拡張方法を決定

**Current Structure**:
```json
{
  "version": "1.0",
  "timestamp": "ISO 8601",
  "users": [
    {
      "userName": "string",
      "missionCount": "number",
      "date": "YYYY-MM-DD"
    }
  ]
}
```

**Findings**:
- バージョン管理機能が既に存在
- ユーザー配列形式で複数ユーザーに対応
- タイムスタンプによる実行履歴管理

**Implications**:
- version 2.0への移行が自然
- 既存データの自動移行ロジックが必要
- 拡張フィールド追加により後方互換性を確保

### DOM要素の取得戦略

**Context**: みまもるネットから詳細データを取得する方法

**Current Implementation**:
- `getTodayMissionCount()`: 日付ヘッダーのbounding boxを使用して今日のセクションを特定
- `.missionIcon__i6nW8`クラスを持つ要素を検索
- NEWラベルの有無で完了/未完了を判定

**Research Needed**:
- 勉強時間の表示要素とセレクタ
- ミッション名の表示要素（`.missionIcon__i6nW8`の親/兄弟要素を調査）
- 獲得点数の表示要素
- 要素の階層関係と位置情報

**Implications**:
- DOM調査スクリプトの作成が必要（`scripts/investigate-study-details.js`）
- 既存の位置ベース検索パターンを踏襲
- セレクタを`config/selectors.js`に追加

### LINE通知フォーマットの設計

**Context**: 詳細情報を5000文字制限内でどう表示するか

**Current Format**:
```
📊 スマイルゼミ ミッション数

🔔 {変更件数}件の変更がありました

📈 {ユーザー名}
{前回数} → {現在数} (+{差分})
```

**Constraints**:
- LINE API制限: 5000文字
- 複数ユーザー対応
- 可読性の確保

**Proposed Format**:
```
📊 スマイルゼミ 学習状況

👤 {ユーザー名}
⏱️ 勉強時間: {時間}時間{分}分
✅ 完了ミッション: {完了数}/{総数}件
🎯 合計点数: {点数}点

【ミッション詳細】（最新10件）
・{ミッション名}: {点数}点
・{ミッション名}: {点数}点
...
```

**Implications**:
- ミッション詳細は最大10件に制限
- 絵文字を活用して情報を圧縮
- ユーザーごとにセクションを分ける

## Architecture Pattern Evaluation

既存システムの拡張のため、3つのアプローチを評価：

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| **A: 既存コンポーネント拡張** | crawler.js, notifier.js, data.jsに機能追加 | ・既存パターンとの一貫性<br>・ファイル数増えず<br>・学習コスト低 | ・crawler.jsのコード量増加（400行→600行） | **推奨** - プロジェクトのスケールに最適 |
| B: 新規コンポーネント作成 | study-data-crawler.js, study-notifier.js新規作成 | ・各ファイルの責務明確<br>・テスト独立性高 | ・ファイル数増加<br>・インターフェース設計複雑<br>・このスケールに過剰 | 非推奨 - オーバーエンジニアリング |
| C: ハイブリッド | Phase 1でA、必要時にBへ移行 | ・段階的検証可能<br>・リスク分散 | ・計画複雑<br>・技術的負債リスク | Option Aで十分な場合に限り検討 |

## Design Decisions

### Decision: Option A（既存コンポーネント拡張）を選択

**Context**: 新機能を既存システムにどう統合するか

**Alternatives Considered**:
1. Option A: 既存モジュールに機能追加
2. Option B: 新規モジュール作成
3. Option C: ハイブリッド（段階的移行）

**Selected Approach**: Option A - 既存の`crawler.js`, `notifier.js`, `data.js`を拡張

**Rationale**:
- プロジェクトスケールに適している（単一機能システム）
- 既存パターンとの一貫性が高く、学習コスト低
- ファイル数を増やさず、シンプルな構造を維持
- 各モジュールの責務は明確に保たれる

**Trade-offs**:
- ✅ 利点: 既存インフラ活用、ファイル構造シンプル、実装速度速い
- ❌ 欠点: crawler.jsのコード量増加（manageable）

**Follow-up**:
- crawler.jsが800行を超える場合、分割を再検討
- 実行時間が30秒/ユーザーを超える場合、最適化

### Decision: データ構造をversion 2.0に拡張

**Context**: 詳細情報を保存するデータ構造の設計

**Selected Approach**:
```json
{
  "version": "2.0",
  "timestamp": "ISO 8601",
  "users": [
    {
      "userName": "string",
      "missionCount": "number",
      "date": "YYYY-MM-DD",
      "studyTime": {
        "hours": "number",
        "minutes": "number"
      },
      "totalScore": "number",
      "missions": [
        {
          "name": "string",
          "score": "number",
          "completed": "boolean"
        }
      ]
    }
  ]
}
```

**Rationale**:
- 既存のバージョン管理機能を活用
- 後方互換性を確保（version 1.0からの自動移行）
- 拡張性を考慮した構造

**Trade-offs**:
- ✅ 利点: 明確なバージョン管理、段階的移行可能
- ❌ 欠点: 移行ロジックの実装が必要

**Follow-up**:
- `data.js`の`loadPreviousData()`にversion 1.0→2.0移行ロジックを追加
- 過去7日分のデータ保持（Requirement 5.5）

### Decision: エラーフォールバック戦略

**Context**: 詳細データ取得失敗時の動作

**Selected Approach**: 段階的フォールバック
1. 詳細データ取得失敗 → ミッション数のみ通知（従来動作）
2. 部分的成功 → 取得できたデータのみ通知
3. 完全失敗 → エラー通知

**Rationale**:
- システムの信頼性を確保（Requirement 6）
- ユーザーに最低限の情報は提供
- 段階的なデグラデーション

**Trade-offs**:
- ✅ 利点: 高い信頼性、ユーザー影響最小化
- ❌ 欠点: ロジックの複雑性増加

**Follow-up**:
- 各取得関数で適切なエラーハンドリング
- エラーログの詳細記録

## Risks & Mitigations

### Risk 1: DOM構造の不確実性

**Risk**: みまもるネットのページ構造が想定と異なる可能性

**Mitigation**:
- DOM調査スクリプト（`scripts/investigate-study-details.js`）を作成して早期検証
- 既存の`scripts/investigate-selectors.js`パターンを参考
- 実サイトでのテスト実行

### Risk 2: パフォーマンス影響

**Risk**: 詳細データ取得により実行時間が30秒/ユーザーを超える可能性

**Mitigation**:
- 不要なページ遷移を避ける
- 並列処理の可能性を検討
- タイムアウト設定の最適化
- パフォーマンステストの実施

### Risk 3: データ移行の失敗

**Risk**: version 1.0からversion 2.0へのデータ移行時の不具合

**Mitigation**:
- 移行ロジックの単体テスト
- 既存データのバックアップ
- version 1.0データの互換性維持
- ロールバック機能の実装

## References

- [LINE Messaging API - Push Message](https://developers.line.biz/ja/reference/messaging-api/#send-push-message) - LINE通知API仕様
- [Playwright API Documentation](https://playwright.dev/docs/api/class-playwright) - ブラウザ自動化
- `.kiro/steering/product.md` - プロダクト概要とコア機能
- `.kiro/steering/structure.md` - プロジェクト構造とコーディング規約
- `.kiro/steering/tech.md` - 技術スタックと開発標準
- `.kiro/specs/line-notify-study-details/gap-analysis.md` - 詳細なギャップ分析
