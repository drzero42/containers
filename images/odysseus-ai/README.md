# odysseus-ai

[Odysseus AI](https://github.com/odysseus-dev/odysseus) (self-hosted AI
workspace) built from upstream source at a pinned commit, with
[kagi-cli](https://github.com/Microck/kagi-cli) added on `PATH`. Nothing
else is changed — entrypoint, cmd, and exposed port match upstream.

Upstream publishes no pullable image (their GHCR package is private; the
official path is `docker compose up --build` from a repo clone), so this
image reproduces their root Dockerfile against a pinned checkout. If
upstream's Dockerfile changes, the pin bump build fails — re-sync this
Dockerfile against theirs when that happens.

## Image

- Registry: `ghcr.io/drzero42/odysseus-ai`
- Source pin: `ARG ODYSSEUS_SHA` — a commit on upstream `main` (the curated
  stable branch), never a rolling ref
- kagi-cli: version-pinned GitHub release binary, sha256-verified at build

## Running

Odysseus expects sidecar services (searxng, chromadb, optionally ntfy), so
the easiest path is upstream's own compose stack with the build swapped for
this image:

```sh
git clone https://github.com/odysseus-dev/odysseus.git
cd odysseus
cp .env.example .env
# in docker-compose.yml, replace the odysseus service's:
#     build: .
# with:
#     image: ghcr.io/drzero42/odysseus-ai:<tag>
docker compose up -d
```

Then open `http://localhost:7000`; the first admin password is printed in
`docker compose logs odysseus`. Pin by tag **and digest** — tags here are
rebuilt on every upstream bump.

## Updates

- **Odysseus source pin**: `.github/workflows/update-odysseus.yml` runs
  daily, compares upstream `main` HEAD to the pinned commit, and commits
  the bump to main, which triggers the normal build.
- **kagi-cli**: Renovate bumps `KAGI_VERSION`; CI recomputes
  `KAGI_SHA256` via `scripts/sync-checksums.sh`.

## kagi-cli

The binary is available as `kagi` (the app itself runs as root until the
entrypoint drops to `PUID`/`PGID`, default 1000:1000 — either way it's on
`PATH`). It needs a Kagi API key at runtime — supply it per kagi-cli's own
configuration (e.g. the `KAGI_API_KEY` environment variable); nothing is
baked into the image.
