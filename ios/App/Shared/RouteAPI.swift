import Foundation

struct Stop: Codable, Identifiable {
    let n: Int
    let id: String
    let type: String
    let kind: String?
    let name: String
    let address: String?
    let city: String?
    let tier: String?
    let last_order_at: String?
    let trailing_12m_revenue: Double?
    let lifetime_revenue: Double?
    let straight_line_miles_from_prev: Double?
    let done: Bool
    /// "HH:MM" stated on the route screen (a lunch, a calendar event).
    let locked_at: String?
    /// Rough arrival "HH:MM" for a stop still to make.
    let eta: String?
    let drive_minutes: Int?
    let maps_url: String
    let call_url: String?
}

struct RouteSchedule: Codable {
    let finish_clock: String
}

/// Where the day ends (a hotel, or home). Not an account: no call, no done.
struct RouteEnd: Codable {
    let label: String
    let address: String?
    let straight_line_miles_from_prev: Double?
    let maps_url: String
}

struct RouteData: Codable {
    let ok: Bool
    let generated_at: String
    let day: String
    let count: Int
    let stops: [Stop]
    let end: RouteEnd?
    let day_state: String
    /// "Tomorrow" or a weekday once today has ended and the widget shows the next route.
    let heading: String?
    let visited_count: Int?
    let schedule: RouteSchedule?
}

enum RouteAPI {
    static func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: Secrets.base + path)!)
        r.httpMethod = method
        r.timeoutInterval = 20
        r.setValue("Bearer " + Secrets.widgetToken, forHTTPHeaderField: "Authorization")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    static func fetch() async -> RouteData? {
        guard let (data, _) = try? await URLSession.shared.data(for: request("/api/widget")) else { return nil }
        return try? JSONDecoder().decode(RouteData.self, from: data)
    }

    @discardableResult
    static func post(_ body: [String: Any]) async -> Bool {
        guard let (data, _) = try? await URLSession.shared.data(for: request("/api/widget/act", method: "POST", body: body)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return obj["ok"] as? Bool ?? false
    }
}

extension Stop {
    var mapsURL: URL? {
        URL(string: maps_url.replacingOccurrences(of: "https://maps.apple.com/", with: "maps://"))
    }
}
