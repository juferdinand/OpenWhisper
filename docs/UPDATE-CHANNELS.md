# Update channels

The stable channel is the default. It reads only the repository's stable latest release and rejects GitHub prereleases. Selecting Preview is an explicit, persisted opt-in. Update checks remain optional and do not affect recording.

## Preview release admission

Preview checks use the fixed OpenWhisper GitHub releases API and consider published releases marked as prereleases. Drafts are not admitted. The client selects the highest canonical numeric version from the bounded response, then checks the exact versioned release page and assets. If the response contains 100 releases, malformed prerelease metadata, or no published preview, the check fails closed or reports no update.

macOS previews must provide exactly one `OpenWhisper-macOS.zip` at the canonical release download URL. The existing persistent publisher, bundle identity, archive, installed-tree, and update-source checks still apply.

Linux previews must provide exactly one `latest.json` at `releases/download/vVERSION/latest.json`. Its selected AppImage or Debian target must name the canonical artifact for that same version and carry the existing version-bound Minisign signature. The fixed repository, package identity, signing key, installed-tree and package checks remain unchanged.

## Version ordering

Release tags and package versions use the existing canonical `MAJOR.MINOR.PATCH` triplet. A preview consumes its version number. A stable release that supersedes a preview must use a greater triplet; for example, after preview `0.5.5`, stable must be `0.5.6` or newer. The application compares numeric components, so changing back to Stable never offers an older package as an update. The client never installs an update unless its version is greater than the running version.

The preview release needs the same verified package assets as a stable release and must be published as a GitHub prerelease. This document describes feed admission; it does not publish a release or change signing identities.
