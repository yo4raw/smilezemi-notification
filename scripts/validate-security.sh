#!/bin/bash
# セキュリティ検証スクリプト
#
# 目的:
# - 脆弱性スキャンの実行
# - 機密情報の漏洩チェック
# - HTTPS通信の確認
# - マスキング処理の確認

set -e

echo "🔒 セキュリティ検証を開始します..."
echo ""

# カラー出力用
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SUCCESS=0
WARNINGS=0
ERRORS=0

# 1. .envファイルがバージョン管理から除外されているか確認
echo "📋 1. .gitignoreのチェック"
if grep -q "^\.env$" .gitignore; then
  echo -e "${GREEN}✅ .envファイルが.gitignoreに含まれています${NC}"
  ((SUCCESS++))
else
  echo -e "${RED}❌ .envファイルが.gitignoreに含まれていません${NC}"
  ((ERRORS++))
fi
echo ""

# 2. 依存パッケージの脆弱性スキャン
echo "📋 2. 依存パッケージの脆弱性スキャン"
if npm audit --json > /tmp/audit-result.json 2>&1; then
  VULNERABILITIES=$(jq '.metadata.vulnerabilities.total' /tmp/audit-result.json)

  if [ "$VULNERABILITIES" -eq 0 ]; then
    echo -e "${GREEN}✅ 脆弱性は見つかりませんでした${NC}"
    ((SUCCESS++))
  else
    echo -e "${YELLOW}⚠️  $VULNERABILITIES 件の脆弱性が見つかりました${NC}"
    npm audit
    ((WARNINGS++))
  fi
else
  echo -e "${RED}❌ npm auditの実行に失敗しました${NC}"
  ((ERRORS++))
fi
echo ""

# 3. HTTPS通信の確認
echo "📋 3. HTTPS通信の使用確認"
HTTP_COUNT=$(grep -r "http://" src/ --include="*.js" | grep -v "https://" | wc -l | tr -d ' ')

if [ "$HTTP_COUNT" -eq 0 ]; then
  echo -e "${GREEN}✅ すべての通信がHTTPSを使用しています${NC}"
  ((SUCCESS++))
else
  echo -e "${RED}❌ HTTP通信が $HTTP_COUNT 箇所で見つかりました${NC}"
  grep -rn "http://" src/ --include="*.js" | grep -v "https://"
  ((ERRORS++))
fi
echo ""

# 4. マスキング処理の実装確認
echo "📋 4. マスキング処理の実装確認"

# パスワードマスキング
if grep -q "maskPasswordInError" src/auth.js; then
  echo -e "${GREEN}✅ パスワードマスキング処理が実装されています${NC}"
  ((SUCCESS++))
else
  echo -e "${RED}❌ パスワードマスキング処理が見つかりません${NC}"
  ((ERRORS++))
fi

# トークンマスキング
if grep -q "maskTokenInError" src/notifier.js; then
  echo -e "${GREEN}✅ トークンマスキング処理が実装されています${NC}"
  ((SUCCESS++))
else
  echo -e "${RED}❌ トークンマスキング処理が見つかりません${NC}"
  ((ERRORS++))
fi

# 汎用マスキング
if grep -q "maskSensitiveData" src/config.js; then
  echo -e "${GREEN}✅ 汎用マスキング処理が実装されています${NC}"
  ((SUCCESS++))
else
  echo -e "${RED}❌ 汎用マスキング処理が見つかりません${NC}"
  ((ERRORS++))
fi
echo ""

# 5. .envファイルの存在確認（警告のみ）
echo "📋 5. .envファイルの存在確認"
if [ -f .env ]; then
  echo -e "${GREEN}✅ .envファイルが存在します${NC}"

  # .envファイルの権限確認
  PERMISSIONS=$(stat -f "%Lp" .env 2>/dev/null || stat -c "%a" .env 2>/dev/null)
  if [ "$PERMISSIONS" = "600" ] || [ "$PERMISSIONS" = "400" ]; then
    echo -e "${GREEN}✅ .envファイルの権限が適切です (${PERMISSIONS})${NC}"
    ((SUCCESS++))
  else
    echo -e "${YELLOW}⚠️  .envファイルの権限を制限することを推奨します (現在: ${PERMISSIONS})${NC}"
    echo "   推奨コマンド: chmod 600 .env"
    ((WARNINGS++))
  fi
else
  echo -e "${YELLOW}⚠️  .envファイルが見つかりません（GitHub Actions環境では正常）${NC}"
  ((WARNINGS++))
fi
echo ""

# 6. ハードコードされた機密情報のチェック
echo "📋 6. ハードコードされた機密情報のチェック"
HARDCODED_SECRETS=0

# パスワードのハードコード検索
if grep -rn "password.*=.*['\"].*['\"]" src/ --include="*.js" | grep -v "password.*=.*process.env" | grep -v "password.*=.*'***'" | grep -v "// " | wc -l | tr -d ' ' | grep -q "^0$"; then
  echo -e "${GREEN}✅ ハードコードされたパスワードは見つかりませんでした${NC}"
else
  echo -e "${RED}❌ ハードコードされたパスワードの可能性があります${NC}"
  grep -rn "password.*=.*['\"].*['\"]" src/ --include="*.js" | grep -v "process.env" | grep -v "'***'"
  ((HARDCODED_SECRETS++))
fi

# トークンのハードコード検索
if grep -rn "token.*=.*['\"].*['\"]" src/ --include="*.js" | grep -v "token.*=.*process.env" | grep -v "token.*=.*'***'" | grep -v "// " | grep -v "LINE_API_ENDPOINT" | wc -l | tr -d ' ' | grep -q "^0$"; then
  echo -e "${GREEN}✅ ハードコードされたトークンは見つかりませんでした${NC}"
else
  echo -e "${RED}❌ ハードコードされたトークンの可能性があります${NC}"
  grep -rn "token.*=.*['\"].*['\"]" src/ --include="*.js" | grep -v "process.env" | grep -v "'***'" | grep -v "LINE_API_ENDPOINT"
  ((HARDCODED_SECRETS++))
fi

if [ $HARDCODED_SECRETS -eq 0 ]; then
  ((SUCCESS++))
else
  ((ERRORS++))
fi
echo ""

# 結果サマリー
echo "========================================================"
echo "セキュリティ検証結果"
echo "========================================================"
echo -e "${GREEN}✅ 成功: $SUCCESS 項目${NC}"

if [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}⚠️  警告: $WARNINGS 項目${NC}"
fi

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}❌ エラー: $ERRORS 項目${NC}"
  echo ""
  echo "エラーを修正してから再実行してください。"
  exit 1
else
  echo ""
  echo -e "${GREEN}✅ セキュリティ検証が完了しました！${NC}"

  if [ $WARNINGS -gt 0 ]; then
    echo ""
    echo "警告項目がありますが、動作には影響ありません。"
    echo "可能であれば警告項目も対応することを推奨します。"
  fi

  exit 0
fi
