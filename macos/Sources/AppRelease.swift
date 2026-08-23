import Foundation

/// The running build's identity, and the release the server is offering.
///
/// Everything here is pure: no networking, no file system, no AppKit. The comparison that decides
/// whether an update exists is the one thing in the updater that must never be wrong, so it is
/// kept where a test can reach it directly.
enum AppVersion {
    /// "1.0.0" -- the human-facing version, from `CFBundleShortVersionString`.
    static var name: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// The UTC minute stamp this build was made at, from `CFBundleVersion`.
    ///
    /// This, not the semantic version, is what update checks compare. Every deployment produces a
    /// new stamp, so a release whose version was not bumped still reaches the desktop -- which
    /// matters because the app and the database it syncs with move together.
    static var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    }

    static var label: String { "\(name) (\(build))" }

    /// A build produced by `xcodebuild` without the version settings, or run straight out of
    /// DerivedData. It is never offered an update: replacing a development build with a release
    /// would silently discard whatever is being worked on.
    static var isDevelopmentBuild: Bool {
        build == "0" || Bundle.main.bundlePath.hasSuffix(".app") == false
    }
}

struct MacRelease: Decodable, Equatable {
    let version: String
    let build: String
    let file: String
    let size: Int
    let sha256: String
    let url: String

    /// The manifest arrives wrapped in the API's usual `{ "data": … }` envelope, and `data` is
    /// null on a server that has never published a desktop application.
    struct Envelope: Decodable {
        let data: MacRelease?
    }

    /// Build stamps are fixed-width UTC minute stamps, so a numeric comparison is exact and a
    /// string comparison would also work. Numeric is used so a shorter legacy stamp cannot sort
    /// above a longer current one.
    func isNewer(than currentBuild: String) -> Bool {
        guard let offered = UInt64(build) else { return false }
        guard let current = UInt64(currentBuild) else { return true }
        return offered > current
    }
}
