FROM docker.io/library/node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS test
WORKDIR /src
COPY server.mjs server.test.mjs ./
RUN node --test

FROM docker.io/library/node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# No dependencies: the shim uses only Node's built-in http and fetch.
WORKDIR /app
# Copied from the test stage so BuildKit can't skip the tests.
COPY --from=test /src/server.mjs ./

# The base image's unprivileged "node" user (uid 1000).
USER 1000:1000
EXPOSE 8181
CMD ["node", "/app/server.mjs"]
