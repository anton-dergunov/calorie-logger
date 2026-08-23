import AppKit
import Foundation
import Security
import WebKit

final class WebBridge: NSObject, WKScriptMessageHandlerWithReply {
    private enum Keys {
        static let baseURL = "CalorieLoggerBackendBaseURL"
        static let email = "CalorieLoggerBackendEmail"
        static let account = "calorie-logger-api-token"
    }

    private let defaults: UserDefaults
    private let keychainService: String
    var onSummary: ((MenuSummary) -> Void)?
    var onConnectionState: ((String) -> Void)?

    init(defaults: UserDefaults = .standard, keychainService: String = "com.calorielogger.app.session") {
        self.defaults = defaults
        self.keychainService = keychainService
        super.init()
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

    func loadSession() throws -> StoredSession? {
        guard let baseURL = defaults.string(forKey: Keys.baseURL),
              let email = defaults.string(forKey: Keys.email) else { return nil }
        return StoredSession(baseUrl: baseURL, email: email, token: try readToken() ?? "")
    }

    func saveSession(_ session: StoredSession) throws {
        guard !session.baseUrl.isEmpty, !session.email.isEmpty, !session.token.isEmpty else {
            throw LoggerError.invalid("The session is incomplete.")
        }
        defaults.set(session.baseUrl, forKey: Keys.baseURL)
        defaults.set(session.email, forKey: Keys.email)
        try writeToken(session.token)
    }

    func clearSession() {
        defaults.removeObject(forKey: Keys.baseURL)
        defaults.removeObject(forKey: Keys.email)
        clearToken()
    }

    func clearToken() {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: Keys.account
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func readToken() throws -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: Keys.account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw LoggerError.unavailable("The saved Calorie Logger session could not be read from Keychain.")
        }
        return token
    }

    private func writeToken(_ token: String) throws {
        let base: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: Keys.account
        ]
        let data = Data(token.utf8)
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            var insert = base
            insert[kSecValueData] = data
            insert[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else {
                throw LoggerError.unavailable("The Calorie Logger session could not be saved to Keychain.")
            }
        } else if status != errSecSuccess {
            throw LoggerError.unavailable("The Calorie Logger session could not be updated in Keychain.")
        }
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
