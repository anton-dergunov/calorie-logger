import AppKit
import SwiftUI

/// Settings for this copy of Calorie Logger on this Mac: whether it starts with the session, and
/// how it takes new versions of itself.
///
/// Nothing about the log is here. Targets, the day boundary, the account, and the data live in the
/// owner's records, which only the interface can read and write, and they are reached from the
/// menu bar. Splitting them this way keeps one home per thing rather than two competing ones.
struct SettingsView: View {
    @ObservedObject var updates: UpdateService
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var router: SettingsRouter
    @State private var openAtLogin = LoginItem.isEnabled

    let checkNow: () -> Void
    let installUpdate: () -> Void

    enum Pane: Hashable, CaseIterable, Identifiable {
        case general, updates

        var id: Self { self }

        var title: String {
            switch self {
            case .general: "General"
            case .updates: "Updates"
            }
        }

        var icon: String {
            switch self {
            case .general: "gearshape"
            case .updates: "arrow.down.circle"
            }
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            List(Pane.allCases, selection: $router.pane) { pane in
                Label(pane.title, systemImage: pane.icon).tag(pane)
            }
            .listStyle(.sidebar)
            .frame(width: 160)

            Divider()

            ScrollView {
                pane
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var pane: some View {
        switch router.pane {
        case .general: general
        case .updates: updatesPane
        }
    }

    // MARK: - General

    private var general: some View {
        VStack(alignment: .leading, spacing: 20) {
            Toggle(isOn: $openAtLogin) {
                settingLabel(
                    "Open Calorie Logger at login",
                    "The menu bar shows today's totals only while Calorie Logger is running."
                )
            }
            .toggleStyle(.switch)
            .onChange(of: openAtLogin) { _, value in
                LoginItem.setEnabled(value)
                openAtLogin = LoginItem.isEnabled
            }

            Toggle(isOn: $settings.showWindowAtLogin) {
                settingLabel(
                    "Show the window when opened at login",
                    "Off, Calorie Logger starts quietly in the menu bar. Opening it yourself always shows today."
                )
            }
            .toggleStyle(.switch)
            .disabled(!openAtLogin)

            Spacer(minLength: 0)
        }
    }

    // MARK: - Updates

    private var updatesPane: some View {
        VStack(alignment: .leading, spacing: 16) {
            Toggle(isOn: Binding(get: { updates.automaticChecks }, set: { updates.automaticChecks = $0 })) {
                settingLabel(
                    "Check for updates automatically",
                    "Looks for a new release on your Calorie Logger server every few hours."
                )
            }
            .toggleStyle(.switch)

            Toggle(isOn: Binding(get: { updates.automaticInstall }, set: { updates.automaticInstall = $0 })) {
                settingLabel(
                    "Install updates automatically",
                    "Downloads and applies an update in the background; still asks before restarting."
                )
            }
            .toggleStyle(.switch)
            .disabled(!updates.automaticChecks)

            Divider()

            HStack(spacing: 10) {
                Button(isChecking ? "Checking…" : "Check Now", action: checkNow)
                    .disabled(updates.isBusy)
                status
            }
            .font(.callout)

            Text("Version \(AppVersion.label)")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)
        }
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

    @ViewBuilder
    private func settingLabel(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
