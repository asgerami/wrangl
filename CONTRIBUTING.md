# Contributing to Wrangl

Thanks for your interest in improving Wrangl. Bug reports, fixes, and new
features are all welcome.

- **Found a bug?** [Open an issue](https://github.com/asgerami/wrangl/issues)
  with the spec (or a minimal excerpt), the command you ran, and what
  happened.
- **Want to add something bigger?** Open an issue first, so we can agree on
  the approach before you write the code.
- **Found a security issue?** Don't open a public issue. Follow
  [SECURITY.md](SECURITY.md) instead.

## Development setup

You need Node.js 22 or newer.

```bash
git clone https://github.com/asgerami/wrangl.git
cd wrangl
npm install
npm run build
```

Run the CLI from source with `npm run dev`:

```bash
npm run dev -- inspect --spec examples/jsonplaceholder.yaml
npm run dev -- serve        # dashboard on http://localhost:4000
```

Running `npx @asgerami/wrangl` inside the checkout resolves to your local
copy, so it needs `npm run build` first.

The [Architecture](docs/ARCHITECTURE.md) doc explains how the pieces fit
together, and the [Guide](docs/GUIDE.md#project-layout) maps every source
file.

## Tests

```bash
npm run typecheck                # tsc --noEmit
npm test                         # full suite
WRANGL_SKIP_NETWORK=1 npm test   # skip tests that call public APIs
```

The suite includes unit tests, end-to-end tests that connect a real MCP
client to a generated server, OAuth flow tests, and ingestion tests against
real public specs (GitHub, Stripe, Discord, and more).

The PostgreSQL tests run only when `WRANGL_PG_URL` is set. To run them
locally, start a throwaway database:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_USER=wrangl \
  -e POSTGRES_PASSWORD=wrangl -e POSTGRES_DB=wrangl postgres:16
WRANGL_PG_URL=postgres://wrangl:wrangl@localhost:5432/wrangl npm test
```

CI runs typecheck, build, and tests on Node 22 and 24 for every push and
pull request, plus the PostgreSQL tests against a real database. A nightly
workflow runs the network tests against the live APIs.

## Pull requests

- Keep each pull request to one change, with tests for any behavior change.
- Make sure `npm run typecheck` and `npm test` pass.
- Add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md)
  for anything users would notice.
- Write commit messages in the
  [Conventional Commits](https://www.conventionalcommits.org) style, for
  example `fix(runtime): ...` or `feat(cli): ...`.

## Releases

Releases are published to npm with provenance by GitHub Actions when a
`v*` version tag is pushed. Maintainers bump the version in `package.json`,
move the `[Unreleased]` changelog entries under the new version, and push
the tag.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
