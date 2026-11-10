import Foundation
import CoreLocation

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
        // Where the phone is now, so the next drive is timed from here and
        // not from the last stop checked off.
        var path = "/api/widget"
        if let here = await Here.fix() {
            path += String(format: "?lat=%.6f&lng=%.6f", here.coordinate.latitude, here.coordinate.longitude)
        }
        guard let (data, _) = try? await URLSession.shared.data(for: request(path)) else { return nil }
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

/// One location fix for a refresh: a fresh one when iOS gives it within a few
/// seconds, else the last fix of the past 15 minutes, else none (the server
/// then falls back to the last stop made).
@MainActor
final class Here: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var done: CheckedContinuation<CLLocation?, Never>?

    static func fix() async -> CLLocation? {
        await Here().locate()
    }

    private func recent() -> CLLocation? {
        guard let l = manager.location, -l.timestamp.timeIntervalSinceNow < 15 * 60 else { return nil }
        return l
    }

    private func locate() async -> CLLocation? {
        let status = manager.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else { return nil }
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        return await withCheckedContinuation { c in
            done = c
            manager.requestLocation()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                self.finish(self.recent())
            }
        }
    }

    private func finish(_ l: CLLocation?) {
        guard let c = done else { return }
        done = nil
        c.resume(returning: l)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let l = locations.last
        Task { @MainActor in self.finish(l ?? self.recent()) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(self.recent()) }
    }
}
