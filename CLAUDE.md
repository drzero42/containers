# containers

Container images I build and publish for my own use. Each image lives in its own directory and is published to GitHub Container Registry.

## Layout

- `images/<name>/` — one directory per image, containing a `Dockerfile` plus any context files. The directory name is the image name.
- `.github/workflows/build.yml` — CI that discovers images, builds them on every push/PR, and pushes to `ghcr.io/<owner>/<name>` on `main`.

## Building locally

Docker, buildx, and git come from the host — not from devenv. The devenv scaffold exists so per-image build tooling (e.g. `uv`, `node`) can be added to `devenv.nix` when an image needs it.

```sh
docker buildx build -t <name>:dev images/<name>
```

## Publishing

CI handles publishing — on push to `main`, each image is tagged `YYYY-MM-DD-N` (N starts at 1 and increments per same-day rebuild) and `latest`, then pushed to `ghcr.io/<owner>/<name>`. PRs build but do not push. Consumers should pin by tag and digest.

## Adding a new image

1. Create `images/<name>/Dockerfile` (plus any context files).
2. Push. CI picks it up automatically from the `images/*` directory glob — no workflow edits needed.

## Conventions

- Secrets: every secret input on a k8s-bound image accepts both `FOO` env var and `FOO_FILE` (path to mounted Secret volume); both set is an error. Files are preferred for security — env vars are the fallback for local runs.
- Pinned downloads: a release pinned by `ARG <X>_VERSION` + `ARG <X>_SHA256` gets a `# checksum-sync: sha256Arg=<X>_SHA256 url=<download-url with ${VERSION} refs>` annotation right after the SHA arg. Renovate bumps only the version (it can't track these hashes — `cli-v` tags vs bare-version asset names defeat its digest support). `scripts/sync-checksums.sh` recomputes the hash from the pinned version; CI runs it before each build (so a bump builds green) and the `persist-checksums` job commits the corrected hash onto the PR branch. That commit is authored by `github-actions[bot]`, whose email is in `renovate.json`'s `gitIgnoredAuthors` so Renovate doesn't treat the branch as foreign-edited and stop managing it (its `keepUpdatedLabel` does NOT cover bot edits — `gitIgnoredAuthors` is the right knob). Tradeoff: the build-time `sha256sum -c` still guards against corrupted downloads, but auto-sync adopts whatever bytes upstream serves at bump time rather than detecting upstream re-publishing a version.

## Intentionally not here

- No task runner (no `Taskfile.yml`, no `Makefile`) — `docker buildx build` is short enough.
- No Dockerfile linter or image scanner in CI yet. Add when an image actually warrants it.
- No multi-arch builds yet (linux/amd64 only). Extend `build.yml` with `platforms:` when needed.
