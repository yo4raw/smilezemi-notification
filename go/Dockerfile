# ステージ1: Goビルド
FROM golang:1.24-bookworm AS builder

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# 日次通知バイナリ
RUN CGO_ENABLED=0 GOOS=linux go build -o /crawler .

# 週間レポートバイナリ
RUN CGO_ENABLED=0 GOOS=linux go build -o /weekly ./cmd/weekly

# ステージ2: 実行環境（chromium-headless-shell + バイナリ）
FROM debian:bookworm-slim

# chromium-headless-shell に必要なパッケージ
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
