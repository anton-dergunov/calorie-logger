import AppKit

/// Coming forward from the menu bar, and going back to it, in one place.
///
/// Calorie Logger spends most of its life as an accessory: a status item, no Dock icon, and no menu
/// bar of its own. Showing a window means becoming a regular application first, and that transition
/// is the part macOS does not finish on its own. The menu bar follows *activation* rather than the
/// activation policy, so a policy change made while another application owns the bar leaves that
/// application's menu on show -- with Calorie Logger's own window key in front of it, and
/// `NSApp.isActive` already answering true. Anything that asks that question therefore does
/// nothing, which is why switching to another application and back was the only cure.
@MainActor
enum AppActivation {
    /// Held so it can be put back. Re-assigning the main menu is what makes AppKit rebuild the bar
    /// for this application rather than leaving whatever the previous owner had installed.
    static var mainMenu: NSMenu?

    /// Brings Calorie Logger forward, with the menu bar it is supposed to have.
    static func bringForward(_ window: NSWindow? = nil) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        // AppKit documents that activation may lag behind the request, and this pass is deliberately
        // unconditional: the failure it exists for is the one where the application already believes
        // it is active. It also runs after a status popover has finished returning focus to whatever
        // it took it from.
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            restoreMainMenu()
            window?.makeKeyAndOrderFront(nil)
        }
    }

    /// Puts Calorie Logger's own menu bar back. Assigning the menu AppKit already holds is a no-op,
    /// so it is cleared first; both writes happen in one pass of the run loop, so nothing is drawn
    /// in between.
    static func restoreMainMenu() {
        guard let menu = mainMenu else { return }
        NSApp.mainMenu = nil
        NSApp.mainMenu = menu
    }

    /// Whether the application should drop back to the menu bar.
    ///
    /// Pure, and told only about the windows Calorie Logger owns: `NSApp.windows` also holds the
    /// status item's window and the popover's, and neither is a reason to keep a Dock icon.
    static func shouldReturnToMenuBar(owning windows: [NSWindow?]) -> Bool {
        !windows.contains { $0?.isVisible == true }
    }

    /// Returns to the menu bar once nothing is left on screen. The window that is closing still
    /// reports itself visible while its delegate runs, so the decision waits for AppKit to finish
    /// closing it -- and the Settings window standing next to the log is enough to keep the Dock
    /// icon and the menu bar where they are.
    static func returnToMenuBar(owning windows: [NSWindow?]) {
        DispatchQueue.main.async {
            guard shouldReturnToMenuBar(owning: windows) else { return }
            NSApp.setActivationPolicy(.accessory)
        }
    }
}
