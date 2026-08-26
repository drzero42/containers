# syntax=docker/dockerfile:1
#
# Odysseus AI (odysseus-dev/odysseus) built from upstream source at a pinned
# commit, plus kagi-cli. Upstream publishes no pullable image (their GHCR
# package is private), so we reproduce their root Dockerfile's build steps
# against a pinned checkout. If upstream's Dockerfile changes, this one must
# be re-synced — a build failure here is the signal.

ARG ODYSSEUS_SHA=451900fc151554f4c8654d1e4d3dadc1d029b047

# ---- pinned upstream checkout ----
FROM chainguard/wolfi-base:latest@sha256:0b613d8101fae27cf76186351db831ab3db25bfb2ec7161e897cd7e22c6413a3 AS src
ARG ODYSSEUS_SHA
RUN apk add --no-cache git \
    && git clone https://github.com/odysseus-dev/odysseus.git /src \
    && cd /src \
    && git checkout "${ODYSSEUS_SHA}" \
    && rm -rf .git

# ---- kagi-cli binary ----
FROM chainguard/wolfi-base:latest@sha256:0b613d8101fae27cf76186351db831ab3db25bfb2ec7161e897cd7e22c6413a3 AS kagi-fetch

# renovate: datasource=github-releases depName=Microock/kagi-cli extractVersion=^v(?<version>.+)$
ARG KAGI_VERSION=0.16.0
ARG KAGI_SHA256=ee4915686766660e43a2e2c5b2270790e4799783faae2ade1f77348fc06cb7c0
# checksum-sync: sha256Arg=KAGI_SHA256 url=https://github.com/Microck/kagi-cli/releases/download/v${KAGI_VERSION}/kagi-v${KAGI_VERSION}-x86_64-unknown-linux-gnu

RUN apk add --no-cache wget
RUN set -eu; \
    wget -O /kagi "https://github.com/Microck/kagi-cli/releases/download/v${KAGI_VERSION}/kagi-v${KAGI_VERSION}-x86_64-unknown-linux-gnu"; \
    echo "${KAGI_SHA256}  /kagi" | sha256sum -c -

# ---- builder: patched Real-ESRGAN wheels (mirrors upstream stage) ----
FROM python:3.14-slim AS realesrgan-wheels
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=src /src/docker/build-realesrgan-wheels.sh /usr/local/bin/build-realesrgan-wheels.sh
RUN bash /usr/local/bin/build-realesrgan-wheels.sh /wheels

# ---- app (mirrors upstream root Dockerfile) ----
FROM python:3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    curl \
    git \
    nodejs \
    npm \
    chromium \
    tmux \
    openssh-client \
    gosu \
    libgl1 \
    libglib2.0-0t64 \
    libxcb1 \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI (client only), same static tarball as upstream.
ARG DOCKER_CLI_VERSION=29.6.2
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
         amd64) DARCH=x86_64 ;; \
         arm64) DARCH=aarch64 ;; \
         *) echo "unsupported arch $ARCH"; exit 1 ;; \
       esac \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${DARCH}/docker-${DOCKER_CLI_VERSION}.tgz" \
       -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

WORKDIR /app

ARG INSTALL_OPTIONAL=false
COPY --from=src /src/requirements.txt /src/requirements-optional.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$INSTALL_OPTIONAL" = "true" ]; then pip install --no-cache-dir -r requirements-optional.txt; fi

RUN pip install --no-cache-dir python-magic==0.4.27

COPY --from=realesrgan-wheels /wheels/ /tmp/odysseus-wheels/
RUN pip install --no-cache-dir --no-deps /tmp/odysseus-wheels/*.whl \
    && rm -rf /tmp/odysseus-wheels

COPY --from=src /src/ .

RUN mkdir -p data logs services/cache/search

COPY --from=src /src/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# ---- our addition: kagi-cli on PATH ----
COPY --from=kagi-fetch /kagi /usr/local/bin/kagi
RUN chmod 0755 /usr/local/bin/kagi

EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
