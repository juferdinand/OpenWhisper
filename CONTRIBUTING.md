# Contributing to WhisperFree

Contributions can include bug reports, documentation, tests, or code. The app interface,
source comments, and project documentation are in English. Please use English for issues
and pull requests so the wider community can participate.

## Reporting bugs and discussing ideas

Check the [existing issues](https://github.com/juferdinand/WhisperFree/issues) first.
A useful bug report includes:

- WhisperFree version or commit, macOS version, and Mac chip.
- Model, dictation language, output mode, and affected target app, if applicable.
- Steps to reproduce, expected behavior, and actual behavior.
- Relevant error messages without private dictations, tokens, or other confidential data.

For larger features, open an issue first to agree on the goal and scope.
Small fixes can be submitted directly as pull requests.

## Working locally

You need macOS 14+ and a recent Swift toolchain from Xcode or the Command Line Tools.
See the [README](README.md#installation) for installation and first launch.

1. Fork the repository and clone your fork.
2. Create a branch for your change, such as `git switch -c fix/clipboard`.
3. Keep the change focused on one clearly defined problem.
4. Verify relevant changes with:

```bash
make test
make mac
```

For documentation-only changes, check content, links, and formatting.
Changes to recording, permissions, hotkeys, or text insertion also need manual testing
on a Mac; the core tests do not cover all of this system integration.

## Structure and tests

- `macos/Sources/WhisperFreeCore/` contains testable text processing, the model catalog, and update validation.
- `macos/Sources/WhisperFree/` contains the interface and macOS integration.
- `shared/models.json` is the shared source for models and recommendations.
- `shared/test-vectors.json` contains text cleanup, vocabulary, and snippet tests. Add an appropriate case when fixing a processing bug.

Follow the surrounding code style. Change shared data formats deliberately, as they are also
intended for future platforms. Keep multilingual test inputs and expected results in their
original language; test names and comments should be in English.

## Submitting a pull request

Describe the problem, the change, and how you verified it. Include a screenshot for visible
interface changes and a reproducible example for bug fixes. Link any related issue and state
which checks you could not perform.

Do not commit models, build output, recordings, personal configuration, or signing keys.
Version changes and releases are handled separately through the release workflow.

Contributions to this repository are published under the existing [MIT License](LICENSE).
