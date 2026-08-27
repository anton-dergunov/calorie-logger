import AppKit
import Security
import XCTest
import WebKit
@testable import CalorieLogger

/// Defaults that live only for the length of a test.
///
/// A `UserDefaults(suiteName:)` writes a plist into `~/Library/Preferences`, and
/// `removePersistentDomain` empties that file without deleting it, so every run left another
/// abandoned file behind in the owner's own preferences folder. Nothing here reaches disk.
final class InMemoryDefaults: UserDefaults {
    private var storage: [String: Any] = [:]

    convenience init() { self.init(suiteName: nil)! }

    override func object(forKey key: String) -> Any? { storage[key] }
    override func set(_ value: Any?, forKey key: String) { storage[key] = value }
    override func removeObject(forKey key: String) { storage.removeValue(forKey: key) }
    override func dictionaryRepresentation() -> [String: Any] { storage }
    override func string(forKey key: String) -> String? { storage[key] as? String }
    override func bool(forKey key: String) -> Bool { storage[key] as? Bool ?? false }
    override func integer(forKey key: String) -> Int { storage[key] as? Int ?? 0 }
    override func double(forKey key: String) -> Double { storage[key] as? Double ?? 0 }
    override func data(forKey key: String) -> Data? { storage[key] as? Data }
}

final class NativeModelTests: XCTestCase {
    @MainActor
    func testMainMenuProvidesStandardWebEditingShortcuts() throws {
        let delegate = AppDelegate()
        delegate.installMainMenu()
        let editMenu = try XCTUnwrap(NSApp.mainMenu?.items.first(where: { $0.submenu?.title == "Edit" })?.submenu)

        XCTAssertEqual(editMenu.item(withTitle: "Copy")?.keyEquivalent, "c")
        XCTAssertEqual(editMenu.item(withTitle: "Paste")?.keyEquivalent, "v")
        XCTAssertEqual(editMenu.item(withTitle: "Select All")?.keyEquivalent, "a")
    }

    /// The menu bar is the native host's only entry point -- the interface hides its own settings
    /// button there -- so it has to reach everything, laid out the way a Mac application lays it out.
    @MainActor
    func testMenuBarCarriesTheWholeInterface() throws {
        let delegate = AppDelegate()
        delegate.installMainMenu()
        let mainMenu = try XCTUnwrap(NSApp.mainMenu)

        XCTAssertEqual(mainMenu.items.compactMap { $0.submenu?.title }.filter { !$0.isEmpty },
                       ["File", "Edit", "Day", "Window"])

        let appMenu = try XCTUnwrap(mainMenu.items.first?.submenu)
        for title in ["About Calorie Logger", "Check for Updates…", "Settings…", "Connection…", "Sync…", "Quit Calorie Logger"] {
            XCTAssertNotNil(appMenu.item(withTitle: title), "the application menu is missing \(title)")
        }
        XCTAssertEqual(appMenu.item(withTitle: "Settings…")?.keyEquivalent, ",")

        let fileMenu = try XCTUnwrap(mainMenu.items.first(where: { $0.submenu?.title == "File" })?.submenu)
        XCTAssertEqual(fileMenu.item(withTitle: "Add Food…")?.keyEquivalent, "n")
        XCTAssertEqual(fileMenu.item(withTitle: "Export Data…")?.keyEquivalent, "e")
        XCTAssertNotNil(fileMenu.item(withTitle: "Reset App Data…"))

        let dayMenu = try XCTUnwrap(mainMenu.items.first(where: { $0.submenu?.title == "Day" })?.submenu)
        for title in ["Today", "Previous Day", "Next Day", "Select Entries", "Reorder Entries", "Daily Targets…"] {
            XCTAssertNotNil(dayMenu.item(withTitle: title), "the day menu is missing \(title)")
        }
        // Command-comma belongs to Settings, so the goals take a modifier of their own.
        XCTAssertEqual(dayMenu.item(withTitle: "Daily Targets…")?.keyEquivalentModifierMask, [.command, .option])
    }

    /// The editing commands act on whatever holds focus. Left to itself the web view answers for
    /// all of them all the time, which offered Copy with nothing selected and a Select All that
    /// selected the whole page.
    @MainActor
    func testEditingCommandsFollowTheFocusOfTheInterface() throws {
        let delegate = AppDelegate()
        delegate.installMainMenu()
        let editMenu = try XCTUnwrap(NSApp.mainMenu?.items.first(where: { $0.submenu?.title == "Edit" })?.submenu)
        let commands = ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]

        for title in commands {
            XCTAssertEqual(editMenu.item(withTitle: title)?.isEnabled, false, "\(title) is live with nothing focused")
        }

        delegate.setTextEditing(true)
        for title in commands {
            XCTAssertEqual(editMenu.item(withTitle: title)?.isEnabled, true, "\(title) is dead inside a text field")
        }

        delegate.setTextEditing(false)
        XCTAssertEqual(editMenu.item(withTitle: "Select All")?.isEnabled, false)
    }

    /// Opening the app is a request to see today. Being started at login is not: the menu bar is
    /// the whole point of running at login, and a window over what someone is doing as they log in
    /// is an interruption nobody asked for.
    @MainActor
    func testLoginLaunchesStayInTheMenuBarAndOpeningTheAppDoesNot() {
        let launchd = ["XPC_SERVICE_NAME": "application.com.calorielogger.app.1234.5678"]
        let byHand = ["XPC_SERVICE_NAME": "0"]

        XCTAssertTrue(LaunchContext.startsInMenuBarOnly(
            launchUserInfo: [LaunchContext.isDefaultLaunchKey: false],
            environment: launchd, bundleIdentifier: "com.calorielogger.app", showWindowAtLogin: false))

        XCTAssertFalse(LaunchContext.startsInMenuBarOnly(
            launchUserInfo: [LaunchContext.isDefaultLaunchKey: true],
            environment: byHand, bundleIdentifier: "com.calorielogger.app", showWindowAtLogin: false))

        // Someone who would rather see the window at login says so, and that answer wins.
        XCTAssertFalse(LaunchContext.startsInMenuBarOnly(
            launchUserInfo: [LaunchContext.isDefaultLaunchKey: false],
            environment: launchd, bundleIdentifier: "com.calorielogger.app", showWindowAtLogin: true))
    }

    /// Two independent signals, because either one alone has a hole: AppKit reports an automatic
    /// launch for reasons other than login, and the service name is the only evidence launchd
    /// leaves behind.
    @MainActor
    func testEitherSignalOnItsOwnIsEnoughToRecogniseALoginLaunch() {
        XCTAssertTrue(LaunchContext.startsInMenuBarOnly(
            launchUserInfo: nil,
            environment: ["XPC_SERVICE_NAME": "application.com.calorielogger.app.1.2"],
            bundleIdentifier: "com.calorielogger.app", showWindowAtLogin: false))

        XCTAssertTrue(LaunchContext.startsInMenuBarOnly(
            launchUserInfo: [LaunchContext.isDefaultLaunchKey: false],
            environment: [:], bundleIdentifier: "com.calorielogger.app", showWindowAtLogin: false))

        // No evidence at all means someone opened it, which is the only safe way to be wrong.
        XCTAssertFalse(LaunchContext.startsInMenuBarOnly(
            launchUserInfo: nil, environment: [:],
            bundleIdentifier: "com.calorielogger.app", showWindowAtLogin: false))
    }

    func testTextEditingRequestDecodesTheInterfacesFocusReport() throws {
        let request: TextEditingRequest = try JSONDecoder().decode(
            TextEditingRequest.self, from: Data("{\"editing\":true}".utf8))
        XCTAssertTrue(request.editing)
    }

    func testMenuPopoverIsPositionedDirectlyBelowItsStatusItem() {
        let anchor = NSRect(x: 900, y: 1076, width: 32, height: 24)
        let origin = menuPopoverOrigin(
            anchor: anchor,
            popoverSize: NSSize(width: 310, height: 260),
            visibleFrame: NSRect(x: 0, y: 0, width: 1920, height: 1080)
        )

        XCTAssertEqual(origin.x, 761)
        XCTAssertEqual(origin.y + 260, anchor.minY - 2)
    }

    func testMenuSummaryDecodesRepositorySnapshot() throws {
        let json = #"{"day":{"date":"2026-08-20","entries":[],"totals":{"calories":412.5,"protein":31,"fat":9,"carbs":48}},"targets":{"calories":2000,"protein":120,"fat":null,"carbs":null}}"#
        let summary = try JSONDecoder().decode(MenuSummary.self, from: Data(json.utf8))
        XCTAssertEqual(summary.day.date, "2026-08-20")
        XCTAssertEqual(summary.day.totals.calories, 412.5)
        XCTAssertEqual(summary.targets.protein, 120)
    }

    @MainActor
    func testNativeSyncSchedulerRepeatsWithoutAWebPageTimer() async {
        var refreshes = 0
        let repeated = expectation(description: "Native sync repeated")
        let scheduler = NativeSyncScheduler(interval: 0.01) {
            refreshes += 1
            if refreshes == 2 { repeated.fulfill() }
        }

        scheduler.start()
        await fulfillment(of: [repeated], timeout: 1)
        scheduler.stop()

        XCTAssertGreaterThanOrEqual(refreshes, 2)
    }

    @MainActor
    func testPopoverActionWaitsUntilClosingHasFinishedAndRunsOnce() async {
        let actions = PopoverActionQueue()
        var runs = 0
        let ran = expectation(description: "Popover action ran")
        actions.prepare {
            runs += 1
            ran.fulfill()
        }

        actions.popoverDidClose()
        XCTAssertEqual(runs, 0, "The action raced the transient popover while it was closing.")
        await fulfillment(of: [ran], timeout: 1)
        XCTAssertEqual(runs, 1)

        actions.popoverDidClose()
        await Task.yield()
        XCTAssertEqual(runs, 1)
    }

    func testSessionRequestContainsOnlyThePersistedFields() throws {
        let json = #"{"session":{"baseUrl":"https://calorie-logger.example.test","email":"person@example.test","token":"secret"}}"#
        let request = try JSONDecoder().decode(SessionRequest.self, from: Data(json.utf8))
        XCTAssertEqual(request.session.baseUrl, "https://calorie-logger.example.test")
        XCTAssertEqual(request.session.email, "person@example.test")
        XCTAssertEqual(request.session.token, "secret")
    }

    @MainActor
    func testNativeSessionPersistsTheWholeSessionAndCanForgetOnlyTheToken() throws {
        let identifier = UUID().uuidString
        let defaults = InMemoryDefaults()
        let bridge = WebBridge(defaults: defaults, legacyKeychainService: "com.calorielogger.app.tests.\(identifier)")
        defer { bridge.clearSession() }
        let session = StoredSession(baseUrl: "https://calorie-logger.example.test", email: "person@example.test", token: "opaque-token")

        try bridge.saveSession(session)
        XCTAssertEqual(try bridge.loadSession(), session)
        bridge.clearToken()
        XCTAssertEqual(try bridge.loadSession(), StoredSession(baseUrl: session.baseUrl, email: session.email, token: ""))
        // Signing out leaves nothing behind, so the next launch reaches the sign-in screen.
        bridge.clearSession()
        XCTAssertNil(try bridge.loadSession())
    }

    /// The session must never touch Keychain again: an ad-hoc signature changes on every build, and
    /// macOS then asks the owner to unlock their login keychain for a build it has not seen before.
    @MainActor
    func testNativeSessionNeverWritesToKeychain() throws {
        let identifier = UUID().uuidString
        let service = "com.calorielogger.app.tests.\(identifier)"
        let defaults = InMemoryDefaults()
        let bridge = WebBridge(defaults: defaults, legacyKeychainService: service)
        defer { bridge.clearSession() }

        try bridge.saveSession(StoredSession(baseUrl: "https://calorie-logger.example.test", email: "person@example.test", token: "opaque-token"))

        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: "calorie-logger-api-token",
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ] as CFDictionary, &result)
        XCTAssertEqual(status, errSecItemNotFound)
    }

    func testMacReleaseDecodesTheServerEnvelopeAndItsAbsence() throws {
        let offered = """
        {"data":{"version":"1.2.0","build":"202608231530","file":"CalorieLogger-1.2.0-202608231530.zip",        "size":24117248,"sha256":"abc123","url":"/api/calorie-logger/downloads/CalorieLogger-1.2.0-202608231530.zip"}}
        """
        let release = try XCTUnwrap(JSONDecoder().decode(MacRelease.Envelope.self, from: Data(offered.utf8)).data)
        XCTAssertEqual(release.version, "1.2.0")
        XCTAssertEqual(release.build, "202608231530")
        XCTAssertEqual(release.sha256, "abc123")

        // A server that has never published a desktop application is an ordinary state, not a
        // decoding failure: deploying from Linux cannot build one.
        let none = try JSONDecoder().decode(MacRelease.Envelope.self, from: Data(#"{"data":null}"#.utf8))
        XCTAssertNil(none.data)
    }

    func testUpdateIsDecidedByBuildStampRatherThanVersionNumber() throws {
        let release = MacRelease(
            version: "1.0.0",
            build: "202608231530",
            file: "CalorieLogger.zip",
            size: 1,
            sha256: "",
            url: "/api/calorie-logger/downloads/CalorieLogger.zip"
        )
        XCTAssertTrue(release.isNewer(than: "202608230900"))
        XCTAssertFalse(release.isNewer(than: "202608231530"), "The same build is not an update.")
        XCTAssertFalse(release.isNewer(than: "202609010000"))
        // Every deployment stamps a new build even when the version is unchanged, which is the
        // whole point: the desktop app and the server's record shape move together, so a release
        // that forgot to bump its version must still reach the Mac.
        XCTAssertTrue(release.isNewer(than: "0"), "A build with no stamp must always be updatable.")

        // A manifest without a usable stamp must never look newer than a real installation.
        let malformed = MacRelease(version: "9.9.9", build: "next", file: "x.zip", size: 1, sha256: "", url: "/x")
        XCTAssertFalse(malformed.isNewer(than: "202608231530"))
    }
}

final class WebInterfaceTests: XCTestCase {
    @MainActor
    func testServesOnlyFilesInsideTheBundledInterface() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("web-interface-tests-\(UUID().uuidString)", isDirectory: true)
        let assets = directory.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        try "<html></html>".write(to: directory.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        try "body{}".write(to: assets.appendingPathComponent("current.css"), atomically: true, encoding: .utf8)
        let secret = FileManager.default.temporaryDirectory.appendingPathComponent("outside-\(UUID().uuidString).txt")
        try "secret".write(to: secret, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: secret) }

        let handler = WebInterfaceSchemeHandler(root: directory)
        XCTAssertNotNil(handler.resolveForTesting(URL(string: "calorie-logger://app/index.html")!))
        XCTAssertNotNil(handler.resolveForTesting(URL(string: "calorie-logger://app/assets/current.css")!))
        XCTAssertNotNil(handler.resolveForTesting(URL(string: "calorie-logger://app/")!), "The root path must serve the index.")
        XCTAssertNil(handler.resolveForTesting(URL(string: "calorie-logger://app/../\(secret.lastPathComponent)")!))
        XCTAssertNil(handler.resolveForTesting(URL(string: "calorie-logger://app/assets/missing.js")!))
    }

    @MainActor
    func testDeclaresTheContentTypesTheBundleActuallyNeeds() {
        // A script served as anything other than JavaScript is parsed but never executed, and a
        // WebAssembly module needs its own type to stream. Both failures present as a blank window.
        XCTAssertEqual(WebInterfaceSchemeHandler.contentType(for: "js"), "text/javascript; charset=utf-8")
        XCTAssertEqual(WebInterfaceSchemeHandler.contentType(for: "css"), "text/css; charset=utf-8")
        XCTAssertEqual(WebInterfaceSchemeHandler.contentType(for: "wasm"), "application/wasm")
        XCTAssertEqual(WebInterfaceSchemeHandler.contentType(for: "bin"), "application/octet-stream")
    }

    /// A login launch leaves the window unshown, and the menu bar's totals come from the interface,
    /// so the interface has to run anyway. WebKit is free to throttle a view whose window was never
    /// ordered front; this is the thing that would silently empty the menu bar if it ever did.
    @MainActor
    func testPackagedInterfaceRunsWithItsWindowNeverShown() async throws {
        let webView = try await loadPackagedInterface(showWindow: false)

        let childValue = try await webView.evaluateJavaScript("document.getElementById('root')?.childElementCount || 0")
        let text = try await webView.evaluateJavaScript("document.body.innerText") as? String
        XCTAssertGreaterThan((childValue as? NSNumber)?.intValue ?? 0, 0, "Rendered page text was: \(text ?? "<empty>")")
        XCTAssertTrue(text?.localizedCaseInsensitiveContains("Sign in") == true, "Rendered page text was: \(text ?? "<empty>")")
        let command = try await webView.evaluateJavaScript("typeof window.calorieLogger?.syncNow") as? String
        XCTAssertEqual(command, "function", "The native host had no way to wake synchronization.")
        let invoked = try await webView.evaluateJavaScript(
            "window.calorieLogger ? (window.calorieLogger.syncNow(), true) : false"
        ) as? Bool
        XCTAssertEqual(invoked, true)
    }

    @MainActor
    func testPackagedInterfaceRendersFirstRunConnectionInsideWebKit() async throws {
        let webView = try await loadPackagedInterface()

        let childValue = try await webView.evaluateJavaScript("document.getElementById('root')?.childElementCount || 0")
        let childCount = (childValue as? NSNumber)?.intValue ?? 0
        let text = try await webView.evaluateJavaScript("document.body.innerText") as? String
        XCTAssertGreaterThan(childCount, 0, "Rendered page text was: \(text ?? "<empty>")")
        XCTAssertTrue(text?.localizedCaseInsensitiveContains("Sign in") == true, "Rendered page text was: \(text ?? "<empty>")")
        XCTAssertTrue(text?.localizedCaseInsensitiveContains("Password") == true)
    }

    /// The offline copy of the log lives in IndexedDB, which a `file://` page does not get. This
    /// is the assertion that keeps the host on a real origin.
    @MainActor
    func testHostedInterfaceCanOpenTheOfflineDatabase() async throws {
        let webView = try await loadPackagedInterface()

        let script = """
        return await new Promise((resolve) => {
          if (!window.indexedDB) { resolve('missing'); return; }
          const request = indexedDB.open('calorie-logger-probe', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('probe');
          request.onsuccess = () => { request.result.close(); indexedDB.deleteDatabase('calorie-logger-probe'); resolve('ok'); };
          request.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 4000);
        });
        """
        let result = try await webView.callAsyncJavaScript(script, contentWorld: .page) as? String
        XCTAssertEqual(result, "ok", "IndexedDB was not usable on the hosted origin.")

        let origin = try await webView.evaluateJavaScript("window.location.origin") as? String
        XCTAssertEqual(origin, "calorie-logger://app")
    }

    /// Food artwork is WebP served over the custom scheme. A wrong content type, or a build that
    /// dropped the pictures, leaves every food in the log as an empty square inside the host.
    @MainActor
    func testHostedInterfaceDecodesBundledFoodPictures() async throws {
        let root = try XCTUnwrap(WebInterface.bundledInterfaceDirectory())
        let pictures = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("assets").path)
            .filter { $0.hasSuffix(".webp") }
            .sorted()
        XCTAssertGreaterThan(pictures.count, 90, "The bundled interface is missing its food pictures.")

        let webView = try await loadPackagedInterface()
        let names = pictures.map { "'./assets/\($0)'" }.joined(separator: ",")
        let script = """
        const sources = [\(names)];
        const load = (source) => new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image.naturalWidth === 192 ? null : source);
          image.onerror = () => resolve(source);
          image.src = source;
          setTimeout(() => resolve(source), 8000);
        });
        return (await Promise.all(sources.map(load))).filter(Boolean).join(', ');
        """
        let failures = try await webView.callAsyncJavaScript(script, contentWorld: .page) as? String
        XCTAssertEqual(failures, "", "Bundled food pictures did not decode inside WebKit.")
    }

    @MainActor
    private func loadPackagedInterface(showWindow: Bool = true) async throws -> WKWebView {
        let root = try XCTUnwrap(WebInterface.bundledInterfaceDirectory(), "The Vite interface was not embedded in the test host app.")
        let bridge = FirstRunBridge()
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "calorieLogger")
        configuration.setURLSchemeHandler(WebInterfaceSchemeHandler(root: root), forURLScheme: WebInterface.scheme)
        let webView = WKWebView(frame: .init(x: 0, y: 0, width: 900, height: 700), configuration: configuration)
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        // NSWindow releases itself on close by default, which over-releases the reference held
        // here and crashes AppKit on the next transaction flush.
        window.isReleasedWhenClosed = false
        window.contentView = webView
        if showWindow { window.orderFront(nil) }
        addTeardownBlock { @MainActor in
            window.close()
            configuration.userContentController.removeScriptMessageHandler(forName: "calorieLogger", contentWorld: .page)
        }

        let loaded = expectation(description: "Packaged interface loaded")
        let navigation = NavigationExpectation(didFinish: { loaded.fulfill() })
        webView.navigationDelegate = navigation
        webView.load(URLRequest(url: WebInterface.startURL))
        await fulfillment(of: [loaded], timeout: 8)
        try await Task.sleep(for: .milliseconds(500))
        withExtendedLifetime(navigation) {}
        return webView
    }
}

@MainActor
private final class NavigationExpectation: NSObject, WKNavigationDelegate {
    var didFinish: () -> Void

    init(didFinish: @escaping () -> Void) {
        self.didFinish = didFinish
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didFinish()
    }
}

private final class FirstRunBridge: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        replyHandler(["data": NSNull()], nil)
    }
}

/// Serves a canned manifest so the update check can be exercised without a server.
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var body = Data()
    nonisolated(unsafe) static var status = 200
    /// A server that answers the whole file however little was asked for.
    nonisolated(unsafe) static var ignoresRanges = false
    nonisolated(unsafe) static var rangesAsked: [String] = []

    static func reset() {
        body = Data(); status = 200; ignoresRanges = false; rangesAsked = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var payload = Self.body
        var status = Self.status
        if let header = request.value(forHTTPHeaderField: "Range") {
            Self.rangesAsked.append(header)
            if !Self.ignoresRanges, let range = Self.slice(header, of: Self.body.count) {
                payload = Self.body.subdata(in: range)
                status = 206
            }
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func slice(_ header: String, of count: Int) -> Range<Int>? {
        let numbers = header.replacingOccurrences(of: "bytes=", with: "").split(separator: "-")
        guard numbers.count == 2, let first = Int(numbers[0]), let last = Int(numbers[1]),
              first < count else { return nil }
        return first..<min(last + 1, count)
    }
}

final class UpdateCheckTests: XCTestCase {
    @MainActor
    private func service(manifest: String) throws -> (UpdateService, UserDefaults) {
        let defaults = InMemoryDefaults()
        defaults.set("https://calorie-logger.example.test", forKey: "CalorieLoggerBackendBaseURL")
        StubURLProtocol.body = Data(manifest.utf8)
        StubURLProtocol.status = 200
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return (UpdateService(defaults: defaults, session: URLSession(configuration: configuration)), defaults)
    }

    private func manifest(build: String) -> String {
        """
        {"data":{"version":"1.0.0","build":"\(build)","file":"CalorieLogger.zip","size":10,
        "sha256":"abc","url":"/api/calorie-logger/downloads/CalorieLogger.zip"}}
        """
    }

    /// The bug this replaces: an explicit check that found an update set the menu-bar mark and
    /// returned in silence, so the menu item looked broken exactly when it had most to say.
    @MainActor
    func testExplicitCheckReportsAnAvailableUpdateRatherThanReturningSilently() async throws {
        let (updates, defaults) = try service(manifest: manifest(build: "999999999999"))

        await updates.check(force: true)

        XCTAssertEqual(updates.available?.build, "999999999999")
        XCTAssertEqual(updates.state, .idle)
        XCTAssertNotNil(updates.lastCheck)
    }

    @MainActor
    func testExplicitCheckSaysSoWhenThereIsNothingNewer() async throws {
        let (updates, defaults) = try service(manifest: manifest(build: "1"))

        await updates.check(force: true)

        XCTAssertNil(updates.available)
        XCTAssertEqual(updates.statusMessage, "Calorie Logger is up to date.")
    }

    /// Installing without being asked is opt-in: an update that replaces the application on its own
    /// is a decision the owner makes once, not a default they discover afterwards.
    @MainActor
    func testAutomaticInstallIsOffUntilItIsTurnedOn() async throws {
        let (updates, defaults) = try service(manifest: manifest(build: "1"))

        XCTAssertFalse(updates.automaticInstall)
        XCTAssertTrue(updates.automaticChecks)
        updates.automaticInstall = true
        XCTAssertTrue(defaults.bool(forKey: "CalorieLoggerAutomaticUpdateInstall"))
    }

    @MainActor
    func testDownloadProgressIsPartOfTheStateSoItCanBeShown() {
        XCTAssertNotEqual(UpdateService.State.downloading(0.1), .downloading(0.9))
        XCTAssertEqual(UpdateService.State.downloading(0.5), .downloading(0.5))
    }

    /// The bug this replaces: a progress report still in flight when the transfer finished arrived
    /// after the state had moved on, and put the window back to "Downloading 93%" for the whole
    /// install -- a finished update that reads as a stuck one.
    func testAProgressReportCannotMoveTheStateBackToDownloading() {
        XCTAssertEqual(UpdateService.progressUpdate(0.93, whileShowing: .downloading(0.5)), .downloading(0.93))
        XCTAssertNil(UpdateService.progressUpdate(0.99, whileShowing: .installing))
        XCTAssertNil(UpdateService.progressUpdate(0.99, whileShowing: .idle))
        XCTAssertNil(UpdateService.progressUpdate(0.99, whileShowing: .checking))
    }

    /// The archive is asked for in pieces, because one large response ran at full speed for about
    /// 4.5 MB and then trickled the rest at a few kilobytes a second. The pieces have to be put
    /// back together in the right order, or the checksum that follows would reject them.
    @MainActor
    func testTheArchiveIsAssembledInOrderFromRangedPieces() async throws {
        let (updates, _) = try service(manifest: manifest(build: "1"))
        defer { StubURLProtocol.reset() }
        let size = 1_048_576 * 2 + 500
        StubURLProtocol.body = Data((0..<size).map { UInt8($0 % 251) })
        let url = try XCTUnwrap(URL(string: "https://calorie-logger.example.test/api/calorie-logger/downloads/CalorieLogger.zip"))

        let file = try await updates.downloadForTesting(url, size: size)
        defer { try? FileManager.default.removeItem(at: file) }

        XCTAssertEqual(try Data(contentsOf: file), StubURLProtocol.body)
        XCTAssertEqual(StubURLProtocol.rangesAsked, ["bytes=0-1048575", "bytes=1048576-2097151", "bytes=2097152-2097651"])
    }

    /// A server that ignores the range header answers the whole file at once, and that is a
    /// complete download rather than the first piece of one.
    @MainActor
    func testAServerThatIgnoresRangesStillProducesTheWholeArchive() async throws {
        let (updates, _) = try service(manifest: manifest(build: "1"))
        defer { StubURLProtocol.reset() }
        StubURLProtocol.body = Data(repeating: 0x7a, count: 1_048_576 * 2)
        StubURLProtocol.ignoresRanges = true
        let url = try XCTUnwrap(URL(string: "https://calorie-logger.example.test/api/calorie-logger/downloads/CalorieLogger.zip"))

        let file = try await updates.downloadForTesting(url, size: 1_048_576 * 2)
        defer { try? FileManager.default.removeItem(at: file) }

        XCTAssertEqual(try Data(contentsOf: file), StubURLProtocol.body)
        XCTAssertEqual(StubURLProtocol.rangesAsked.count, 1, "the whole file arrived, so nothing more should be asked for")
    }
}
