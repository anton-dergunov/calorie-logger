import Foundation

struct Nutrition: Codable, Equatable {
    let calories: Double
    let protein: Double
    let fat: Double
    let carbs: Double

    static let zero = Nutrition(calories: 0, protein: 0, fat: 0, carbs: 0)
}

struct LogEntrySummary: Codable, Equatable {
    let id: String
}

struct DayData: Codable, Equatable {
    let date: String
    let entries: [LogEntrySummary]
    let totals: Nutrition
}

struct Targets: Codable, Equatable {
    let calories: Double?
    let protein: Double?
    let fat: Double?
    let carbs: Double?

    static let empty = Targets(calories: nil, protein: nil, fat: nil, carbs: nil)
}

struct MenuSummary: Codable, Equatable {
    let day: DayData
    let targets: Targets
}

struct StoredSession: Codable, Equatable {
    let baseUrl: String
    let email: String
    let token: String
}

struct SessionRequest: Decodable {
    let session: StoredSession
}

struct ExportSaveRequest: Decodable {
    let filename: String
    let json: String
}

struct MenuStateRequest: Decodable {
    let state: String
}

/// Whether a text field in the page holds focus, which is what decides whether the Edit menu's
/// commands mean anything.
struct TextEditingRequest: Decodable {
    let editing: Bool
}

enum LoggerError: LocalizedError {
    case invalid(String)
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message), .unavailable(let message): message
        }
    }
}

enum DateCoding {
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func today() -> String { formatter.string(from: Date()) }
    static func date(from string: String) -> Date? { formatter.date(from: string) }
}
