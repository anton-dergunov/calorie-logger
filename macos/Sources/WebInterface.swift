import Foundation
import WebKit

/// Serves the bundled Vite build to the embedded web view.
///
/// The interface used to be handed to WebKit as an HTML string with a `file://` base URL, which
/// forced the stylesheet to be inlined and the script to be injected as a `WKUserScript`, because
/// WebKit will parse but not execute `file://` script tags. A `file://` page also has no usable
/// IndexedDB, and the offline copy of the log lives there — so the app is served from a real
/// origin instead, and ordinary `<script>` and `<link>` tags work again.
enum WebInterface {
    static let scheme = "calorie-logger"
    static let host = "app"

    static var startURL: URL {
        URL(string: "\(scheme)://\(host)/index.html")!
    }

    /// Shown before the bundle's own script runs, so a failure to start is explained rather than
    /// leaving a blank window.
    static let startupDiagnostics = #"""
    (() => {
      const showStartupError = (message) => {
        const root = document.getElementById('root');
        if (!root) return;
        root.innerHTML = `<main style="max-width:680px;margin:80px auto;padding:32px;font:15px -apple-system;color:#342f29"><h1 style="font:600 28px Georgia,serif">Calorie Logger could not open</h1><p>${String(message)}</p><p>Please quit and reopen the app. If this continues, rebuild it with <code>npm run build:mac</code>.</p></main>`;
      };
      window.addEventListener('error', event => showStartupError(event.message || 'The interface failed to start.'));
      window.addEventListener('unhandledrejection', event => showStartupError(event.reason?.message || event.reason || 'The interface failed to start.'));
    })();
    """#

    static func bundledInterfaceDirectory() -> URL? {
        if let nested = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "dist") {
            return nested.deletingLastPathComponent()
        }
        return Bundle.main.url(forResource: "index", withExtension: "html")?.deletingLastPathComponent()
    }
}

final class WebInterfaceSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let file = resolve(url) else {
            task.didFailWithError(LoggerError.unavailable("The bundled web interface is missing."))
            return
        }
        do {
            let data = try Data(contentsOf: file)
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": Self.contentType(for: file.pathExtension),
                    "Content-Length": String(data.count),
                    // The bundle is immutable and hashed; nothing here should ever be revalidated.
                    "Cache-Control": "no-cache"
                ]
            )!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        } catch {
            task.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    func resolveForTesting(_ url: URL) -> URL? { resolve(url) }

    /// Maps a request path onto a file inside the bundle, refusing anything that escapes it.
    private func resolve(_ url: URL) -> URL? {
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let candidate = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/"),
              FileManager.default.fileExists(atPath: candidate.path) else { return nil }
        return candidate
    }

    static func contentType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "wasm": return "application/wasm"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}
