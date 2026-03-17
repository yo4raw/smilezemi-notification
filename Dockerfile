# ステージ1: Goビルド
FROM golang:1.25-bookworm AS builder

WORKDIR /build

# ソースコード全体をコピー（vendor含む）
COPY . .

# vendorモードでビルド（ネットワーク不要）
RUN CGO_ENABLED=0 GOOS=linux go build -mod=vendor -o /crawler ./cmd/crawler
RUN CGO_ENABLED=0 GOOS=linux go build -mod=vendor -o /weekly ./cmd/weekly

# ステージ2: 実行環境（chromium + バイナリ）
FROM debian:bookworm-slim

# Chromiumと日本語フォント
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# バイナリをコピー
COPY --from=builder /crawler /app/crawler
COPY --from=builder /weekly /app/weekly

# データ・スクリーンショット用ディレクトリ
RUN mkdir -p data screenshots

# 実行コマンド（日次通知がデフォルト）
CMD ["/app/crawler"]
