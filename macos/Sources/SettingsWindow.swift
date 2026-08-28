import AppKit
import ServiceManagement
import SwiftUI

/// "Open at login", kept in one place because the answer has to come from the system rather than
/// from a remembered setting: a person can remove a login item in System Settings, and a checkbox
/// that disagreed with that would be worse than no checkbox.
enum LoginItem {
    private static let initialised = "CalorieLoggerLoginItemInitialised"

    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
        } catch {
            // The checkbox reads the real status, so a refusal simply shows as the toggle
            // returning to where it was rather than as a lie about what is configured.
            NSLog("Calorie Logger could not change its login item: \(error.localizedDescription)")
        }
    }

    /// Calorie Logger lives in the menu bar, so it is only useful once it is running: it starts at
    /// login by default. Done exactly once, and remembered, so that turning it off stays off.
    static func enableOnFirstLaunch(defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: initialised) else { return }
        defaults.set(true, forKey: initialised)
        setEnabled(true)
    }
}

/// The preferences that belong to this copy of Calorie Logger rather than to the log itself.
/// Everything about the owner's records lives in the replica and is edited in the interface.
@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private let defaults: UserDefaults

    @Published var showWindowAtLogin: Bool {
        didSet { defaults.set(showWindowAtLogin, forKey: LaunchContext.showWindowAtLoginKey) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.showWindowAtLogin = defaults.bool(forKey: LaunchContext.showWindowAtLoginKey)
    }
}

/// Drives the selected pane from outside the SwiftUI hierarchy, so a menu item can open Settings
/// on the pane it is about.
@MainActor
final class SettingsRouter: ObservableObject {
    static let shared = SettingsRouter()
    @Published var pane: SettingsView.Pane = .general
    private init() {}
}

@MainActor
final class SettingsWindowController {
    private var window: NSWindow?

    /// The window this Mac's own preferences are shown in, once there is one. Offered so the
    /// application can ask whether anything of its own is still on screen before it goes back to
    /// being a menu-bar accessory.
    var openWindow: NSWindow? { window }

    func show(updates: UpdateService, pane: SettingsView.Pane, checkNow: @escaping () -> Void, installUpdate: @escaping () -> Void) {
        SettingsRouter.shared.pane = pane
        if let window {
            AppActivation.bringForward(window)
            return
        }
        let controller = NSHostingController(
            rootView: SettingsView(updates: updates, checkNow: checkNow, installUpdate: installUpdate)
                .environmentObject(AppSettings.shared)
                .environmentObject(SettingsRouter.shared)
        )
        let window = NSWindow(contentViewController: controller)
        window.title = "Calorie Logger Settings"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.collectionBehavior = [.fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 620, height: 440))
        window.minSize = NSSize(width: 560, height: 380)
        window.setFrameAutosaveName("SettingsWindow")
        window.center()
        self.window = window
        AppActivation.bringForward(window)
    }
}
