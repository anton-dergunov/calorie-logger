FROM alpine:3.22

ARG PB_VERSION=0.39.10
ARG TARGETARCH

# sqlite is used only by the deployment helper, to carry accounts across a database rebuild.
RUN apk add --no-cache ca-certificates sqlite unzip wget \
    && DETECTED_ARCH="${TARGETARCH:-$(apk --print-arch)}" \
    && case "$DETECTED_ARCH" in \
         amd64|x86_64) PB_ARCH="amd64" ;; \
         arm64|aarch64) PB_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: $DETECTED_ARCH"; exit 1 ;; \
       esac \
    && wget -q -O /tmp/pocketbase.zip \
       "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" \
    && unzip /tmp/pocketbase.zip -d /pb \
    && rm /tmp/pocketbase.zip

WORKDIR /pb
COPY pocketbase/pb_migrations /pb/pb_migrations
COPY pocketbase/pb_hooks /pb/pb_hooks
COPY pocketbase/pb_public /pb/pb_public
# Always present, so the macOS download route can register even when no application has been
# published to this server yet.
RUN mkdir -p /pb/downloads

EXPOSE 8090
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8090"]
