import AppKit
import CryptoKit
import Foundation

/// Keeps the desktop application in step with the server it syncs against.
///
/// The application and the server move together: a release can change the replicated record shape,
/// and a device holding the older shape is refused a merge until it updates. So the update has to
/// be easy to take and hard to miss, which is why it is offered in the menu bar rather than left
/// to whoever remembers to download a new build.
@MainActor
final class UpdateService: ObservableObject {
    /// Named rather than a bare boolean because "downloading" and "installing" are the two states
    /// the person actually waits through, and a spinner that cannot say which is which is what made
    /// the web app's silent update confusing.
    enum State: Equatable {
        case idle
        case checking
        case downloading
        case installing
        case failed(String)
    }

    private enum Keys {
        static let baseURL = "CalorieLoggerBackendBaseURL"
        static let automatic = "CalorieLoggerAutomaticUpdateChecks"
        static let lastCheck = "CalorieLoggerLastUpdateCheck"
    }

    /// Often enough that an update is taken within a day of a deployment, rarely enough that a
    /// server which is off, or behind a tunnel that is down, is not polled pointlessly.
    private static let checkInterval: TimeInterval = 6 * 3600

    @Published private(set) var available: MacRelease?
    @Published private(set) var state: State = .idle

    var onAvailabilityChanged: ((MacRelease?) -> Void)?

    private let defaults: UserDefaults
    private let session: URLSession
    private var timer: Timer?

    init(defaults: UserDefaults = .standard, session: URLSession = .shared) {
        self.defaults = defaults
        self.session = session
        if defaults.object(forKey: Keys.automatic) == nil {
            defaults.set(true, forKey: Keys.automatic)
        }
    }

    var automaticChecks: Bool {
        get { defaults.bool(forKey: Keys.automatic) }
        set {
            defaults.set(newValue, forKey: Keys.automatic)
            if newValue { start() } else { timer?.invalidate() }
        }
    }

    /// Started once the interface is up. Checking is never on the path to the first paint: the
    /// server may be unreachable, and nothing about opening the log depends on the answer.
    func start() {
        timer?.invalidate()
        guard automaticChecks, !AppVersion.isDevelopmentBuild else { return }
        Task { await self.check(force: false) }
        let timer = Timer.scheduledTimer(withTimeInterval: Self.checkInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check(force: false) }
        }
        timer.tolerance = 300
        self.timer = timer
    }

    /// `force` is a person asking, so it reports "you are up to date" instead of staying silent,
    /// and it ignores both the interval and the automatic-checks setting.
    func check(force: Bool) async {
        if !force {
            guard automaticChecks, !AppVersion.isDevelopmentBuild else { return }
            if let last = defaults.object(forKey: Keys.lastCheck) as? Date,
               Date().timeIntervalSince(last) < Self.checkInterval - 60 { return }
        }
        guard let manifestURL = serverURL(path: "/api/calorie-logger/v5/mac-release") else {
            if force { state = .failed("Sign in first, so Calorie Logger knows which server to ask.") }
            return
        }

        state = .checking
        do {
            var request = URLRequest(url: manifestURL)
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw UpdateFailure.message("The server did not answer the update check.")
            }
            defaults.set(Date(), forKey: Keys.lastCheck)
            let offered = try JSONDecoder().decode(MacRelease.Envelope.self, from: data).data
            let newer = offered.flatMap { $0.isNewer(than: AppVersion.build) ? $0 : nil }
            available = newer
            onAvailabilityChanged?(newer)
            state = .idle
            if force, newer == nil { notify(title: "Calorie Logger is up to date", body: "You are running \(AppVersion.label).") }
        } catch {
            available = nil
            onAvailabilityChanged?(nil)
            state = force ? State.failed(describe(error)) : State.idle
            if force { notify(title: "Could not check for updates", body: describe(error)) }
        }
    }

    /// Downloads the release and puts it in place of the running application.
    ///
    /// The archive is fetched with `URLSession` rather than handed to a browser, so the file never
    /// receives the quarantine attribute and the replaced application opens without asking whether
    /// it should be trusted. Only the very first install, downloaded by hand, sees that prompt.
    func install() async {
        guard let release = available else { return }
        guard let downloadURL = serverURL(path: release.url) else {
            state = .failed("The server gave an address that could not be used.")
            return
        }
        let bundle = URL(fileURLWithPath: Bundle.main.bundlePath)
        guard bundle.pathExtension == "app" else {
            state = .failed("This build is not an installed application, so it cannot update itself.")
            return
        }
        guard FileManager.default.isWritableFile(atPath: bundle.deletingLastPathComponent().path) else {
            // Most often an application still sitting in a read-only mounted image, or installed
            // for another account. Saying which is the difference between a fixable problem and a
            // mysterious one.
            state = .failed("Calorie Logger cannot replace itself in \(bundle.deletingLastPathComponent().path). Move it to your Applications folder and try again.")
            return
        }

        state = .downloading
        do {
            let archive = try await download(downloadURL, expecting: release)
            defer { try? FileManager.default.removeItem(at: archive) }
            state = .installing
            let replacement = try expand(archive)
            defer { try? FileManager.default.removeItem(at: replacement.deletingLastPathComponent()) }
            // `replaceItemAt` swaps the whole directory, so files that a release removed do not
            // linger inside the bundle the way a merging copy would leave them.
            _ = try FileManager.default.replaceItemAt(bundle, withItemAt: replacement)
            relaunch(at: bundle)
        } catch {
            state = .failed(describe(error))
            presentFailure(describe(error))
        }
    }

    // MARK: - Steps

    private func download(_ url: URL, expecting release: MacRelease) async throws -> URL {
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        let (temporary, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            try? FileManager.default.removeItem(at: temporary)
            throw UpdateFailure.message("The update could not be downloaded from the server.")
        }
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("CalorieLoggerUpdate-\(UUID().uuidString).zip")
        try FileManager.default.moveItem(at: temporary, to: destination)

        // The archive travelled over the network from a server that may be reached over plain
        // HTTP inside a private network. Verifying it against the manifest is what makes replacing
        // the running application with its contents a safe thing to do.
        let digest = SHA256.hash(data: try Data(contentsOf: destination, options: .mappedIfSafe))
        let checksum = digest.map { String(format: "%02x", $0) }.joined()
        guard checksum.caseInsensitiveCompare(release.sha256) == .orderedSame else {
            try? FileManager.default.removeItem(at: destination)
            throw UpdateFailure.message("The downloaded update did not match the server's checksum and was discarded.")
        }
        return destination
    }

    private func expand(_ archive: URL) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CalorieLoggerUpdate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", archive.path, directory.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw UpdateFailure.message("The update archive could not be expanded.") }
        let contents = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        guard let application = contents.first(where: { $0.pathExtension == "app" }) else {
            throw UpdateFailure.message("The update archive did not contain an application.")
        }
        return application
    }

    /// A detached shell outlives this process, waits for it to exit, and opens the replacement.
    private func relaunch(at bundle: URL) {
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("calorie-logger-relaunch.sh")
        let contents = "#!/bin/sh\nsleep 1\nopen \"\(bundle.path)\"\nrm -f \"$0\"\n"
        try? contents.write(to: script, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [script.path]
        try? process.run()
        NSApp.terminate(nil)
    }

    // MARK: - Helpers

    /// Joined by string rather than resolved as a relative URL: a server reached through a reverse
    /// proxy can live under a path prefix, and resolving a leading-slash path against that base
    /// would silently drop the prefix and ask the wrong host for the wrong thing.
    private func serverURL(path: String) -> URL? {
        if let absolute = URL(string: path), absolute.scheme != nil { return absolute }
        guard let base = defaults.string(forKey: Keys.baseURL), !base.isEmpty else { return nil }
        return URL(string: base.hasSuffix("/") ? String(base.dropLast()) + path : base + path)
    }

    private func describe(_ error: Error) -> String {
        if case let UpdateFailure.message(text) = error { return text }
        return (error as NSError).localizedDescription
    }

    /// The window is often closed when an update finishes, and the application is then an
    /// accessory with no Dock icon, so a modal alert would open behind everything. Coming forward
    /// first is what makes it visible.
    private func presentFailure(_ message: String) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Calorie Logger could not install the update"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func notify(title: String, body: String) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

enum UpdateFailure: Error {
    case message(String)
}
