import assert from "node:assert/strict";
import { test } from "node:test";
import { isNewerUpdateVersion, LINUX_UPDATE_FEED_URL, LINUX_UPDATE_REPOSITORY, MACOS_UPDATE_ASSET,
  macosUpdateEndpoint, parseUpdateVersion, projectLinuxUpdateFeed, projectMacosUpdateRelease, UPDATE_POLICY_LIMITS,
  UpdatePolicyError } from "../src/services/update-policy.js";

const repository = "juferdinand/OpenWhisper", version = "0.3.1", currentVersion = "0.3.0";
const macURL = `https://github.com/${repository}/releases/download/v${version}/${MACOS_UPDATE_ASSET}`;
const macPage = `https://github.com/${repository}/releases/tag/v${version}`;
const macRelease = () => ({ tag_name: `v${version}`, html_url: macPage, draft: false, prerelease: false, body: "Release notes",
  assets: [{ name: MACOS_UPDATE_ASSET, browser_download_url: macURL }] });
const mac = (release: unknown = macRelease(), overrides: Record<string, unknown> = {}) => projectMacosUpdateRelease({ repository, currentVersion, release, ...overrides });
const linuxFeed = () => ({ version, notes: "Release notes", pub_date: "2026-10-09T00:00:00Z", platforms: {
  "linux-x86_64-appimage": { url: `${LINUX_UPDATE_REPOSITORY}/releases/download/v${version}/OpenWhisper-Linux-x86_64.AppImage`, signature: "opaque announced AppImage signature" },
  "linux-x86_64-deb": { url: `${LINUX_UPDATE_REPOSITORY}/releases/download/v${version}/OpenWhisper-Linux-amd64.deb`, signature: "opaque announced Debian signature" },
} });
const linux = (feed: unknown = linuxFeed(), overrides: Record<string, unknown> = {}) => projectLinuxUpdateFeed({ sourceURL: LINUX_UPDATE_FEED_URL, package: "appimage", currentVersion, feed, ...overrides });
const failure = (code: string) => (error: unknown): boolean => error instanceof UpdatePolicyError && error.code === code && error.message === code;

test("canonical versions retain exact unsigned 64-bit components and numerical ordering", () => {
  assert.deepEqual(parseUpdateVersion("18446744073709551615.9007199254740993.0"), [18_446_744_073_709_551_615n, 9_007_199_254_740_993n, 0n]);
  assert.ok(Object.isFrozen(parseUpdateVersion("0.0.0")));
  for (const [candidate, current] of [["0.10.0", "0.2.1"], ["1.2.10", "1.2.9"], ["9007199254740993.0.0", "9007199254740992.0.0"]]) {
    assert.equal(isNewerUpdateVersion(candidate, current), true); assert.equal(isNewerUpdateVersion(current, candidate), false);
  }
  assert.equal(isNewerUpdateVersion(version, version), false);
});
test("malformed versions and overflow cannot become newer candidates", () => {
  for (const value of ["", "1", "1.2", "1.2.3.4", "1.2.-3", "1.2.3-beta", "01.2.3", "1..3", "1.2.3\n", "1.2.3\r", "1.2.3 ",
    "v1.2.3", "+1.2.3", "١.2.3", "18446744073709551616.0.0", "9".repeat(1000), null, 123]) {
    assert.throws(() => parseUpdateVersion(value), failure("INVALID_VERSION"));
    assert.equal(isNewerUpdateVersion(value, "0.0.0"), false); assert.equal(isNewerUpdateVersion("1.2.3", value), false);
  }
});
test("Mac repositories are build-supplied canonical owner/repo values", () => {
  assert.equal(macosUpdateEndpoint(repository), `https://api.github.com/repos/${repository}/releases/latest`);
  assert.equal(macosUpdateEndpoint("owner/repo.name-1"), "https://api.github.com/repos/owner/repo.name-1/releases/latest");
  for (const invalid of [undefined, "", "owner", "owner/.", "owner/..", "owner/repo/extra", "owner/repo\n", "owner/repo?x", "owner_/repo", "owner/" + "a".repeat(257)]) {
    assert.throws(() => macosUpdateEndpoint(invalid), failure("INVALID_REPOSITORY"));
    assert.throws(() => mac(macRelease(), { repository: invalid }), failure("INVALID_REPOSITORY"));
  }
});
test("Mac release projection remains immutable and explicitly unauthenticated", () => {
  const release = { ...macRelease(), author: { private: "not projected" } }, candidate = mac(release);
  assert.deepEqual(candidate, { authentication: "unauthenticated", package: "macos", repository, version, notes: "Release notes", assetName: MACOS_UPDATE_ASSET, assetURL: macURL, pageURL: macPage });
  assert.ok(Object.isFrozen(candidate)); release.body = "changed"; assert.equal(candidate.notes, "Release notes");
  assert.equal(mac({ ...macRelease(), body: null }).notes, "");
  const missing = macRelease(); Reflect.deleteProperty(missing, "body"); assert.equal(mac(missing).notes, "");
  assert.equal(mac({ ...macRelease(), assets: [...macRelease().assets, { name: "OpenWhisper-macOS.dmg", browser_download_url: "https://github.com/unrelated/manual.dmg" }] }).assetName, MACOS_UPDATE_ASSET);
});
test("Mac source policy rejects foreign or normalized asset and page URLs", () => {
  for (const bad of [macURL.replace("https:", "http:"), macURL.replace("github.com", "github.com.evil.invalid"), macURL.replace("juferdinand", "other"),
    macURL.replace("v0.3.1", "v0.3.0"), macURL.replace(MACOS_UPDATE_ASSET, "another.zip"), `${macURL}?x=1`, `${macURL}#fragment`,
    macURL.replace("github.com", "github.com:443"), macURL.replace("OpenWhisper-macOS.zip", "%4FpenWhisper-macOS.zip")]) {
    assert.throws(() => mac({ ...macRelease(), assets: [{ name: MACOS_UPDATE_ASSET, browser_download_url: bad }] }), failure("INVALID_SOURCE"));
  }
  for (const bad of [`${macPage}?x=1`, `${macPage}#fragment`, macPage.replace("juferdinand", "other")]) assert.throws(() => mac({ ...macRelease(), html_url: bad }), failure("INVALID_SOURCE"));
});
test("Mac candidates require one expected asset, stable release fields and a newer canonical version", () => {
  for (const assets of [[], [{ name: "OpenWhisper-macOS.dmg", browser_download_url: macURL }], [...macRelease().assets, ...macRelease().assets]]) {
    assert.throws(() => mac({ ...macRelease(), assets }), failure("INVALID_SOURCE"));
  }
  for (const field of ["draft", "prerelease"]) {
    assert.throws(() => mac({ ...macRelease(), [field]: true }), failure("INVALID_METADATA"));
    const missing = macRelease(); Reflect.deleteProperty(missing, field); assert.throws(() => mac(missing), failure("INVALID_METADATA"));
  }
  for (const tag_name of ["0.3.1", "v00.3.1", "v0.3.1-beta", "v0.3.1\n"]) assert.throws(() => mac({ ...macRelease(), tag_name }), failure("INVALID_VERSION"));
  for (const tag_name of ["v0.3.0", "v0.2.5"]) assert.throws(() => mac({ ...macRelease(), tag_name }), failure("NOT_NEWER"));
  assert.throws(() => mac(macRelease(), { currentVersion: "broken" }), failure("INVALID_VERSION"));
});
test("Linux projects only the selected fixed target and opaque unverified signature", () => {
  for (const packageKind of ["appimage", "deb"] as const) {
    const candidate = linux(linuxFeed(), { package: packageKind });
    assert.equal(candidate.package, packageKind); assert.equal(candidate.feedURL, LINUX_UPDATE_FEED_URL);
    assert.equal(candidate.target, packageKind === "deb" ? "linux-x86_64-deb" : "linux-x86_64-appimage");
    assert.equal(candidate.authentication, "unauthenticated"); assert.ok(Object.isFrozen(candidate));
    assert.equal(candidate.assetURL, linuxFeed().platforms[candidate.target].url);
    assert.equal(candidate.signature, linuxFeed().platforms[candidate.target].signature);
    assert.equal(Object.hasOwn(candidate, "pub_date"), false);
  }
  const missing = linuxFeed(); Reflect.deleteProperty(missing, "notes"); assert.equal(linux(missing).notes, "");
});
test("Linux rejects any alternate feed, unadmitted package and wrong package source", () => {
  for (const sourceURL of [LINUX_UPDATE_FEED_URL.replace("https:", "http:"), LINUX_UPDATE_FEED_URL.replace("juferdinand", "other"), `${LINUX_UPDATE_FEED_URL}?x=1`, `${LINUX_UPDATE_FEED_URL}#fragment`, undefined]) {
    assert.throws(() => linux(linuxFeed(), { sourceURL }), failure("INVALID_SOURCE"));
  }
  for (const packageKind of ["development", "macos", "rpm", "linux-x86_64-appimage", undefined]) assert.throws(() => linux(linuxFeed(), { package: packageKind }), failure("INVALID_PACKAGE"));
  const original = linuxFeed().platforms["linux-x86_64-appimage"].url;
  for (const url of [original.replace("https:", "http:"), original.replace("github.com", "github.com.evil.invalid"), original.replace("juferdinand", "other"),
    original.replace("v0.3.1", "v0.3.0"), `${original}?x=1`, `${original}#fragment`, linuxFeed().platforms["linux-x86_64-deb"].url]) {
    const feed = linuxFeed(); feed.platforms["linux-x86_64-appimage"].url = url; assert.throws(() => linux(feed), failure("INVALID_SOURCE"));
  }
});
test("Linux requires selected target and nonblank signature without claiming cryptographic acceptance", () => {
  const missingTarget = linuxFeed(); Reflect.deleteProperty(missingTarget.platforms, "linux-x86_64-appimage"); assert.throws(() => linux(missingTarget), failure("INVALID_METADATA"));
  for (const signature of [undefined, "", " \n\t", 1]) {
    const feed = linuxFeed(); Reflect.set(feed.platforms["linux-x86_64-appimage"], "signature", signature); assert.throws(() => linux(feed), failure("INVALID_METADATA"));
  }
  for (const announced of [currentVersion, "0.2.5"]) assert.throws(() => linux({ ...linuxFeed(), version: announced }), failure("NOT_NEWER"));
  assert.throws(() => linux({ ...linuxFeed(), version: "0.3.1-beta" }), failure("INVALID_VERSION"));
  assert.throws(() => linux(linuxFeed(), { currentVersion: "broken" }), failure("INVALID_VERSION"));
});
test("projection bounds UTF-8 notes, signature fields and assets before visiting excessive arrays", () => {
  const boundary = "é".repeat(UPDATE_POLICY_LIMITS.notesBytes / 2);
  assert.equal(mac({ ...macRelease(), body: boundary }).notes, boundary);
  assert.equal(linux({ ...linuxFeed(), notes: boundary }).notes, boundary);
  assert.throws(() => mac({ ...macRelease(), body: boundary + "é" }), failure("INVALID_METADATA"));
  assert.throws(() => linux({ ...linuxFeed(), notes: boundary + "é" }), failure("INVALID_METADATA"));
  const excessive = new Array<unknown>(UPDATE_POLICY_LIMITS.assets + 1); let visited = false;
  Object.defineProperty(excessive, 0, { get() { visited = true; throw new Error("Must not visit excessive assets"); } });
  assert.throws(() => mac({ ...macRelease(), assets: excessive }), failure("INVALID_METADATA"));
  assert.equal(visited, false);
  const feed = linuxFeed(); feed.platforms["linux-x86_64-appimage"].signature = "s".repeat(UPDATE_POLICY_LIMITS.signatureBytes + 1);
  assert.throws(() => linux(feed), failure("INVALID_METADATA"));
  assert.throws(() => mac({ ...macRelease(), assets: [{ name: MACOS_UPDATE_ASSET, browser_download_url: "x".repeat(2049) }] }), failure("INVALID_METADATA"));
});
test("inherited required fields and arbitrary getter failures never project or leak private errors", () => {
  assert.throws(() => mac(Object.create(macRelease()) as unknown), failure("INVALID_METADATA"));
  assert.throws(() => linux(Object.create(linuxFeed()) as unknown), failure("INVALID_METADATA"));
  const asset = Object.create(macRelease().assets[0]!) as unknown;
  assert.throws(() => mac({ ...macRelease(), assets: [asset] }), failure("INVALID_METADATA"));
  const target = Object.create(linuxFeed().platforms["linux-x86_64-appimage"]) as unknown;
  assert.throws(() => linux({ ...linuxFeed(), platforms: { "linux-x86_64-appimage": target } }), failure("INVALID_METADATA"));
  const privateSource = macRelease(); Object.defineProperty(privateSource, "html_url", { get() { throw new Error("Private path and token"); } });
  assert.throws(() => mac(privateSource), failure("INVALID_METADATA"));
  for (const invalid of [null, [], "text", 0]) { assert.throws(() => mac(invalid), failure("INVALID_METADATA")); assert.throws(() => linux(invalid), failure("INVALID_METADATA")); }
});
