import AppKit
import Foundation
import Security
import WebKit

final class WebBridge: NSObject, WKScriptMessageHandlerWithReply {
    private enum Keys {
        static let baseURL = "CalorieLoggerBackendBaseURL"
        static let email = "CalorieLoggerBackendEmail"
        static let token = "CalorieLoggerBackendToken"
        static let account = "calorie-logger-api-token"
    }

    private let defaults: UserDefaults
    /// Only used to clear the session an earlier release left in Keychain. Nothing is written there.
    private let legacyKeychainService: String
    var onSummary: ((MenuSummary) -> Void)?
    var onConnectionState: ((String) -> Void)?
    var onTextEditingChanged: ((Bool) -> Void)?

    init(defaults: UserDefaults = .standard, legacyKeychainService: String = "com.calorielogger.app.session") {
        self.defaults = defaults
        self.legacyKeychainService = legacyKeychainService
        super.init()
        discardLegacyKeychainSession()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        do {
            guard let envelope = message.body as? [String: Any],
                  let method = envelope["method"] as? String else {
                throw LoggerError.invalid("Malformed bridge request.")
            }
            let payload = envelope["payload"] ?? [:]
            switch method {
            case "loadSession":
                try success(loadSession(), replyHandler)
            case "saveSession":
                let request: SessionRequest = try decode(payload)
                try saveSession(request.session)
                successVoid(replyHandler)
            case "clearSession":
                clearSession()
                successVoid(replyHandler)
            case "clearToken":
                clearToken()
                successVoid(replyHandler)
            case "updateMenuSummary":
                let summary: MenuSummary = try decode(payload)
                DispatchQueue.main.async { [weak self] in self?.onSummary?(summary) }
                successVoid(replyHandler)
            case "updateMenuState":
                let request: MenuStateRequest = try decode(payload)
                DispatchQueue.main.async { [weak self] in self?.onConnectionState?(request.state) }
                successVoid(replyHandler)
            case "setTextEditing":
                let request: TextEditingRequest = try decode(payload)
                DispatchQueue.main.async { [weak self] in self?.onTextEditingChanged?(request.editing) }
                successVoid(replyHandler)
            case "saveExport":
                let request: ExportSaveRequest = try decode(payload)
                try saveExport(request, replyHandler: replyHandler)
            default:
                throw LoggerError.invalid("Unknown bridge method: \(method)")
            }
        } catch {
            replyHandler(["error": error.localizedDescription], nil)
        }
    }

    // The whole session lives in preferences, the API token included.
    //
    // Keychain was the obvious home for a token and turned out to be the wrong one here. macOS ties
    // a Keychain item's access control to the code identity that wrote it, and this application
    // carries an ad-hoc signature, which differs on every build. So each new build was a stranger to
    // the item it had written itself, and the owner was asked to unlock their login keychain again --
    // for a build about to be replaced by the next one. The prompt is indistinguishable from the
    // ones worth being suspicious of, and teaching someone to type their password into it whenever
    // an application asks is a worse outcome than where the token sits.
    //
    // What it costs: the token is readable by anything already running as this user. It is a
    // session credential for the owner's own server, it expires, and signing out revokes it.
    func loadSession() throws -> StoredSession? {
        guard let baseURL = defaults.string(forKey: Keys.baseURL),
              let email = defaults.string(forKey: Keys.email) else { return nil }
        return StoredSession(baseUrl: baseURL, email: email, token: defaults.string(forKey: Keys.token) ?? "")
    }

    func saveSession(_ session: StoredSession) throws {
        guard !session.baseUrl.isEmpty, !session.email.isEmpty, !session.token.isEmpty else {
            throw LoggerError.invalid("The session is incomplete.")
        }
        defaults.set(session.baseUrl, forKey: Keys.baseURL)
        defaults.set(session.email, forKey: Keys.email)
        defaults.set(session.token, forKey: Keys.token)
    }

    func clearSession() {
        defaults.removeObject(forKey: Keys.baseURL)
        defaults.removeObject(forKey: Keys.email)
        clearToken()
    }

    func clearToken() {
        defaults.removeObject(forKey: Keys.token)
    }

    /// Removes what an earlier release stored in Keychain, so the prompt it caused stops for good.
    /// Deleting an item needs no access to its contents, so this asks the owner nothing.
    private func discardLegacyKeychainSession() {
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: legacyKeychainService,
            kSecAttrAccount: Keys.account
        ] as CFDictionary)
    }

    private func saveExport(_ request: ExportSaveRequest, replyHandler: @escaping (Any?, String?) -> Void) throws {
        guard let data = request.json.data(using: .utf8) else { throw LoggerError.invalid("The export document is invalid.") }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = request.filename
        panel.begin { response in
            do {
                if response == .OK, let url = panel.url {
                    try data.write(to: url, options: .atomic)
                    try self.success(["status": "saved", "path": url.path], replyHandler)
                } else {
                    try self.success(["status": "cancelled"], replyHandler)
                }
            } catch {
                replyHandler(["error": error.localizedDescription], nil)
            }
        }
    }

    private func decode<T: Decodable>(_ object: Any) throws -> T {
        guard JSONSerialization.isValidJSONObject(object) else { throw LoggerError.invalid("Malformed bridge payload.") }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func success<T: Encodable>(_ value: T, _ replyHandler: @escaping (Any?, String?) -> Void) throws {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed])
        replyHandler(["data": object], nil)
    }

    private func successVoid(_ replyHandler: @escaping (Any?, String?) -> Void) {
        replyHandler(["data": NSNull()], nil)
    }
}
