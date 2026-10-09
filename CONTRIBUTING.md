# Contributing to OpenWhisper

Contributions can include bug reports, documentation, tests, or code. Keep the interface, source
comments, and project documentation in English. Please use English in issues and pull requests so
the wider community can participate.

## Reporting bugs and discussing ideas

Check the [existing issues](https://github.com/juferdinand/OpenWhisper/issues) first. Include the
OpenWhisper version or commit, operating system, and steps to reproduce. For desktop problems,
also include the Linux distribution and desktop/session or the macOS version. Include the model,
dictation language, output mode, and affected target app when relevant. Remove private dictations,
tokens, and other confidential information from logs and reports.

For larger features, open an issue first to agree on goal and scope. Small fixes can be submitted
directly as pull requests.

## Working locally

The Electron application is in `app/` and uses strict TypeScript. Use Node.js 24–26 and npm:

```bash
npm ci --prefix app/ui
npm ci --prefix app
npm run setup --prefix app
npm run dev --prefix app -- --dev-profile /absolute/private/path/openwhisper-dev
```

Keep Dev data in a separate private profile. Do not use a stable validation candidate as an
isolated development app. The renderer lives in `app/ui/`, platform-neutral feature logic in
`app/src/core/`, host services in `app/src/services/`, Linux adapters in
`app/src/platforms/linux/`, and shared model data and test vectors in `app/data/`. See the
[platform architecture](docs/PLATFORMS.md#electron-source-layout) and
[development guide](docs/ELECTRON-DEVELOPMENT.md).

Run checks that cover the change:

```bash
npm run preflight --prefix app
npm run typecheck --prefix app
npm test --prefix app
npm run build --prefix app/ui
npm run test:ui --prefix app/ui
```

For focused application tests, run `node --import tsx --test` from `app/` with the relevant test
paths. `make test` runs the common application checks. `make linux` and `make mac` produce stable
validation candidates; they do not install or isolate the app. Do not launch a candidate against
an active profile. See [Electron status](docs/ELECTRON-STATUS.md) for current package and platform
acceptance boundaries. For documentation-only changes, check content, links, and formatting.

## Submitting a pull request

Describe the problem, the change, and how you verified it. Include a screenshot for visible
interface changes and a reproducible example for bug fixes. Link any related issue and state
which checks you could not perform.

Do not commit models, build output, recordings, personal configuration, or signing keys. Version
changes and releases are handled separately through the release workflow. Contributions to this
repository are published under the existing [MIT License](LICENSE).
