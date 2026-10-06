pub const REPOSITORY: &str = "https://github.com/juferdinand/WhisperFree";
pub const ENDPOINT: &str =
    "https://github.com/juferdinand/WhisperFree/releases/latest/download/latest.json";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Package {
    AppImage,
    Debian,
}
impl Package {
    pub fn asset(self) -> &'static str {
        match self {
            Self::AppImage => "WhisperFree-Linux-x86_64.AppImage",
            Self::Debian => "WhisperFree-Linux-amd64.deb",
        }
    }
    pub fn target(self) -> &'static str {
        match self {
            Self::AppImage => "linux-x86_64-appimage",
            Self::Debian => "linux-x86_64-deb",
        }
    }
}

fn version(value: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|s| {
            s.is_empty()
                || !s.bytes().all(|c| c.is_ascii_digit())
                || s.len() > 1 && s.starts_with('0')
        })
    {
        return Err("Update version must use X.Y.Z format".into());
    }
    let mut result = [0; 3];
    for (i, s) in parts.iter().enumerate() {
        result[i] = s.parse().map_err(|_| "Update version is out of range")?;
    }
    Ok(result)
}

/// Signatures also bind the payload to its version (Tauri requireSignedVersion).
/// Only this repository's exact release asset for the announced version is accepted.
pub fn validate(candidate: &str, current: &str, url: &str, package: Package) -> Result<(), String> {
    if version(candidate)? <= version(current)? {
        return Err("The update must be newer than the installed version".into());
    }
    let expected = format!(
        "{REPOSITORY}/releases/download/v{candidate}/{}",
        package.asset()
    );
    if url != expected {
        return Err("Update source does not match the expected release package".into());
    }
    Ok(())
}

/// Used by release tooling to verify the same signed version required by the native updater.
pub fn verify_artifact(
    data: &[u8],
    signature: &str,
    public_key: &str,
    announced: &str,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    version(announced)?;
    let decode = |value: &str| -> Result<String, String> {
        String::from_utf8(STANDARD.decode(value.trim()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    };
    let public =
        minisign_verify::PublicKey::decode(&decode(public_key)?).map_err(|e| e.to_string())?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    public
        .verify(data, &signature, true)
        .map_err(|e| e.to_string())?;
    let signed = signature
        .trusted_comment()
        .split('\t')
        .find_map(|part| part.strip_prefix("version:"));
    if signed != Some(announced) {
        return Err("Signed package version does not match the release".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_downgrades_prereleases_and_noncanonical_versions() {
        for value in [
            "0.2.0",
            "0.2.1",
            "00.2.2",
            "0.2.2-beta",
            "v0.2.2",
            "0.2",
            "0.2.2 ",
            "0.2.999999999999999999999999999",
        ] {
            let url = format!(
                "{REPOSITORY}/releases/download/v{value}/{}",
                Package::AppImage.asset()
            );
            assert!(validate(value, "0.2.1", &url, Package::AppImage).is_err());
        }
        assert!(validate(
            "0.10.0",
            "0.2.1",
            &format!(
                "{REPOSITORY}/releases/download/v0.10.0/{}",
                Package::AppImage.asset()
            ),
            Package::AppImage
        )
        .is_ok());
    }
    #[test]
    fn rejects_foreign_repositories_wrong_packages_and_url_suffixes() {
        let url = format!(
            "{REPOSITORY}/releases/download/v0.2.2/{}",
            Package::AppImage.asset()
        );
        assert!(validate("0.2.2", "0.2.1", &url, Package::AppImage).is_ok());
        for bad in [
            url.replace("https:", "http:"),
            url.replace("juferdinand", "other"),
            url.replace("v0.2.2", "v0.2.1"),
            format!("{url}?other=1"),
            format!("{url}#fragment"),
            url.replace("github.com", "github.com.evil.example"),
        ] {
            assert!(validate("0.2.2", "0.2.1", &bad, Package::AppImage).is_err());
        }
        assert!(validate("0.2.2", "0.2.1", &url, Package::Debian).is_err());
    }
}
