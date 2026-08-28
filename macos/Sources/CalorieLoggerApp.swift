import AppKit
import WebKit

/// WebKit can suspend page timers for a view that has never been ordered front. AppKit owns the
/// native host's refresh cadence so the menu-bar summary keeps moving while the window is closed.
@MainActor
final class NativeSyncScheduler: NSObject {
    static let interval: TimeInterval = 15

    private let refreshInterval: TimeInterval
    private let refresh: () -> Void
    private var timer: Timer?

    init(interval: TimeInterval = NativeSyncScheduler.interval, refresh: @escaping () -> Void) {
        self.refreshInterval = interval
        self.refresh = refresh
    }

    func start() {
        stop()
        let timer = Timer(
            timeInterval: refreshInterval,
            target: self,
            selector: #selector(fire),
            userInfo: nil,
            repeats: true
        )
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    @objc private func fire() { refresh() }
}

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
    private var editingCommands: [NSMenuItem] = []
    private let updates = UpdateService()
    private let settings = SettingsWindowController()
    private lazy var backgroundSync = NativeSyncScheduler { [weak self] in self?.requestMenuSync() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        bridge = WebBridge()
        createWindow()
        menuBar = MenuBarController(
            openLog: { [weak self] in self?.showWindow() },
            addFood: { [weak self] in self?.showAddFood() },
            requestSync: { [weak self] in self?.requestMenuSync() },
            installUpdate: { [weak self] in self?.installUpdate() }
        )
        bridge.onSummary = { [weak self] summary in self?.menuBar.update(summary) }
        bridge.onConnectionState = { [weak self] state in self?.menuBar.setConnectionState(state) }
        bridge.onTextEditingChanged = { [weak self] editing in self?.setTextEditing(editing) }

        // Started at login, Calorie Logger is here for the menu bar; a window over whatever someone
        // is doing as they log in is an interruption nobody asked for. Opening it yourself is a
        // request to see today, so that always shows the window. The interface is loaded either
        // way, because the menu bar's totals come from it.
        if LaunchContext.startsInMenuBarOnly(
            launchUserInfo: notification.userInfo,
            environment: ProcessInfo.processInfo.environment,
            bundleIdentifier: Bundle.main.bundleIdentifier,
            showWindowAtLogin: AppSettings.shared.showWindowAtLogin
        ) {
            NSApp.setActivationPolicy(.accessory)
        } else {
            showWindow()
        }
        backgroundSync.start()

        // Calorie Logger is a menu bar application, so it is only useful once it is running.
        LoginItem.enableOnFirstLaunch()
        // Deliberately last, and never awaited: the server may be unreachable, and opening the log
        // must not wait on anything that talks to it.
        updates.onAvailabilityChanged = { [weak self] release in self?.menuBar.setUpdateAvailable(release) }
        updates.confirmRestart = { [weak self] release in self?.confirmRestart(for: release) ?? true }
        updates.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        backgroundSync.stop()
    }

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
        attachWindow()
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.isMovableByWindowBackground = false
        window.setFrameAutosaveName("MainWindow")

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
        AppActivation.bringForward(window)
    }

    /// Hides the Dock icon once nothing of Calorie Logger's is left on screen; the status item
    /// stays available. Both the log window and the Settings window report their closing here, and
    /// neither of them going away is on its own a reason to give up the menu bar.
    func windowWillClose(_ notification: Notification) {
        AppActivation.returnToMenuBar(owning: [window, settings.openWindow])
    }

    private func showAddFood() {
        showWebCommand("openAddFood")
    }

    /// AppKit drives this call because an off-screen WKWebView cannot be trusted to run its own
    /// interval. The interface still owns the exchange and publishes the resulting summary.
    private func requestMenuSync() {
        webView?.evaluateJavaScript(
            "window.calorieLogger ? (window.calorieLogger.syncNow(), true) : false",
            completionHandler: nil
        )
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

    // MARK: - Menus

    /// Five standard menus, and one rule behind them: the menu bar is where a Mac application keeps
    /// its commands, so it carries the whole interface rather than an arbitrary handful of it.
    /// Everything about the owner's records opens the interface's own panel, so there is one
    /// implementation of each; Settings holds only what belongs to this Mac.
    func installMainMenu() {
        let mainMenu = NSMenu()
        mainMenu.addItem(applicationMenuItem())
        mainMenu.addItem(fileMenuItem())
        mainMenu.addItem(editMenuItem())
        mainMenu.addItem(dayMenuItem())
        let windowItem = windowMenuItem()
        mainMenu.addItem(windowItem)
        NSApp.mainMenu = mainMenu
        // Held so coming forward from the menu bar can put it back: the bar is rebuilt for whichever
        // application is frontmost, and a policy change alone does not make that happen.
        AppActivation.mainMenu = mainMenu
        NSApp.windowsMenu = windowItem.submenu
        setTextEditing(false)
    }

    private func applicationMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu()
        add(to: menu, "About Calorie Logger", #selector(aboutMenu))
        add(to: menu, "Check for Updates…", #selector(checkForUpdatesMenu))
        menu.addItem(.separator())
        // Command-comma is where every Mac application keeps its settings, so nutrition targets
        // move elsewhere rather than sitting where Settings belongs.
        add(to: menu, "Settings…", #selector(settingsMenu), ",")
        menu.addItem(.separator())
        add(to: menu, "Connection…", #selector(connectionMenu))
        add(to: menu, "Sync…", #selector(syncMenu))
        menu.addItem(.separator())
        menu.addItem(withTitle: "Hide Calorie Logger", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = menu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Calorie Logger", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = menu
        return item
    }

    private func fileMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "File")
        add(to: menu, "Add Food…", #selector(addFoodMenu), "n")
        menu.addItem(.separator())
        add(to: menu, "Export Data…", #selector(exportMenu), "e")
        menu.addItem(.separator())
        add(to: menu, "Reset App Data…", #selector(resetMenu))
        item.submenu = menu
        return item
    }

    /// The editing commands act on whatever holds focus, so they are offered only while a text
    /// field does. Left to itself the web view answers for all of them all the time, which put a
    /// Copy with nothing selected and a Select All that selected the entire page in front of
    /// someone reading their log.
    private func editMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Edit")
        menu.autoenablesItems = false
        let undo = menu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = menu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(.separator())
        let cut = menu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        let copy = menu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        let paste = menu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let selectAll = menu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editingCommands = [undo, redo, cut, copy, paste, selectAll]
        item.submenu = menu
        return item
    }

    private func dayMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Day")
        add(to: menu, "Today", #selector(openLogMenu), "t")
        add(to: menu, "Previous Day", #selector(previousDayMenu), "[")
        add(to: menu, "Next Day", #selector(nextDayMenu), "]")
        menu.addItem(.separator())
        add(to: menu, "Select Entries", #selector(selectEntriesMenu), "s", [.command, .shift])
        add(to: menu, "Reorder Entries", #selector(reorderEntriesMenu), "r", [.command, .shift])
        menu.addItem(.separator())
        add(to: menu, "Daily Targets…", #selector(targetsMenu), "t", [.command, .option])
        item.submenu = menu
        return item
    }

    private func windowMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Window")
        menu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        menu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        item.submenu = menu
        return item
    }

    @discardableResult
    private func add(
        to menu: NSMenu,
        _ title: String,
        _ action: Selector,
        _ keyEquivalent: String = "",
        _ modifiers: NSEvent.ModifierFlags? = nil
    ) -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: keyEquivalent)
        item.target = self
        if let modifiers { item.keyEquivalentModifierMask = modifiers }
        return item
    }

    /// Follows the page's focus, so the editing commands and their shortcuts are live exactly when
    /// there is text to act on.
    func setTextEditing(_ editing: Bool) {
        for item in editingCommands { item.isEnabled = editing }
    }

    // MARK: - Updates

    private func installUpdate() {
        menuBar.setUpdateBusy("Downloading the update…")
        Task { [weak self] in
            guard let self else { return }
            await self.updates.install()
            self.menuBar.setUpdateBusy(nil)
        }
    }

    /// An update installed without being clicked for still asks before the restart, because
    /// relaunching underneath someone mid-entry is the thing the application must never do.
    private func confirmRestart(for release: MacRelease) -> Bool {
        AppActivation.bringForward()
        let alert = NSAlert()
        alert.messageText = "Calorie Logger has been updated"
        alert.informativeText = "Build \(release.build) is installed and starts the next time Calorie Logger opens."
        alert.addButton(withTitle: "Restart Now")
        alert.addButton(withTitle: "Later")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func showSettings(_ pane: SettingsView.Pane) {
        settings.show(
            updates: updates,
            pane: pane,
            checkNow: { [weak self] in
                guard let self else { return }
                Task { await self.updates.check(force: true) }
            },
            installUpdate: { [weak self] in self?.installUpdate() }
        )
        settings.openWindow?.delegate = self
    }

    @objc private func settingsMenu() { showSettings(.general) }

    /// Checks where updates live rather than in silence. The menu item used to set the menu-bar
    /// mark and say nothing at all when an update was waiting, which is indistinguishable from the
    /// item being broken.
    @objc private func checkForUpdatesMenu() {
        showSettings(.updates)
        Task { [weak self] in await self?.updates.check(force: true) }
    }

    // MARK: - Menu commands carried by the interface

    @objc private func openLogMenu() { showWindow() }
    @objc private func addFoodMenu() { showAddFood() }
    @objc private func targetsMenu() { showWebCommand("openTargets") }
    @objc private func connectionMenu() { showWebCommand("openConnection") }
    @objc private func syncMenu() { showWebCommand("openSync") }
    @objc private func exportMenu() { showWebCommand("openExport") }
    @objc private func resetMenu() { showWebCommand("openReset") }
    @objc private func aboutMenu() { showWebCommand("openAbout") }
    @objc private func selectEntriesMenu() { showWebCommand("startSelecting") }
    @objc private func reorderEntriesMenu() { showWebCommand("startReordering") }
    @objc private func previousDayMenu() { showWebCommand("previousDay") }
    @objc private func nextDayMenu() { showWebCommand("nextDay") }
}
