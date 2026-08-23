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

    let checkNow: () -> Void
    let installUpdate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 3) {
                Toggle(isOn: $openAtLogin) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Open Calorie Logger at login")
                        Text("The menu bar shows today's totals only while Calorie Logger is running.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .onChange(of: openAtLogin) { _, value in
                    LoginItem.setEnabled(value)
                    openAtLogin = LoginItem.isEnabled
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 14) {
                Text("Updates").font(.headline)

                Toggle(isOn: Binding(get: { updates.automaticChecks }, set: { updates.automaticChecks = $0 })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Check for updates automatically")
                        Text("Looks for a new release on your Calorie Logger server every few hours.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)

                Toggle(isOn: Binding(get: { updates.automaticInstall }, set: { updates.automaticInstall = $0 })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Install updates automatically")
                        Text("Downloads and applies an update in the background; still asks before restarting.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .disabled(!updates.automaticChecks)

                HStack(spacing: 10) {
                    Button(isChecking ? "Checking…" : "Check Now", action: checkNow)
                        .disabled(updates.isBusy)
                    status
                }
                .font(.callout)

                Text("Version \(AppVersion.label)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(24)
        .frame(width: 460, alignment: .leading)
    }

    private var isChecking: Bool { updates.state == .checking }

    @ViewBuilder
    private var status: some View {
        switch updates.state {
        case .downloading(let fraction):
            ProgressView(value: fraction)
                .frame(width: 90)
            Text("Downloading \(Int(fraction * 100))%")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .installing:
            ProgressView().controlSize(.small)
            Text("Installing…").font(.caption).foregroundStyle(.secondary)
        case .failed(let message):
            Text(message).font(.caption).foregroundStyle(.red).lineLimit(3)
        case .checking:
            ProgressView().controlSize(.small)
        case .idle:
            if let release = updates.available {
                // Named by build, not by version: a deployment that did not bump the version still
                // ships a new application, and "Update to 1.0.0" while running 1.0.0 says nothing.
                Text("Build \(release.build) is available")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Button("Update Now", action: installUpdate)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            } else if let message = updates.statusMessage {
                Text(message).font(.caption).foregroundStyle(.secondary)
            } else if let date = updates.lastCheck {
                Text("Last checked: \(date.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
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
        controller.sizingOptions = [.preferredContentSize]
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
