import AppKit
import Foundation

/// Whether this launch should put the window on screen, or leave Calorie Logger in the menu bar.
///
/// Opening the app yourself is a request to see today's page. Being started at login is not: the
/// menu bar is the whole point of running at login, and a window appearing over whatever you were
/// doing while you log in is an interruption nobody asked for.
///
/// The decision is a pure function of the launch's own evidence so it can be tested without
/// logging out and back in.
@MainActor
enum LaunchContext {
    /// Set when someone would rather see the window even on a login launch.
    static let showWindowAtLoginKey = "CalorieLoggerShowWindowAtLogin"

    /// AppKit's own answer to "did a person ask for this launch", handed to
    /// `applicationDidFinishLaunching` in the notification's `userInfo`.
    static let isDefaultLaunchKey: AnyHashable = NSApplication.launchIsDefaultUserInfoKey

    static func startsInMenuBarOnly(
        launchUserInfo: [AnyHashable: Any]?,
        environment: [String: String],
        bundleIdentifier: String?,
        showWindowAtLogin: Bool
    ) -> Bool {
        if showWindowAtLogin { return false }
        return startedByLaunchd(environment: environment, bundleIdentifier: bundleIdentifier)
            || wasOpenedWithoutBeingAsked(launchUserInfo: launchUserInfo)
    }

    /// launchd hands a service name naming the registered application; a launch from the Finder,
    /// the Dock, or Spotlight does not. This is the signal that survives whatever else macOS
    /// decides to report about the launch.
    static func startedByLaunchd(environment: [String: String], bundleIdentifier: String?) -> Bool {
        guard let bundleIdentifier, !bundleIdentifier.isEmpty,
              let service = environment["XPC_SERVICE_NAME"] else { return false }
        return service.contains(bundleIdentifier)
    }

    /// False only when AppKit positively says a person opened the app. An absent key says nothing,
    /// so it is not treated as either answer.
    static func wasOpenedWithoutBeingAsked(launchUserInfo: [AnyHashable: Any]?) -> Bool {
        guard let isDefaultLaunch = launchUserInfo?[isDefaultLaunchKey] as? Bool else { return false }
        return !isDefaultLaunch
    }
}
