# Playwright公式イメージを使用（Node.js + ブラウザ環境）
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# 依存関係インストール（npm ciで決定論的インストール。本番依存のみ）
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# スクリーンショット用ディレクトリ
RUN mkdir -p screenshots

CMD ["node", "src/index.js"]
