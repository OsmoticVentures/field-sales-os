import SwiftUI
import WidgetKit
import AppIntents

// MARK: intents (run inside the widget, no app launch)

struct MarkDoneIntent: AppIntent {
    static var title: LocalizedStringResource = "Mark stop done"
    @Parameter(title: "Stop") var stopId: String
    @Parameter(title: "Day") var day: String
    init() {}
    init(stopId: String, day: String) { self.stopId = stopId; self.day = day }
    func perform() async throws -> some IntentResult {
        await RouteAPI.post(["action": "done", "day": day, "id": stopId])
        return .result()
    }
}

struct RefreshIntent: AppIntent {
    static var title: LocalizedStringResource = "Update route"
    func perform() async throws -> some IntentResult { .result() }
}

// MARK: timeline

struct RouteEntry: TimelineEntry {
    let date: Date
    let data: RouteData?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> RouteEntry { RouteEntry(date: Date(), data: nil) }
    func getSnapshot(in context: Context, completion: @escaping (RouteEntry) -> Void) {
        Task { completion(RouteEntry(date: Date(), data: await RouteAPI.fetch())) }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<RouteEntry>) -> Void) {
        Task {
            let entry = RouteEntry(date: Date(), data: await RouteAPI.fetch())
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(5 * 60))))
        }
    }
}

// MARK: palette (cream)

extension Color {
    init(light: UInt, dark: UInt) {
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}
extension UIColor {
    convenience init(hex: UInt) {
        self.init(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
}
enum Pal {
    static let paper = Color(light: 0xF6ECD2, dark: 0x1A1710)
    static let ink = Color(light: 0x1F2A22, dark: 0xF2EDDD)
    static let muted = Color(light: 0x6B6553, dark: 0xB3AC98)
    static let faint = Color(light: 0x968E78, dark: 0x8A8470)
    static let rule = Color(light: 0xE3D6B4, dark: 0x332E22)
    static let green = Color(light: 0x2C6A46, dark: 0x63A57E)
    static let amber = Color(light: 0xA0762C, dark: 0xC9A24B)
    static let pill = Color(light: 0xEBDDB9, dark: 0x2A261A)
    static let pillGreen = Color(light: 0xDCE6CC, dark: 0x1F2A1F)
}

// MARK: helpers

private let months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

func usd(_ n: Double) -> String {
    n >= 10000 ? "$\(Int((n / 1000).rounded()))k" : "$" + NumberFormatter.localizedString(from: NSNumber(value: Int(n.rounded())), number: .decimal)
}

extension Stop {
    var moneyLine: String {
        var bits: [String] = []
        if let d = last_order_at {
            let p = d.split(separator: "-")
            if p.count >= 2, let m = Int(p[1]), m >= 1, m <= 12 { bits.append("\(months[m - 1]) \(p[0])") } else { bits.append(d) }
        } else { bits.append("never ordered") }
        if let r = trailing_12m_revenue, r != 0 { bits.append("12m \(usd(r))") }
        else if let l = lifetime_revenue, l != 0 { bits.append("life \(usd(l))") }
        return bits.joined(separator: "  ·  ")
    }
    var tierLabel: String? {
        if type == "custom" { return (kind ?? "stop").uppercased() }
        return tier.map { "TIER \($0)" }
    }
}

func deepLink(_ host: String, _ items: [String: String]) -> URL {
    var c = URLComponents()
    c.scheme = "fieldsalesos"
    c.host = host
    c.queryItems = items.map { URLQueryItem(name: $0.key, value: $0.value) }
    return c.url!
}

// MARK: views

struct PillLink: View {
    let label: String
    let url: URL
    var filled = false
    var body: some View {
        Link(destination: url) {
            Text(label)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(filled ? .white : Pal.ink)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(filled ? Pal.green : Pal.pill)
                .clipShape(RoundedRectangle(cornerRadius: 7))
        }
    }
}

struct Chip: View {
    let stop: Stop
    var body: some View {
        Text("\(stop.n)")
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundColor(Pal.paper)
            .frame(width: 18, height: 18)
            .background(stop.type == "custom" ? Pal.amber : Pal.ink)
            .clipShape(stop.type == "custom" ? AnyShape(RoundedRectangle(cornerRadius: 5)) : AnyShape(Circle()))
    }
}

struct StopRow: View {
    let stop: Stop
    let data: RouteData
    let remaining: Int
    let showMiles: Bool

    var callURL: URL {
        let tel = (stop.call_url ?? "").replacingOccurrences(of: "tel:", with: "")
        if stop.type == "account" { return deepLink("call", ["account": stop.id, "tel": tel]) }
        return URL(string: stop.call_url ?? "tel:")!
    }
    var goURL: URL {
        if data.day_state == "not_started" { return deepLink("odo", ["kind": "start", "day": data.day, "go": stop.id]) }
        return stop.mapsURL ?? URL(string: "maps://")!
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 7) {
                Chip(stop: stop)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(stop.name).font(.system(size: 12.5, weight: .semibold)).foregroundColor(Pal.ink).lineLimit(1)
                        if let t = stop.tierLabel {
                            Text(t).font(.system(size: 8.5, weight: .semibold)).foregroundColor(stop.type == "custom" ? Pal.amber : Pal.green)
                        }
                    }
                    let sub = [stop.address, stop.city].compactMap { $0 }.joined(separator: ", ")
                    if !sub.isEmpty { Text(sub).font(.system(size: 9.5)).foregroundColor(Pal.muted).lineLimit(1) }
                    if stop.type == "account" { Text(stop.moneyLine).font(.system(size: 9.5)).foregroundColor(Pal.faint).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if showMiles, let m = stop.straight_line_miles_from_prev {
                    Text("\(String(format: "%.1f", m)) mi").font(.system(size: 9.5)).foregroundColor(Pal.faint)
                }
            }
            HStack(spacing: 5) {
                PillLink(label: "GO", url: goURL, filled: true)
                if stop.type == "account" || stop.call_url != nil {
                    PillLink(label: stop.call_url == nil ? "No phone" : "Call", url: callURL)
                }
                if stop.type == "account" {
                    PillLink(label: "Account", url: deepLink("account", ["id": stop.id]))
                    PillLink(label: "SDR", url: deepLink("sdr", ["account": stop.id]))
                }
                Spacer(minLength: 0)
                doneControl
            }
            .padding(.leading, 25)
        }
    }

    @ViewBuilder var doneControl: some View {
        let last = remaining == 1 && data.day_state != "ended" && data.day_state != "ahead"
        Group {
            if last {
                Link(destination: deepLink("odo", ["kind": "end", "day": data.day, "done": stop.id])) { check }
            } else {
                Button(intent: MarkDoneIntent(stopId: stop.id, day: data.day)) { check }.buttonStyle(.plain)
            }
        }
    }

    var check: some View {
        Image(systemName: "checkmark")
            .font(.system(size: 12, weight: .bold))
            .foregroundColor(Pal.green)
            .frame(width: 34, height: 24)
            .background(Pal.pillGreen)
            .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}

struct RouteView: View {
    let entry: RouteEntry

    var body: some View {
        if let data = entry.data {
            content(data)
        } else {
            VStack(alignment: .leading) {
                Text("Route unavailable").font(.system(size: 14, weight: .semibold)).foregroundColor(.red)
                Spacer()
                refresh(nil)
            }
        }
    }

    func rows(_ data: RouteData) -> [Stop] { data.stops.filter { !$0.done } }

    func content(_ data: RouteData) -> some View {
        let rows = rows(data)
        let miles = rows.dropFirst().reduce(0.0) { $0 + ($1.straight_line_miles_from_prev ?? 0) }
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text((data.heading ?? "Route").uppercased()).font(.system(size: 10, weight: .semibold)).foregroundColor(Pal.faint)
                Spacer()
                if !rows.isEmpty {
                    Text("\(rows.count) stop\(rows.count == 1 ? "" : "s")" + (miles > 0 ? " · \(Int(miles.rounded())) mi" : ""))
                        .font(.system(size: 10)).foregroundColor(Pal.faint)
                }
            }
            if rows.isEmpty {
                Spacer()
                if data.day_state == "ready_to_end" {
                    Link(destination: deepLink("odo", ["kind": "end", "day": data.day])) {
                        Text("End odometer").font(.system(size: 17, weight: .semibold)).foregroundColor(Pal.ink)
                    }
                } else {
                    Text(data.count > 0 || (data.visited_count ?? 0) > 0 ? "Done for the day" : "No stops")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(data.count > 0 || (data.visited_count ?? 0) > 0 ? Pal.green : Pal.ink)
                }
                Spacer()
            } else {
                Spacer().frame(height: 8)
                let shown = Array(rows.prefix(4))
                ForEach(Array(shown.enumerated()), id: \.element.id) { i, s in
                    if i > 0 {
                        Divider().overlay(Pal.rule).padding(.vertical, 5)
                    }
                    StopRow(stop: s, data: data, remaining: rows.count, showMiles: i > 0)
                }
                Spacer(minLength: 4)
            }
            HStack {
                refresh(data)
                Spacer()
                if rows.count > 4 { Text("+\(rows.count - 4) more").font(.system(size: 9.5)).foregroundColor(Pal.faint) }
            }
        }
    }

    func refresh(_ data: RouteData?) -> some View {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let at = data.flatMap { f.date(from: $0.generated_at) } ?? entry.date
        return Button(intent: RefreshIntent()) {
            Text("as of \(at.formatted(date: .omitted, time: .shortened)) · tap to update")
                .font(.system(size: 9.5)).foregroundColor(Pal.faint)
        }.buttonStyle(.plain)
    }
}

struct FieldRouteWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FieldRouteWidget", provider: Provider()) { entry in
            RouteView(entry: entry)
                .containerBackground(Pal.paper, for: .widget)
        }
        .configurationDisplayName("Field Route")
        .description("Today's stops.")
        .supportedFamilies([.systemLarge])
    }
}

@main
struct FieldRouteBundle: WidgetBundle {
    var body: some Widget { FieldRouteWidget() }
}
