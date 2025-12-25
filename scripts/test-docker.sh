#!/bin/bash
# Docker環境テストスクリプト
#
# 目的:
# - Docker環境のセットアップ確認
# - コンテナのビルドとテスト実行
# - エンドツーエンドテストの実行

set -e

# カラー出力用
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🐳 Docker環境テストを開始します...${NC}"
echo ""

# 1. .envファイルの存在確認
echo "📋 1. .envファイルの確認"
if [ ! -f .env ]; then
  echo -e "${RED}❌ .envファイルが見つかりません${NC}"
  echo ""
  echo "対処方法:"
  echo "  1. .env.exampleをコピーして.envを作成してください:"
  echo "     cp .env.example .env"
  echo "  2. .envファイルに実際の認証情報を記入してください"
  echo ""
  exit 1
fi
echo -e "${GREEN}✅ .envファイルが見つかりました${NC}"
echo ""

# 2. 環境変数の検証
echo "📋 2. 環境変数の検証"
if [ -f scripts/validate-env.js ]; then
  if node scripts/validate-env.js; then
    echo -e "${GREEN}✅ 環境変数の検証が完了しました${NC}"
  else
    echo -e "${RED}❌ 環境変数の検証に失敗しました${NC}"
    echo "上記のエラーを修正してから再実行してください。"
    exit 1
  fi
else
  echo -e "${YELLOW}⚠️  環境変数検証スクリプトが見つかりません（スキップ）${NC}"
fi
echo ""

# 3. Dockerイメージのビルド
echo "📋 3. Dockerイメージのビルド"
echo -e "${BLUE}ビルド開始...${NC}"

if docker-compose build; then
  echo -e "${GREEN}✅ Dockerイメージのビルドが完了しました${NC}"
else
  echo -e "${RED}❌ Dockerイメージのビルドに失敗しました${NC}"
  exit 1
fi
echo ""

# 4. コンテナの起動とテスト実行
echo "📋 4. コンテナでのテスト実行"
echo -e "${BLUE}テスト実行中...${NC}"

if docker-compose run --rm app npm test; then
  echo -e "${GREEN}✅ テストが成功しました${NC}"
else
  echo -e "${RED}❌ テストに失敗しました${NC}"
  exit 1
fi
echo ""

# 5. エンドツーエンドテスト（オプション）
echo "📋 5. エンドツーエンドテストの実行"
echo -e "${YELLOW}注意: 実際のみまもるネットとLINE APIに接続します${NC}"
echo ""

read -p "エンドツーエンドテストを実行しますか？ (y/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${BLUE}エンドツーエンドテスト実行中...${NC}"

  # 既存のデータとスクリーンショットをバックアップ
  if [ -d data ]; then
    echo "既存のデータをバックアップ中..."
    cp -r data data.backup.$(date +%s)
  fi

  if [ -d screenshots ]; then
    echo "既存のスクリーンショットをバックアップ中..."
    cp -r screenshots screenshots.backup.$(date +%s)
  fi

  # コンテナを起動してクローラーを実行
  if docker-compose up; then
    echo -e "${GREEN}✅ エンドツーエンドテストが成功しました${NC}"
    echo ""
    echo "📊 結果の確認:"
    echo "  - データ: data/mission_data.json"
    echo "  - スクリーンショット: screenshots/"
    echo ""
  else
    echo -e "${RED}❌ エンドツーエンドテストに失敗しました${NC}"
    echo ""
    echo "📸 エラーの確認:"
    echo "  - スクリーンショット: screenshots/"
    echo "  - ログ: docker-compose logs"
    echo ""
    exit 1
  fi
else
  echo -e "${YELLOW}エンドツーエンドテストをスキップしました${NC}"
fi
echo ""

# 6. クリーンアップ
echo "📋 6. クリーンアップ"
read -p "Dockerイメージとコンテナをクリーンアップしますか？ (y/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "クリーンアップ中..."
  docker-compose down --volumes --remove-orphans
  echo -e "${GREEN}✅ クリーンアップが完了しました${NC}"
else
  echo -e "${YELLOW}クリーンアップをスキップしました${NC}"
  echo "手動でクリーンアップする場合は以下を実行してください:"
  echo "  docker-compose down --volumes --remove-orphans"
fi
echo ""

# 結果サマリー
echo "========================================================"
echo "Docker環境テスト完了"
echo "========================================================"
echo -e "${GREEN}✅ Docker環境が正しく構築されています${NC}"
echo ""
echo "次のステップ:"
echo "  1. GitHub Actionsでの実行テスト"
echo "  2. 本番環境での定期実行の確認"
echo ""
