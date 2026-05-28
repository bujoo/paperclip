# Engineering Runbook

Reference guide for the Paperclip CI/CD pipeline, release process, and common operational tasks.

---

## CI/CD Pipeline Overview

### Pull Request (`pr.yml`)

Triggered on every PR targeting `master`. Three jobs run in parallel after `policy` passes:

| Job | What it does |
|---|---|
| `policy` | Blocks manual `pnpm-lock.yaml` edits; validates dep resolution when manifests change |
| `verify` | typecheck → unit tests → release-registry test → build → canary dry-run |
| `e2e` | Full Playwright suite against a locally-started Paperclip instance |

**All jobs must pass before merging.**

Node: 24, pnpm: 9.15.4, `--frozen-lockfile` enforced in verify.

### Canary Release (`release.yml` — push to master)

Triggered on every push to `master`:

```
verify_canary (typecheck + tests + build)
    └── publish_canary (npm publish with canary dist-tag)
        └── docker build+push (docker.yml, ghcr.io)
```

Canary is the "staging" deployment. Every merged PR that passes CI automatically publishes a new canary and Docker image.

### Stable Release (`release.yml` — workflow_dispatch)

Manual trigger with `source_ref` + optional `stable_date`:

```
verify_stable (typecheck + tests + build)
    └── publish_stable (npm publish with latest dist-tag + GitHub release)
        └── smoke test (release-smoke.yml against published canary/latest)
```

Stable versions follow `YYYY.MMDD.N` (e.g. `2026.527.0`).

### Lockfile Refresh (`refresh-lockfile.yml`)

Runs on every push to master. If `pnpm-lock.yaml` drifts from manifests, creates/updates a `chore/refresh-lockfile` PR with auto-merge enabled. CI owns the lockfile — never commit it in a feature PR.

### E2E (`e2e.yml`)

Manual trigger only (`workflow_dispatch`). Use for targeted browser verification. Accepts `skip_llm` flag (default: true) to bypass LLM-dependent assertions in CI.

### Docker (`docker.yml`)

Builds multi-arch (`linux/amd64`, `linux/arm64`) image and pushes to `ghcr.io`. Triggered by push to `master` and semver tags (`v*`).

---

## Deployment Gates

```
PR merge ──► verify (typecheck + tests + build + canary dry-run) must pass
                 └── e2e must pass
                         └── publish_canary (automatic)
                                 └── publish_stable (manual, human gated)
```

Tests must pass at every stage before deployment proceeds.

---

## Running the Pipeline Locally

### Default check (cheapest, use for most issue work)
```sh
pnpm test:run
```

### PR-ready handoff check
```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

### Full browser suite
```sh
pnpm test:e2e           # Playwright, requires built app
pnpm test:release-smoke # smoke tests against published dist-tag
```

### Release registry test
```sh
pnpm run test:release-registry
```

---

## Release Process

### Publish a canary
Merging to `master` publishes automatically. To trigger manually:

```sh
./scripts/release.sh canary
```

Dry-run preview:
```sh
./scripts/release.sh canary --dry-run
```

### Publish a stable release
Via GitHub Actions UI → Release workflow → set `source_ref` and `stable_date`.

Or locally (requires npm publish access):
```sh
./scripts/release.sh stable --date 2026-05-27
```

---

## Secrets Required in GitHub Actions

| Secret | Used by |
|---|---|
| `GITHUB_TOKEN` | docker.yml, refresh-lockfile.yml (auto-provided) |
| `ANTHROPIC_API_KEY` | e2e.yml (optional, for LLM assertions) |
| `NPM_TOKEN` | release.yml publish jobs |

---

## Troubleshooting

### "lockfile is out of date" in CI
The `chore/refresh-lockfile` PR should auto-merge. If blocked, check branch protection rules allow the bot. Do not manually fix the lockfile in your feature branch.

### E2E flake
E2E jobs use `PAPERCLIP_E2E_SKIP_LLM=true` in CI. If a test fails only in CI, check the uploaded Playwright report artifact (`playwright-report`).

### Canary publish fails
Check the `publish_canary` job in Actions. Common causes: npm token expiry, dist-tag conflict. Inspect `./scripts/release.sh canary --dry-run` output.

### Docker build fails on NTFS (local fork dev)
Use `node node_modules/vite/bin/vite.js build` instead of `npx vite build`. See AGENTS.md fork notes.

---

## Key Files

| Path | Purpose |
|---|---|
| `.github/workflows/pr.yml` | PR gate: policy + verify + e2e |
| `.github/workflows/release.yml` | Canary (auto) + stable (manual) npm publish |
| `.github/workflows/docker.yml` | Multi-arch Docker image push |
| `.github/workflows/e2e.yml` | Manual browser test trigger |
| `.github/workflows/refresh-lockfile.yml` | Auto-managed lockfile PRs |
| `scripts/release.sh` | Release script (canary/stable, --dry-run) |
| `vitest.config.ts` | Unit test configuration |
| `tests/e2e/` | Playwright browser test suite |
| `doc/DEVELOPING.md` | Dev setup and test commands |
| `doc/RELEASING.md` | Release process details |
