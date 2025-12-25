# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

**Usage**:
- Log research activities and outcomes during the discovery phase.
- Document design decision trade-offs that are too detailed for `design.md`.
- Provide references and evidence for future audits or reuse.
---

## Summary
- **Feature**: `smile-zemi-crawler-line-notify`
- **Discovery Scope**: New Feature
- **Key Findings**:
  - **CRITICAL**: LINE Notify API terminated March 31, 2025 - must use LINE Messaging API
  - Playwright + GitHub Actions requires `npx playwright install --with-deps` (not deprecated `playwright-github-action`)
  - Node.js 24 recommended for GitHub Actions (Node 20 EOL April 2026)
  - Docker環境とGitHub Actions環境で同一コードベース実行可能

## Research Log

### LINE通知API調査
- **Context**: 要件でLINE Notify APIを使用することが指定されているが、最新の状況を確認する必要があった
- **Sources Consulted**:
  - [LINE Notify API公式ドキュメント](https://notify-bot.line.me/doc/ja/)
  - [LINE Developers - Messaging API](https://developers.line.biz/ja/docs/messaging-api/)
- **Findings**:
  - **LINE Notify API終了**: 2025年3月31日をもってサービス終了
  - 代替手段: LINE Messaging APIへの移行が推奨
  - LINE Messaging APIの特徴:
    - Channel Access Tokenベースの認証
    - Push/Reply/Multicast APIで通知送信
    - LINE Official Accountが必要
    - より高度なメッセージ機能（Flex Message、Quick Replyなど）
- **Implications**:
  - ✅ 要件更新完了: `LINE_NOTIFY_TOKEN` → `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_ID` → `LINE_USER_ID`
  - LINE Official Accountの作成とChannel設定が前提条件（Phase 2で実施）
  - 通知先指定方法の変更: Channel ID → User ID/Group ID
  - 設計での対応: Messaging API用のnotifierモジュール設計

### Playwright GitHub Actions統合
- **Context**: ブラウザ自動化をGitHub Actions環境で実行するためのベストプラクティス調査
- **Sources Consulted**:
  - [Playwright公式ドキュメント - CI GitHub Actions](https://playwright.dev/docs/ci-github-actions)
  - [GitHub Actions - setup-node](https://github.com/actions/setup-node)
- **Findings**:
  - 非推奨: `microsoft/playwright-github-action@v1` (メンテナンス終了)
  - 推奨アプローチ:
    ```yaml
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: npx playwright install --with-deps
    ```
  - ブラウザインストール: `--with-deps`フラグで必要なシステム依存関係も自動インストール
  - タイムアウト設定: ワークフロー全体で60分推奨（デフォルト360分）
  - スクリーンショット保存: GitHub Actionsアーティファクトとして保存可能
- **Implications**:
  - ワークフローファイルでのセットアップ手順明確化
  - エラー時スクリーンショット自動保存機能の実装

### Node.js GitHub Actionsベストプラクティス
- **Context**: Node.js環境のセットアップと依存関係管理の最適化
- **Sources Consulted**:
  - [GitHub Actions - setup-node v6](https://github.com/actions/setup-node/releases/tag/v6.0.0)
  - [Node.js Release Schedule](https://github.com/nodejs/release)
- **Findings**:
  - Node.js 24推奨 (Node 20 EOL: 2026年4月)
  - setup-node v6の新機能:
    - package.jsonの`packageManager`フィールド自動検出
    - 依存関係キャッシュ自動化
  - 依存関係インストール: `npm ci` > `npm install` (高速、決定論的)
  - 環境変数: `NODE_ENV=production`でdevDependenciesをスキップ可能
- **Implications**:
  - package.jsonに`"packageManager": "npm@10.x"`指定
  - ワークフローで`npm ci`使用
  - Node.js 24.x指定

### ブラウザ自動化アーキテクチャパターン
- **Context**: みまもるネットの複数ユーザー対応とミッション数取得の実装アプローチ
- **Sources Consulted**:
  - Playwright公式ドキュメント - Locators, Wait Strategies
  - ステアリングファイル: structure.md (単一責任原則)
- **Findings**:
  - Page Object Modelパターン適用可能
  - ロケータ戦略: `page.locator()` with data attributes > CSS selectors
  - 待機戦略: `waitForSelector()` with visible/attached states
  - ユーザー切り替え: ドロップダウンUI操作 + ページリロード待機
  - データ抽出: テキストコンテンツ取得 + 正規表現パース
- **Implications**:
  - crawler.jsでPage Object的な構造化
  - セレクタ設定の外部化（将来のDOM変更対応）
  - リトライロジックの実装（Requirement 7対応）

### Docker環境設計
- **Context**: ローカルテスト環境とGitHub Actions環境の統一
- **Sources Consulted**:
  - Docker公式ドキュメント - Node.js best practices
  - Playwright Docker images
- **Findings**:
  - 公式Playwrightイメージ利用可能: `mcr.microsoft.com/playwright:v1.40.0-jammy`
  - 環境変数統一化:
    - GitHub Secrets → GitHub Actions環境変数
    - .envファイル → Docker環境変数
  - ボリュームマウント: スクリーンショット、データファイル永続化
  - docker-composeでの環境変数注入
- **Implications**:
  - Dockerfileは公式イメージ継承
  - docker-compose.ymlで環境変数とボリューム定義
  - .env.exampleテンプレート提供
  - GitHub ActionsとDocker環境で環境変数名完全統一

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Modular Monolith | 機能別モジュール分割（auth, crawler, notifier, main） | シンプル、GitHub Actions環境に最適、依存関係明確 | スケーラビリティ制約（本プロジェクトでは非課題） | ステアリングprinciples準拠、単一責任原則 |
| Microservices | 各機能をサービス化 | スケーラブル、独立デプロイ | 過剰エンジニアリング、GitHub Actions環境に不適 | スコープに対して複雑すぎる |
| Event-Driven | イベントバス経由の非同期処理 | 疎結合、拡張性高 | 不要な複雑性、デバッグ困難 | 現在の要件に過剰 |

**選定**: Modular Monolith
- 理由: GitHub Actions単一ジョブ実行、シンプルな依存関係、保守性優先
- ステアリングprinciples準拠: 単一責任、明確な境界

## Design Decisions

### Decision: LINE Messaging API採用
- **Context**: LINE Notify API終了（2025/3/31）に伴う代替手段選定
- **Alternatives Considered**:
  1. LINE Notify API継続 — サービス終了済みで使用不可
  2. LINE Messaging API — 公式推奨の後継サービス
  3. メール通知 — LINEの利便性に劣る
  4. Slack/Discord — 要件外のプラットフォーム変更
- **Selected Approach**: LINE Messaging API
  - Channel Access Tokenで認証
  - Push Message APIで通知送信
  - Flex Messageで構造化メッセージ対応
- **Rationale**:
  - LINE公式の推奨移行先
  - より高度なメッセージ機能
  - 長期サポート保証
- **Trade-offs**:
  - Benefits: 高機能、公式サポート、長期利用可能
  - Compromises: LINE Official Account作成必要、設定複雑化
- **Follow-up**:
  - ✅ requirements.md更新完了（LINE_NOTIFY_TOKEN → LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_ID → LINE_USER_ID）
  - ✅ tech.md更新完了（Required Secrets、Key Libraries、技術選定理由）
  - User ID/Group ID取得方法のドキュメント化（README作成時）

### Decision: Playwright自動ブラウザ選択（Chromium）
- **Context**: ブラウザ自動化エンジンとブラウザ種類の選定
- **Alternatives Considered**:
  1. Puppeteer — Chrome専用、GitHub Actions互換性低
  2. Selenium — 古い、複雑なセットアップ
  3. Playwright Chromium — 軽量、高速、安定
  4. Playwright Firefox/WebKit — クロスブラウザ不要
- **Selected Approach**: Playwright with Chromium browser
- **Rationale**:
  - GitHub Actions環境で実績豊富
  - ヘッドレス動作安定
  - スクリーンショット機能優秀
- **Trade-offs**:
  - Benefits: 高速、安定、軽量
  - Compromises: 単一ブラウザ依存（みまもるネットがChrome推奨のため問題なし）

### Decision: データ永続化戦略（GitHub Actionsアーティファクト）
- **Context**: 前回実行データとの変更検出実装
- **Alternatives Considered**:
  1. リポジトリコミット — git履歴汚染、権限管理複雑
  2. GitHub Actionsアーティファクト — 90日保持、ダウンロード/アップロードAPI
  3. 外部ストレージ（S3等） — インフラ追加、コスト増
  4. データベース — 過剰、保守負荷
- **Selected Approach**: GitHub Actionsアーティファクト
  - 前回実行データをJSONファイルとして保存
  - ワークフロー開始時にダウンロード
  - 比較後に新データをアップロード
- **Rationale**:
  - GitHub Actionsネイティブ機能
  - 追加インフラ不要
  - 90日保持で履歴確認可能
- **Trade-offs**:
  - Benefits: シンプル、コスト0、統合容易
  - Compromises: 90日後自動削除（毎日実行で問題なし）

### Decision: Docker環境とGitHub Actions環境の統一
- **Context**: ローカルテストとCI実行の一貫性確保
- **Alternatives Considered**:
  1. 別スクリプト — 保守コスト2倍、動作差分リスク
  2. 同一スクリプト、環境変数統一 — 一貫性高、保守性高
- **Selected Approach**: 単一エントリポイント、環境変数統一
  - index.js: 両環境共通
  - 環境変数名完全統一
  - package.jsonスクリプト共通化
- **Rationale**: DRY原則、環境間動作差分排除
- **Trade-offs**:
  - Benefits: 保守コスト削減、動作保証
  - Compromises: 環境変数設定方法のドキュメント必要

## Risks & Mitigations

- **Risk 1: LINE Messaging API設定の複雑性** — Proposed mitigation: 詳細なセットアップドキュメント、.env.exampleでの例示
- **Risk 2: みまもるネットDOM構造変更** — Proposed mitigation: セレクタ外部化、エラー時スクリーンショット自動保存
- **Risk 3: ユーザー切り替え失敗** — Proposed mitigation: リトライロジック実装（最大3回）、個別ユーザーエラー処理
- **Risk 4: タイムゾーン混乱（UTC vs JST）** — Proposed mitigation: README明記、cronコメント追加
- **Risk 5: Docker環境での認証情報管理** — Proposed mitigation: .envファイル.gitignore追加、.env.exampleテンプレート
- **Risk 6: GitHub Secretsマスキング不足** — Proposed mitigation: ログ出力前の明示的マスキング処理

## References
- [LINE Messaging API公式ドキュメント](https://developers.line.biz/ja/docs/messaging-api/) — LINE通知実装の主要リファレンス
- [Playwright公式ドキュメント](https://playwright.dev/docs/intro) — ブラウザ自動化の包括的ガイド
- [GitHub Actions - setup-node](https://github.com/actions/setup-node) — Node.js環境セットアップ
- [Node.js Release Schedule](https://github.com/nodejs/release) — Node.jsバージョンサポート状況
- [GitHub Actions - artifacts](https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts) — アーティファクト保存/取得
