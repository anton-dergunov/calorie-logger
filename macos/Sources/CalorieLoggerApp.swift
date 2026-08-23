import AppKit
import WebKit

@main
struct CalorieLoggerApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var bridge: WebBridge!
    private var menuBar: MenuBarController!
    private var pendingWebCommand: String?
    private let updates = UpdateService()
    private let preferences = PreferencesWindowController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        bridge = WebBridge()
        createWindow()
        menuBar = MenuBarController(
            openLog: { [weak self] in self?.showWindow() },
            addFood: { [weak self] in self?.showAddFood() },
            requestRefresh: { [weak self] in self?.requestMenuSummary() },
            installUpdate: { [weak self] in self?.installUpdate() }
        )
        bridge.onSummary = { [weak self] summary in self?.menuBar.update(summary) }
        bridge.onConnectionState = { [weak self] state in self?.menuBar.setConnectionState(state) }
        showWindow()

        // Calorie Logger is a menu bar application, so it is only useful once it is running.
        LoginItem.enableOnFirstLaunch()
        // Deliberately last, and never awaited: the server may be unreachable, and opening the log
        // must not wait on anything that talks to it.
        updates.onAvailabilityChanged = { [weak self] release in self?.menuBar.setUpdateAvailable(release) }
        updates.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "calorieLogger")
        configuration.userContentController.addUserScript(WKUserScript(
            source: WebInterface.startupDiagnostics,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        guard let interfaceRoot = WebInterface.bundledInterfaceDirectory() else {
            webView = WKWebView(frame: .zero, configuration: configuration)
            webView.navigationDelegate = self
            attachWindow()
            showLoadError("The bundled web interface is missing. Run npm run build:web and rebuild the macOS app.")
            return
        }
        configuration.setURLSchemeHandler(WebInterfaceSchemeHandler(root: interfaceRoot), forURLScheme: WebInterface.scheme)
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Calorie Logger"
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 720, height: 600)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("MainWindow")
        window.center()

        webView.load(URLRequest(url: WebInterface.startURL))
    }

    /// Window setup shared with the failure path, where there is no interface to load.
    private func attachWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Calorie Logger"
        window.minSize = NSSize(width: 720, height: 600)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
    }

    /// Reopening the app always returns to today, so the window is never left on a stale date.
    private func showWindow() {
        showWebCommand("jumpToToday")
    }

    private func raiseWindow() {
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Hides the Dock icon once the window is no longer showing; the status item stays available.
    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    private func showAddFood() {
        showWebCommand("openAddFood")
    }

    private func showTargets() {
        showWebCommand("openTargets")
    }

    private func showExport() {
        showWebCommand("openExport")
    }

    private func showConnection() {
        showWebCommand("openConnection")
    }

    private func requestMenuSummary() {
        webView?.evaluateJavaScript("window.calorieLogger?.refreshNativeSummary?.()")
    }

    private func showWebCommand(_ command: String) {
        raiseWindow()
        pendingWebCommand = command
        webView.evaluateJavaScript("window.calorieLogger ? (window.calorieLogger.\(command)(), true) : false") { [weak self] result, error in
            if error == nil, result as? Bool == true { self?.pendingWebCommand = nil }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let pendingWebCommand { showWebCommand(pendingWebCommand) }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error.localizedDescription)
    }

    private func showLoadError(_ message: String) {
        let escaped = message.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        webView?.loadHTMLString("<main style='font:16px -apple-system;padding:48px'><h1>Unable to open Calorie Logger</h1><p>\(escaped)</p></main>", baseURL: nil)
    }

    func installMainMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Calorie Logger", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let checkUpdatesItem = appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdatesMenu), keyEquivalent: "")
        checkUpdatesItem.target = self
        appMenu.addItem(.separator())
        // Command-comma is where every Mac application keeps its settings, so nutrition targets
        // move to Command-T to make room rather than sitting where Settings belongs.
        let settingsItem = appMenu.addItem(withTitle: "Settings…", action: #selector(preferencesMenu), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Calorie Logger", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Calorie Logger", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let logItem = NSMenuItem()
        mainMenu.addItem(logItem)
        let logMenu = NSMenu(title: "Calorie Logger")
        let openItem = logMenu.addItem(withTitle: "Open Calorie Logger", action: #selector(openLogMenu), keyEquivalent: "o")
        openItem.target = self
        let addItem = logMenu.addItem(withTitle: "Add Food…", action: #selector(addFoodMenu), keyEquivalent: "n")
        addItem.target = self
        logMenu.addItem(.separator())
        let targetsItem = logMenu.addItem(withTitle: "Nutrition Targets…", action: #selector(targetsMenu), keyEquivalent: "t")
        targetsItem.target = self
        let connectionItem = logMenu.addItem(withTitle: "Connection Settings…", action: #selector(connectionMenu), keyEquivalent: "")
        connectionItem.target = self
        let exportItem = logMenu.addItem(withTitle: "Export Data…", action: #selector(exportMenu), keyEquivalent: "e")
        exportItem.target = self
        logItem.submenu = logMenu
        NSApp.mainMenu = mainMenu
    }

    private func installUpdate() {
        menuBar.setUpdateBusy("Downloading the update…")
        Task { [weak self] in
            guard let self else { return }
            await self.updates.install()
            self.menuBar.setUpdateBusy(nil)
        }
    }

    private func showPreferences() {
        preferences.show(
            updates: updates,
            checkNow: { [weak self] in
                guard let self else { return }
                Task { await self.updates.check(force: true) }
            },
            installUpdate: { [weak self] in self?.installUpdate() }
        )
    }

    @objc private func preferencesMenu() { showPreferences() }

    @objc private func checkForUpdatesMenu() {
        Task { [weak self] in await self?.updates.check(force: true) }
    }

    @objc private func openLogMenu() { showWindow() }
    @objc private func addFoodMenu() { showAddFood() }
    @objc private func targetsMenu() { showTargets() }
    @objc private func connectionMenu() { showConnection() }
    @objc private func exportMenu() { showExport() }
}
