FROM chainguard/wolfi-base:latest@sha256:5172a213d2bba8b1c9ca11957db65562b52b0f9844583a0347318ea5fd8e3aa5

# 0.5.1 published no Linux binary; 0.5.0 is the newest that has one.
# renovate: datasource=github-releases depName=str4d/age-plugin-yubikey extractVersion=^v(?<version>.+)$
ARG AGE_PLUGIN_YUBIKEY_VERSION=0.5.0
ARG AGE_PLUGIN_YUBIKEY_SHA256=019b35a13fc81be56d73d0723db0a2082fbd04c936c2c6836381111f7f51b2c3
# checksum-sync: sha256Arg=AGE_PLUGIN_YUBIKEY_SHA256 url=https://github.com/str4d/age-plugin-yubikey/releases/download/v${AGE_PLUGIN_YUBIKEY_VERSION}/age-plugin-yubikey-v${AGE_PLUGIN_YUBIKEY_VERSION}-x86_64-linux.tar.gz

# curl and jq talk to the UniFi OS API.
# pcsc-lite provides libpcsclite.so.1, needed by the age-plugin-yubikey binary.
# age, curl, jq and ca-certificates ride the wolfi-base digest pin — no version pin needed.
RUN apk add --no-cache \
        ca-certificates \
        age \
        curl \
        jq \
        pcsc-lite

RUN set -eu; \
    cd /tmp; \
    curl -fsSL -o age-plugin-yubikey.tar.gz "https://github.com/str4d/age-plugin-yubikey/releases/download/v${AGE_PLUGIN_YUBIKEY_VERSION}/age-plugin-yubikey-v${AGE_PLUGIN_YUBIKEY_VERSION}-x86_64-linux.tar.gz"; \
    echo "${AGE_PLUGIN_YUBIKEY_SHA256}  age-plugin-yubikey.tar.gz" | sha256sum -c -; \
    tar xzf age-plugin-yubikey.tar.gz; \
    mkdir -p /usr/local/bin; \
    install -m 0755 age-plugin-yubikey/age-plugin-yubikey /usr/local/bin/age-plugin-yubikey; \
    rm -rf age-plugin-yubikey.tar.gz age-plugin-yubikey

# wolfi's adduser is shadow-style (not busybox); -D = no password.
RUN adduser -D -u 1000 backup

COPY backup.sh /usr/local/bin/unifi-backup
RUN chmod 0755 /usr/local/bin/unifi-backup

COPY RECOVERY.md.tmpl /usr/share/unifi-backup/RECOVERY.md

ENV HOME=/tmp

USER 1000:1000
WORKDIR /tmp

ENTRYPOINT ["/usr/local/bin/unifi-backup"]
