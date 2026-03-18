FROM --platform=${BUILDPLATFORM:-linux/amd64} golang:1.25-alpine AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG TARGETOS
ARG TARGETARCH
ARG GIT_TAG
ARG GIT_COMMIT
ARG USERNAME=kutovoys
ARG REPOSITORY_NAME=xray-checker

ENV CGO_ENABLED=0
ENV GO111MODULE=on
ENV GOFLAGS="-mod=vendor"
ENV GOPROXY=https://goproxy.cn,direct

# Install UPX for binary compression
RUN apk add --no-cache upx

WORKDIR /app
COPY go.mod go.sum ./
COPY vendor/ ./vendor/

COPY . .
RUN ls -R

RUN CGO_ENABLED=${CGO_ENABLED} GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
  go build -v -ldflags="-s -w -X main.version=${GIT_TAG} -X main.commit=${GIT_COMMIT}" -o /usr/bin/xray-checker .

FROM alpine:3.21

ARG USERNAME=kutovoys
ARG REPOSITORY_NAME=xray-checker

LABEL org.opencontainers.image.source=https://github.com/${USERNAME}/${REPOSITORY_NAME}

RUN apk add --no-cache ca-certificates su-exec tzdata && \
  adduser -D -u 1000 appuser && \
  mkdir -p /app/geo

WORKDIR /app
COPY --from=builder /usr/bin/xray-checker /usr/bin/xray-checker
COPY geo/ /app/geo/
COPY scripts/entrypoint.sh /usr/bin/entrypoint.sh
RUN chown -R appuser:appuser /app
RUN chmod +x /usr/bin/entrypoint.sh

ENTRYPOINT ["/usr/bin/entrypoint.sh"]
