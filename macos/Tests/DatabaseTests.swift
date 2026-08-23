import AppKit
import XCTest
import WebKit
@testable import CalorieLogger

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

    func testSessionRequestContainsOnlyThePersistedFields() throws {
        let json = #"{"session":{"baseUrl":"https://calorie-logger.example.test","email":"person@example.test","token":"secret"}}"#
        let request = try JSONDecoder().decode(SessionRequest.self, from: Data(json.utf8))
        XCTAssertEqual(request.session.baseUrl, "https://calorie-logger.example.test")
        XCTAssertEqual(request.session.email, "person@example.test")
        XCTAssertEqual(request.session.token, "secret")
    }

    @MainActor
    func testNativeSessionPersistsTokenInAnIsolatedKeychainAndCanForgetOnlyTheToken() throws {
        let identifier = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "CalorieLoggerTests.\(identifier)"))
        let bridge = WebBridge(defaults: defaults, keychainService: "com.calorielogger.app.tests.\(identifier)")
        defer { bridge.clearSession(); defaults.removePersistentDomain(forName: "CalorieLoggerTests.\(identifier)") }
        let session = StoredSession(baseUrl: "https://calorie-logger.example.test", email: "person@example.test", token: "opaque-token")

        try bridge.saveSession(session)
        XCTAssertEqual(try bridge.loadSession(), session)
        bridge.clearToken()
        XCTAssertEqual(try bridge.loadSession(), StoredSession(baseUrl: session.baseUrl, email: session.email, token: ""))
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
    private func loadPackagedInterface() async throws -> WKWebView {
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
        window.orderFront(nil)
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
