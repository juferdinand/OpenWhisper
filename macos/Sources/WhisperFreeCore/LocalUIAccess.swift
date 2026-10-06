import Foundation

/// Only signed, bundled UI files may navigate the settings webview or call its native bridge.
public enum LocalUIAccess {
    public static func allows(_ url: URL?, root: URL) -> Bool {
        guard let url, url.isFileURL, root.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else { return false }
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        return path.hasPrefix(base + "/")
    }
}
