FROM chainguard/wolfi-base:latest@sha256:5743937d521cbeb9e8c73bf1bd7ba2589c178940eb03d7b148efecc962be8587

# renovate: datasource=github-releases depName=bitwarden/clients extractVersion=^cli-v(?<version>.+)$
ARG BW_VERSION=2026.4.2
ARG BW_SHA256=431dbe784cc7de217cb3a826993eac451aa2fbaf336538c0ff6602c1ac884c91

# libstdc++ is needed by the bw binary (C++ runtime).
# wget is not in wolfi-base by default; install for the bw zip fetch.
# age and ca-certificates ride the wolfi-base digest pin — no version pin needed.
RUN apk add --no-cache \
        ca-certificates \
        age \
        libstdc++ \
        wget

RUN set -eu; \
    cd /tmp; \
    wget -O bw.zip "https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/bw-linux-${BW_VERSION}.zip"; \
    echo "${BW_SHA256}  bw.zip" | sha256sum -c -; \
    unzip bw.zip; \
    mkdir -p /usr/local/bin; \
    install -m 0755 bw /usr/local/bin/bw; \
    rm -f bw.zip bw

# wolfi's adduser is shadow-style (not busybox); -D = no password.
RUN adduser -D -u 1000 backup

COPY backup.sh /usr/local/bin/bitwarden-backup
RUN chmod 0755 /usr/local/bin/bitwarden-backup

ENV HOME=/tmp \
    BITWARDENCLI_APPDATA_DIR=/tmp/bw-appdata

USER 1000:1000
WORKDIR /tmp

ENTRYPOINT ["/usr/local/bin/bitwarden-backup"]
