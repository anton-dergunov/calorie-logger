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
        /// Carries the fraction received, so a slow server looks like it is working rather than
        /// like it has hung. A download with no progress was read as a stuck update, and waiting
        /// on it with nothing moving is the one thing the old updater got most wrong.
        case downloading(Double)
        case installing
        case failed(String)
    }

    private enum Keys {
        static let baseURL = "CalorieLoggerBackendBaseURL"
        static let automatic = "CalorieLoggerAutomaticUpdateChecks"
        static let automaticInstall = "CalorieLoggerAutomaticUpdateInstall"
        static let lastCheck = "CalorieLoggerLastUpdateCheck"
    }

    /// Often enough that an update is taken within a day of a deployment, rarely enough that a
    /// server which is off, or behind a tunnel that is down, is not polled pointlessly.
    private static let checkInterval: TimeInterval = 6 * 3600
    /// How much of the archive is asked for at a time. Comfortably inside the window where a
    /// single large response stops being delivered at full speed.
    private static let chunkBytes = 1_048_576

    @Published private(set) var available: MacRelease?
    @Published private(set) var state: State = .idle
    /// Published as well as stored, so "Last checked" refreshes the moment a check finishes.
    @Published private(set) var lastCheck: Date?
    /// What an explicit check concluded when there was nothing to offer. Cleared by the next check.
    @Published private(set) var statusMessage: String?

    var onAvailabilityChanged: ((MacRelease?) -> Void)?
    /// Asked before a relaunch that the owner did not just click for. An automatic install still
    /// never restarts the application underneath whoever is using it.
    var confirmRestart: ((MacRelease) -> Bool)?

    private let defaults: UserDefaults
    private let session: URLSession
    private var timer: Timer?

    init(defaults: UserDefaults = .standard, session: URLSession = .shared) {
        self.defaults = defaults
        self.session = session
        if defaults.object(forKey: Keys.automatic) == nil {
            defaults.set(true, forKey: Keys.automatic)
        }
        lastCheck = defaults.object(forKey: Keys.lastCheck) as? Date
    }

    var automaticChecks: Bool {
        get { defaults.bool(forKey: Keys.automatic) }
        set {
            objectWillChange.send()
            defaults.set(newValue, forKey: Keys.automatic)
            if newValue { start() } else { timer?.invalidate() }
        }
    }

    /// Off by default. Replacing the application is the owner's decision to make the first time;
    /// this only removes the second click once they have said they would rather not make it.
    var automaticInstall: Bool {
        get { defaults.bool(forKey: Keys.automaticInstall) }
        set {
            objectWillChange.send()
            defaults.set(newValue, forKey: Keys.automaticInstall)
        }
    }

    var isBusy: Bool {
        switch state {
        case .checking, .downloading, .installing: return true
        case .idle, .failed: return false
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

    /// `force` is a person asking, so it always reports what it found and ignores both the interval
    /// and the automatic-checks setting.
    ///
    /// Every outcome has to say something. An explicit check that found an update used to set the
    /// menu-bar mark and return in silence, so the menu item read as broken to anyone who clicked
    /// it while an update was in fact waiting.
    func check(force: Bool) async {
        guard state != .checking else { return }
        if !force {
            guard automaticChecks, !AppVersion.isDevelopmentBuild else { return }
            if let last = lastCheck, Date().timeIntervalSince(last) < Self.checkInterval - 60 { return }
        }
        guard let manifestURL = serverURL(path: "/api/calorie-logger/v5/mac-release") else {
            if force { state = .failed("Sign in first, so Calorie Logger knows which server to ask.") }
            return
        }

        statusMessage = nil
        state = .checking
        do {
            var request = URLRequest(url: manifestURL)
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw UpdateFailure.message("The server did not answer the update check.")
            }
            let now = Date()
            defaults.set(now, forKey: Keys.lastCheck)
            lastCheck = now
            let offered = try JSONDecoder().decode(MacRelease.Envelope.self, from: data).data
            let newer = offered.flatMap { $0.isNewer(than: AppVersion.build) ? $0 : nil }
            available = newer
            onAvailabilityChanged?(newer)
            state = .idle
            if newer == nil {
                statusMessage = "Calorie Logger is up to date."
            } else if !force, automaticInstall {
                // Found by the timer with automatic installing on: take it now, and ask only before
                // the restart, which is the one part that interrupts.
                await install()
            }
        } catch {
            available = nil
            onAvailabilityChanged?(nil)
            state = force ? State.failed(describe(error)) : State.idle
            if !force { statusMessage = nil }
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

        state = .downloading(0)
        do {
            let archive = try await download(downloadURL, expecting: release)
            state = .installing
            // Verifying, expanding, and swapping the bundle are file work, not interface work.
            // Running them on the main actor froze the window mid-update: the progress the owner was
            // watching stopped moving at whatever it last said, which reads exactly like a hang.
            try await Task.detached(priority: .userInitiated) {
                defer { try? FileManager.default.removeItem(at: archive) }
                // The archive travelled over the network from a server that may be reached over
                // plain HTTP inside a private network. Verifying it against the manifest is what
                // makes replacing the running application with its contents a safe thing to do.
                try Self.verify(archive, matches: release.sha256)
                let replacement = try Self.expand(archive)
                defer { try? FileManager.default.removeItem(at: replacement.deletingLastPathComponent()) }
                // `replaceItemAt` swaps the whole directory, so files that a release removed do not
                // linger inside the bundle the way a merging copy would leave them.
                _ = try FileManager.default.replaceItemAt(bundle, withItemAt: replacement)
            }.value
            state = .idle
            available = nil
            onAvailabilityChanged?(nil)
            guard confirmRestart?(release) ?? true else { return }
            relaunch(at: bundle)
        } catch {
            state = .failed(describe(error))
            presentFailure(describe(error))
        }
    }

    // MARK: - Steps

    /// The state a progress report produces, or nothing when it no longer describes what is shown.
    ///
    /// Kept as a guard even though the pieces now report in order: anything that moves the bar has
    /// to be about the download on screen, or the window goes back to "Downloading 93%" and stays
    /// there for the whole install, which reads as a hang at the moment the work is nearly done.
    nonisolated static func progressUpdate(_ fraction: Double, whileShowing state: State) -> State? {
        guard case .downloading = state else { return nil }
        return .downloading(fraction)
    }

    func applyDownloadProgress(_ fraction: Double) {
        if let next = Self.progressUpdate(fraction, whileShowing: state) { state = next }
    }

    /// The download step on its own, for the tests that prove the archive is assembled correctly.
    func downloadForTesting(_ url: URL, size: Int) async throws -> URL {
        try await download(url, expecting: MacRelease(version: "0", build: "0", file: "f", size: size, sha256: "", url: url.path))
    }

    /// Downloads the archive a piece at a time.
    ///
    /// Asking for the whole file in one response is what made an update take minutes. The transfer
    /// ran at full speed for about 4.5 MB and then trickled the rest at a few kilobytes a second --
    /// the same file, from the same server, over the same tunnel that `curl` pulls in 0.67 seconds,
    /// and it stopped at the same place every time, which is a flow-control window rather than the
    /// network being slow. Asking in pieces that finish well inside that window avoids it
    /// altogether: measured at 0.7 seconds against 100, and the same on every run.
    ///
    /// The pieces are written straight to the file in the order they are asked for, and the
    /// manifest's checksum is verified over the finished file, so anything misassembled is refused
    /// rather than installed.
    private func download(_ url: URL, expecting release: MacRelease) async throws -> URL {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("CalorieLoggerUpdate-\(UUID().uuidString).zip")
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw UpdateFailure.message("The update could not be saved to this device.")
        }
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }

        // A manifest without a size, and a server that answers the whole file regardless of what
        // was asked for, both end up here: one request, one write, done.
        guard release.size > 0 else {
            try handle.write(contentsOf: try await piece(of: url, range: nil).data)
            return destination
        }

        var received = 0
        while received < release.size {
            let last = min(received + Self.chunkBytes, release.size) - 1
            let answer = try await piece(of: url, range: (received, last))
            guard !answer.data.isEmpty else {
                throw UpdateFailure.message("The update stopped arriving from the server.")
            }
            try handle.write(contentsOf: answer.data)
            received += answer.data.count
            applyDownloadProgress(min(1, Double(received) / Double(release.size)))
            if !answer.partial { break }
        }
        return destination
    }

    /// One piece of the archive, asked for again once if the first attempt fails.
    ///
    /// A download made of several requests has several chances to meet a blip, and asking again
    /// costs a fraction of a second where failing costs the owner the whole update.
    private func piece(of url: URL, range: (first: Int, last: Int)?) async throws -> (data: Data, partial: Bool) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let range { request.setValue("bytes=\(range.first)-\(range.last)", forHTTPHeaderField: "Range") }
        for attempt in 0..<2 {
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw UpdateFailure.message("The update could not be downloaded from the server.")
                }
                // 206 means the server honoured the range and there is more to ask for.
                return (data, http.statusCode == 206)
            } catch {
                if attempt == 1 { throw error }
            }
        }
        throw UpdateFailure.message("The update could not be downloaded from the server.")
    }

    private nonisolated static func verify(_ archive: URL, matches expected: String) throws {
        let digest = SHA256.hash(data: try Data(contentsOf: archive, options: .mappedIfSafe))
        let checksum = digest.map { String(format: "%02x", $0) }.joined()
        guard checksum.caseInsensitiveCompare(expected) == .orderedSame else {
            throw UpdateFailure.message("The downloaded update did not match the server's checksum and was discarded.")
        }
    }

    private nonisolated static func expand(_ archive: URL) throws -> URL {
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
