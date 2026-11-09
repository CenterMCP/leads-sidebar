FROM node:22-alpine AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
COPY scripts/build-ui.mjs ./scripts/build-ui.mjs
COPY tsconfig.json ./
RUN mkdir -p internal/leads && npm run typecheck && npm run build:ui

FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY cmd ./cmd
COPY --from=ui /app/internal/leads/app.html ./internal/leads/app.html
RUN CGO_ENABLED=0 go build -o /leads-sidebar ./cmd/server

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D app && mkdir /data && chown app:app /data
COPY --from=builder /leads-sidebar /usr/local/bin/leads-sidebar
USER app
ENV HOST=0.0.0.0 PORT=3005 LEADS_DATA_DIR=/data
EXPOSE 3005
ENTRYPOINT ["leads-sidebar"]
