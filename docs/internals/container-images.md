# Container images

Which images VaultOre runs, and what the Dockerfiles under `containers/` are. The map of the repository is [ARCHITECTURE.md](../../ARCHITECTURE.md).

| Image | Used for |
|-------|----------|
| `runtime.image`, default `oven/bun:1-alpine` | Every `ore:ts` and `ore:shell` cell |
| `alpine:3.19` | Only the integration-test helper `waitForContainerView` |

The Dockerfiles under `containers/` are not built by CI, not published, and not referenced by
the code. They sketch images for a possible future (`bun-base`, `shell-base`, `python-base`,
`go-builder`); each says so in its header.
