# Publishing

Releases after 0.1.0 are created only by `.github/workflows/release-please.yml`.
The first release is the one exception, see below.

1. Merge conventional `feat`, `fix`, or breaking commits into `main`.
2. Release Please opens or updates a release PR containing the version bump and
   changelog.
3. Review and merge that PR.
4. The workflow creates the immutable GitHub tag and release. The `build` job
   installs from `package-lock.json`, performs a clean build, verifies every
   package export, checks formatting, runs tests, typechecking, and linting,
   then packs the tarball. It has no publish rights. The `publish` job holds the
   OIDC token, checks out no code and installs no dependencies. It checks the
   tarball's version against the tag and publishes that tarball through npm
   trusted publishing with provenance.

Do not run `npm version`, `npm publish`, or create release tags manually.

## First release

Version 0.1.0 was published by hand from the commit tagged `v0.1.0`. npm trusted
publishing is configured in the settings of an existing package, so the first
version cannot use it. Every later release goes through the workflow.
`.release-please-manifest.json` records 0.1.0 as the current version, and
`release-please-config.json` holds the release settings.

## Publish recovery

If the publish job fails after the tag was created, rerun the failed GitHub
Actions job first. If that rerun is no longer available, manually dispatch the
`Release` workflow and provide the existing tag, such as `v0.2.1`. Recovery
checks out that tag and refuses to publish unless it exactly matches the version
in `package.json`.

The npm package's trusted-publisher configuration must name this repository and
the workflow file `release-please.yml` exactly. To check it without publishing,
dispatch the `Release` workflow with an existing tag and `dry_run` checked. The
publish job then runs `npm publish --dry-run` and fails unless npm accepted the
OIDC token exchange.

Release Please writes with a GitHub App token, not `GITHUB_TOKEN`. GitHub holds
the checks of a pull request that `github-actions[bot]` opens until a maintainer
approves them, and a release PR opened by the App runs its checks at once. The
App needs contents, pull requests, and issues write access, and it must be
installed on this repository. The repository variable `RELEASE_APP_CLIENT_ID`
holds its client ID and the secret `RELEASE_APP_PRIVATE_KEY` holds a private
key. If the key leaks or the App is deleted, generate a new key in the App's
settings and replace the secret.

## Local verification

```sh
npm ci
npm run build:clean
npm run verify:package
npm run format:check
npm run test
npm run typecheck
npm run lint
npm pack --dry-run
(cd e2e && ./e2e.sh)
```

`e2e.sh` needs no Convex account. It runs two anonymous local deployments on
port 3510 (`E2E_PORT` changes it) and takes about seven minutes. `E2E_LONG=1`
adds a run of more than five minutes through the CLI, which checks the 300 s
limit of `npx convex run`. Run it before a release that touches the CLI or the
driver.

`build:clean` uses the committed Convex generated files and therefore works in
clean CI without a deployment. Maintainers who intentionally change the
component API should regenerate those files separately with
`npm run build:codegen` while connected to a development deployment.
