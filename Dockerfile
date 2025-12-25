# Playwright公式イメージを使用（Node.js + ブラウザ環境）
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# 作業ディレクトリ設定
WORKDIR /app

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係インストール（npm ciで決定論的インストール）
RUN npm ci --only=production

# アプリケーションコードをコピー
COPY . .

# スクリーンショット、データ、ログ用ディレクトリ作成
RUN mkdir -p screenshots data logs

# 実行コマンド
CMD ["node", "src/index.js"]
