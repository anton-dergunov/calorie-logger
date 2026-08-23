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

struct PreferencesView: View {
    @ObservedObject var updates: UpdateService
    @State private var openAtLogin = LoginItem.isEnabled
    @State private var automaticChecks: Bool

    let checkNow: () -> Void
    let installUpdate: () -> Void

    init(updates: UpdateService, checkNow: @escaping () -> Void, installUpdate: @escaping () -> Void) {
        self.updates = updates
        self.checkNow = checkNow
        self.installUpdate = installUpdate
        _automaticChecks = State(initialValue: updates.automaticChecks)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Toggle("Open Calorie Logger at login", isOn: $openAtLogin)
                    .onChange(of: openAtLogin) { _, value in
                        LoginItem.setEnabled(value)
                        openAtLogin = LoginItem.isEnabled
                    }
                Text("The menu bar shows today's totals only while Calorie Logger is running.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Toggle("Check for updates automatically", isOn: $automaticChecks)
                    .onChange(of: automaticChecks) { _, value in updates.automaticChecks = value }
                HStack(spacing: 10) {
                    Text("Version \(AppVersion.label)").foregroundStyle(.secondary)
                    Spacer()
                    switch updates.state {
                    case .checking:
                        Text("Checking…").foregroundStyle(.secondary)
                    case .downloading:
                        Text("Downloading…").foregroundStyle(.secondary)
                    case .installing:
                        Text("Installing…").foregroundStyle(.secondary)
                    case .failed(let message):
                        Text(message).foregroundStyle(.red).lineLimit(2)
                    case .idle:
                        if let release = updates.available {
                            Button("Update to \(release.version)", action: installUpdate)
                                .buttonStyle(.borderedProminent)
                        } else {
                            Button("Check Now", action: checkNow)
                        }
                    }
                }
                .font(.callout)
            }
        }
        .padding(24)
        .frame(width: 420)
    }
}

@MainActor
final class PreferencesWindowController {
    private var window: NSWindow?

    func show(updates: UpdateService, checkNow: @escaping () -> Void, installUpdate: @escaping () -> Void) {
        NSApp.setActivationPolicy(.regular)
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let controller = NSHostingController(
            rootView: PreferencesView(updates: updates, checkNow: checkNow, installUpdate: installUpdate)
        )
        let window = NSWindow(contentViewController: controller)
        window.title = "Calorie Logger Settings"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }
}
