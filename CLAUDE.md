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

CI handles publishing — on push to `main`, each image is tagged `latest` and `sha-<short>` and pushed to `ghcr.io/<owner>/<name>`. PRs build but do not push. No manual `docker push` workflow.

## Adding a new image

1. Create `images/<name>/Dockerfile` (plus any context files).
2. Push. CI picks it up automatically from the `images/*` directory glob — no workflow edits needed.

## Intentionally not here

- No task runner (no `Taskfile.yml`, no `Makefile`) — `docker buildx build` is short enough.
- No Dockerfile linter or image scanner in CI yet. Add when an image actually warrants it.
- No multi-arch builds yet (linux/amd64 only). Extend `build.yml` with `platforms:` when needed.
