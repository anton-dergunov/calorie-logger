import AppKit
import Combine
import SwiftUI

func menuPopoverOrigin(anchor: NSRect, popoverSize: NSSize, visibleFrame: NSRect) -> NSPoint {
    let gap: CGFloat = 2
    let centeredX = anchor.midX - popoverSize.width / 2
    let x = min(max(centeredX, visibleFrame.minX), visibleFrame.maxX - popoverSize.width)
    let belowAnchor = anchor.minY - gap - popoverSize.height
    let y = min(max(belowAnchor, visibleFrame.minY), visibleFrame.maxY - popoverSize.height)
    return NSPoint(x: x, y: y)
}

@MainActor
final class MenuSummaryModel: ObservableObject {
    @Published var day = DayData(date: DateCoding.today(), entries: [], totals: .zero)
    @Published var targets = Targets.empty
    @Published var connected = false
    @Published var connectionMessage = "Open Calorie Logger to connect to your private server."
    @Published var updateVersion: String?
    @Published var updateBusy: String?
}

struct MenuPopoverView: View {
    @ObservedObject var model: MenuSummaryModel
    let openLog: () -> Void
    let addFood: () -> Void
    let installUpdate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("TODAY").font(.system(size: 9, weight: .semibold)).tracking(1.4).foregroundStyle(.secondary)
                    Text(DateCoding.date(from: model.day.date)?.formatted(.dateTime.weekday(.wide).day().month()) ?? model.day.date)
                        .font(.system(size: 18, weight: .semibold, design: .serif))
                }
                Spacer()
                Text(model.connected ? "Nutrition summary" : "Connect Calorie Logger").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            if model.connected {
                menuMetric("Calories", value: model.day.totals.calories, target: model.targets.calories, unit: "kcal", color: .secondary)
                menuMetric("Protein", value: model.day.totals.protein, target: model.targets.protein, unit: "g", color: Color(red: 0.25, green: 0.42, blue: 0.29))
                menuMetric("Fat", value: model.day.totals.fat, target: model.targets.fat, unit: "g", color: Color(red: 0.58, green: 0.42, blue: 0.24))
                menuMetric("Carbs", value: model.day.totals.carbs, target: model.targets.carbs, unit: "g", color: Color(red: 0.38, green: 0.46, blue: 0.56))
            } else {
                Text(model.connectionMessage).font(.callout).foregroundStyle(.secondary)
            }
            if let busy = model.updateBusy {
                Divider()
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(busy).font(.callout).foregroundStyle(.secondary)
                }
            } else if let version = model.updateVersion {
                Divider()
                // The desktop application and the server move together, so an update is worth a
                // row of its own rather than a badge someone has to go looking for.
                Button("Update to \(version)", action: installUpdate)
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.22, green: 0.35, blue: 0.26))
                    .frame(maxWidth: .infinity)
            }
            Divider()
            HStack(spacing: 8) {
                Button("Open Calorie Logger", action: openLog)
                Spacer()
                Button("Add Food", action: addFood).buttonStyle(.borderedProminent).tint(Color(red: 0.22, green: 0.35, blue: 0.26)).disabled(!model.connected)
            }
            Button("Quit Calorie Logger") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(width: 310)
    }

    @ViewBuilder
    private func menuMetric(_ name: String, value: Double, target: Double?, unit: String, color: Color) -> some View {
        VStack(spacing: 5) {
            HStack {
                Text(name).font(.caption)
                Spacer()
                Text(target.map { "\(formatted(value)) / \(formatted($0)) \(unit)" } ?? "\(formatted(value)) \(unit)")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.09))
                    Capsule().fill(color).frame(width: geometry.size.width * progress(value, target))
                }
            }.frame(height: 4)
        }
    }

    private func progress(_ value: Double, _ target: Double?) -> CGFloat {
        guard let target, target > 0 else { return 0 }
        return min(max(value / target, 0), 1)
    }

    private func formatted(_ value: Double) -> String {
        value >= 100 ? String(Int(value.rounded())) : String(format: "%.1f", value)
    }
}

@MainActor
final class MenuBarController: NSObject {
    private let statusItem = NSStatusBar.system.statusItem(withLength: 37)
    private let popover = NSPopover()
    private let model = MenuSummaryModel()
    private let requestRefresh: () -> Void
    private var updateAvailable = false

    init(
        openLog: @escaping () -> Void,
        addFood: @escaping () -> Void,
        requestRefresh: @escaping () -> Void,
        installUpdate: @escaping () -> Void
    ) {
        self.requestRefresh = requestRefresh
        super.init()
        popover.behavior = .transient
        popover.animates = false
        popover.contentViewController = NSHostingController(rootView: MenuPopoverView(
            model: model,
            openLog: { [weak self] in self?.popover.close(); openLog() },
            addFood: { [weak self] in self?.popover.close(); addFood() },
            installUpdate: { [weak self] in self?.popover.close(); installUpdate() }
        ))
        if let button = statusItem.button {
            button.action = #selector(togglePopover)
            button.target = self
            button.toolTip = "Calorie Logger totals"
            button.image = NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: "Open Calorie Logger to connect")
        }
    }

    /// A waiting update shows as a mark beside the macro meters, so it is noticed without
    /// interrupting anything.
    func setUpdateAvailable(_ release: MacRelease?) {
        updateAvailable = release != nil
        model.updateVersion = release?.version
        refreshStatusImage()
    }

    func setUpdateBusy(_ description: String?) {
        model.updateBusy = description
    }

    private func refreshStatusImage() {
        guard model.connected else { return }
        statusItem.button?.image = statusImage(day: model.day, targets: model.targets)
    }

    func update(_ summary: MenuSummary) {
        model.day = summary.day
        model.targets = summary.targets
        model.connected = true
        statusItem.button?.image = statusImage(day: summary.day, targets: summary.targets)
    }

    func setConnectionState(_ state: String) {
        if state == "connected" {
            model.connected = true
            statusItem.button?.image = statusImage(day: model.day, targets: model.targets)
            return
        }
        // Being offline is normal now: the log is complete on this device and uploads later, so
        // the totals stay on show and only the symbol changes.
        if state == "offline" {
            model.connected = true
            model.connectionMessage = "Working offline. Changes upload when the server can be reached."
            statusItem.button?.image = statusImage(day: model.day, targets: model.targets)
            return
        }
        model.connected = false
        model.connectionMessage = state == "error"
            ? "Calorie Logger needs attention. Open the app to continue."
            : "Open Calorie Logger to connect to your private server."
        statusItem.button?.image = NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: model.connectionMessage)
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown { popover.performClose(nil) }
        else {
            requestRefresh()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            DispatchQueue.main.async { [weak self, weak button] in
                guard let self, let button, let buttonWindow = button.window,
                      let popoverWindow = self.popover.contentViewController?.view.window else { return }
                let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
                let visibleFrame = buttonWindow.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? anchor
                popoverWindow.setFrameOrigin(menuPopoverOrigin(anchor: anchor, popoverSize: popoverWindow.frame.size, visibleFrame: visibleFrame))
            }
        }
    }

    private func statusImage(day: DayData, targets: Targets) -> NSImage {
        // The three lanes keep their 26pt canvas; the extra width on the right exists only so the
        // update mark has somewhere to sit that does not shorten the meters.
        let image = NSImage(size: NSSize(width: 31, height: 18), flipped: false) { [updateAvailable] _ in
            let values = [day.totals.protein, day.totals.fat, day.totals.carbs]
            let goals = [targets.protein, targets.fat, targets.carbs]
            for index in 0..<3 {
                let y = CGFloat(13 - index * 6)
                let track = NSBezierPath(roundedRect: NSRect(x: 1, y: y, width: 24, height: 3), xRadius: 1.5, yRadius: 1.5)
                NSColor.labelColor.withAlphaComponent(0.22).setFill(); track.fill()
                let ratio = goals[index].map { $0 > 0 ? min(max(values[index] / $0, 0), 1) : 0 } ?? 0
                if ratio > 0 {
                    let fill = NSBezierPath(roundedRect: NSRect(x: 1, y: y, width: 24 * ratio, height: 3), xRadius: 1.5, yRadius: 1.5)
                    NSColor.labelColor.setFill(); fill.fill()
                }
            }
            if updateAvailable {
                NSColor.labelColor.setFill()
                NSBezierPath(ovalIn: NSRect(x: 27, y: 12, width: 4, height: 4)).fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = updateAvailable
            ? "Protein, fat, and carbohydrate progress; an update is available"
            : "Protein, fat, and carbohydrate progress"
        return image
    }
}
