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

// MARK: palette (ClientOS, src/lib/core/ui.tsx)

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
    static let paper = Color(light: 0xF7F6F1, dark: 0x121814)
    static let card = Color(light: 0xFFFFFF, dark: 0x1C241F)
    static let ink = Color(light: 0x14201B, dark: 0xEEF1EC)
    static let muted = Color(light: 0x5B6560, dark: 0xA9B1AB)
    static let faint = Color(light: 0x8A928C, dark: 0x7E8781)
    static let rule = Color(light: 0xE2DFD5, dark: 0x2A332D)
    static let green = Color(light: 0x2C6A46, dark: 0x4F9A6E)
    static let amber = Color(light: 0xA0762C, dark: 0xC9A24B)
    static let control = Color(light: 0xECEAE1, dark: 0x26302A)
}

// MARK: helpers

/// The book stores many names and streets in capitals ("CEDROS AVENUE
/// NATURAL HEALTH"). Read in normal case; short consonant runs (LLC, CBD)
/// and mixed-case names stay as written.
func readable(_ s: String) -> String {
    let letters = s.filter { $0.isLetter }
    guard !letters.isEmpty, letters == letters.uppercased() else { return s }
    return s.split(separator: " ", omittingEmptySubsequences: false).map { w -> String in
        let word = String(w)
        let vowels = word.lowercased().filter { "aeiouy".contains($0) }
        if word.count <= 4 && vowels.isEmpty && word.count > 1 { return word }
        return word.capitalized
    }.joined(separator: " ")
}

/// "14:05" to "2:05 PM".
func clock12(_ hhmm: String?) -> String? {
    guard let hhmm else { return nil }
    let p = hhmm.split(separator: ":").compactMap { Int($0) }
    guard p.count == 2 else { return nil }
    let h = p[0] % 24
    return "\((h + 11) % 12 + 1):\(String(format: "%02d", p[1])) \(h < 12 ? "AM" : "PM")"
}

private let months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

func usd(_ n: Double) -> String {
    n >= 10000 ? "$\(Int((n / 1000).rounded()))k" : "$" + NumberFormatter.localizedString(from: NSNumber(value: Int(n.rounded())), number: .decimal)
}

func driveText(_ m: Int?) -> String? {
    guard let m, m > 0 else { return nil }
    return m < 60 ? "\(m) min drive" : "\(m / 60)h \(String(format: "%02d", m % 60))m drive"
}

extension Stop {
    var title: String { readable(name) }
    var place: String? {
        let sub = [address, city].compactMap { $0 }.filter { !$0.isEmpty }.map(readable).joined(separator: ", ")
        return sub.isEmpty ? nil : sub
    }
    var isCustom: Bool { type == "custom" }
    /// Last order, 12-month and lifetime buying, only what the book holds.
    var moneyLine: String? {
        guard type == "account" else { return nil }
        var bits: [String] = []
        if let d = last_order_at {
            let p = d.split(separator: "-")
            if p.count >= 2, let m = Int(p[1]), m >= 1, m <= 12 { bits.append("Last order \(months[m - 1]) \(p[0])") }
        }
        if let r = trailing_12m_revenue, r > 0 { bits.append("12m \(usd(r))") }
        if let l = lifetime_revenue, l > 0 { bits.append("Lifetime \(usd(l))") }
        if bits.isEmpty && last_order_at == nil { return "Never ordered" }
        return bits.isEmpty ? nil : bits.joined(separator: " · ")
    }
    /// The clock to show: the stated time when there is one, else the ETA.
    var when: String? { clock12(locked_at ?? eta) }
}

func deepLink(_ host: String, _ items: [String: String]) -> URL {
    var c = URLComponents()
    c.scheme = "fieldsalesos"
    c.host = host
    c.queryItems = items.map { URLQueryItem(name: $0.key, value: $0.value) }
    return c.url!
}

// Every tap goes through the app: a widget hands any URL to its own app,
// so the app is what opens the dialer and Maps, every time.
func goURL(_ stop: Stop, _ data: RouteData) -> URL {
    deepLink("go", ["day": data.day, "stop": stop.id, "maps": stop.maps_url, "state": data.day_state])
}
func callURL(_ stop: Stop) -> URL {
    let tel = (stop.call_url ?? "").replacingOccurrences(of: "tel:", with: "")
    return deepLink("call", stop.type == "account" ? ["account": stop.id, "tel": tel] : ["tel": tel])
}

// MARK: views

struct Badge: View {
    let stop: Stop
    var size: CGFloat = 20
    var body: some View {
        Text("\(stop.n)")
            .font(.system(size: size * 0.5, weight: .semibold))
            .monospacedDigit()
            .foregroundColor(Pal.paper)
            .frame(width: size, height: size)
            .background(stop.isCustom ? Pal.amber : Pal.ink)
            .clipShape(stop.isCustom ? AnyShape(RoundedRectangle(cornerRadius: size * 0.25)) : AnyShape(Circle()))
    }
}

/// A secondary action: same height as GO, quiet fill.
struct ActionIcon<Label: View>: View {
    @ViewBuilder let label: () -> Label
    var body: some View {
        label()
            .foregroundColor(Pal.ink)
            .frame(width: 44, height: 36)
            .background(Pal.control)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// The stop to drive to now: everything needed at a light, one primary act.
struct NextStop: View {
    let stop: Stop
    let data: RouteData
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 8) {
            Link(destination: stop.type == "account" ? deepLink("account", ["id": stop.id]) : deepLink("route", ["day": data.day, "stop": stop.id])) {
                HStack(alignment: .top, spacing: 9) {
                    Badge(stop: stop, size: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(stop.title)
                            .font(.system(size: compact ? 15 : 17, weight: .semibold))
                            .tracking(-0.2)
                            .foregroundColor(Pal.ink)
                            .lineLimit(compact ? 1 : 2)
                        timeLine
                        if let money = stop.moneyLine {
                            Text(money).font(.system(size: 12)).monospacedDigit().foregroundColor(Pal.ink.opacity(0.8)).lineLimit(1)
                        }
                        if !compact, let place = stop.place {
                            Text(place).font(.system(size: 12)).foregroundColor(Pal.muted).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            HStack(spacing: 6) {
                Link(destination: goURL(stop, data)) {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.turn.up.right.diamond.fill").font(.system(size: 13, weight: .semibold))
                        Text("Go").font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(Pal.green)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                if stop.call_url != nil {
                    Link(destination: callURL(stop)) {
                        ActionIcon { Image(systemName: "phone.fill").font(.system(size: 14, weight: .medium)) }
                    }
                }
                if stop.type == "account" {
                    Link(destination: deepLink("sdr", ["account": stop.id])) {
                        ActionIcon { Text("SDR").font(.system(size: 12, weight: .semibold)) }
                    }
                }
                doneControl
            }
        }
    }

    @ViewBuilder var timeLine: some View {
        HStack(spacing: 4) {
            if stop.locked_at != nil {
                Image(systemName: "lock.fill").font(.system(size: 9, weight: .semibold)).foregroundColor(Pal.amber)
            }
            if let w = stop.when {
                Text(w).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                    .foregroundColor(stop.locked_at != nil ? Pal.amber : Pal.green)
            }
            if let d = driveText(stop.drive_minutes) {
                Text(d).font(.system(size: 12)).foregroundColor(Pal.muted)
            }
        }
        .lineLimit(1)
    }

    /// Checking a stop only crosses it off, the last one too. The end
    /// odometer belongs to the end of the day: checking Home (or the hotel).
    var doneControl: some View {
        Button(intent: MarkDoneIntent(stopId: stop.id, day: data.day)) {
            ActionIcon { Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundColor(Pal.green) }
        }.buttonStyle(.plain)
    }
}

/// Every stop made: the drive home (or to the hotel) is the current row,
/// Go and a check. The check is what asks for the end odometer.
struct NextEnd: View {
    let end: RouteEnd
    let data: RouteData
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 8) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "house.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Pal.paper)
                    .frame(width: 22, height: 22)
                    .background(Pal.ink)
                    .clipShape(RoundedRectangle(cornerRadius: 5.5))
                VStack(alignment: .leading, spacing: 2) {
                    Text(readable(end.label))
                        .font(.system(size: compact ? 15 : 17, weight: .semibold))
                        .tracking(-0.2)
                        .foregroundColor(Pal.ink)
                        .lineLimit(1)
                    if let back = clock12(data.schedule?.finish_clock) {
                        Text("back \(back)").font(.system(size: 13, weight: .semibold)).monospacedDigit().foregroundColor(Pal.green)
                    }
                    if !compact, let a = end.address, !a.isEmpty {
                        Text(readable(a)).font(.system(size: 12)).foregroundColor(Pal.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                Link(destination: deepLink("go", ["day": data.day, "stop": "end", "maps": end.maps_url, "state": data.day_state])) {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.turn.up.right.diamond.fill").font(.system(size: 13, weight: .semibold))
                        Text("Go").font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(Pal.green)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                Link(destination: deepLink("odo", ["kind": "end", "day": data.day])) {
                    ActionIcon { Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundColor(Pal.green) }
                }
            }
        }
    }
}

/// A later stop: one line, number, name, clock.
struct LaterRow: View {
    let stop: Stop
    let data: RouteData
    var body: some View {
        Link(destination: deepLink("route", ["day": data.day, "stop": stop.id])) {
            HStack(spacing: 9) {
                Badge(stop: stop, size: 18)
                Text(stop.title).font(.system(size: 13.5, weight: .medium)).foregroundColor(Pal.ink).lineLimit(1)
                Spacer(minLength: 6)
                if stop.locked_at != nil {
                    Image(systemName: "lock.fill").font(.system(size: 8, weight: .semibold)).foregroundColor(Pal.amber)
                }
                if let w = stop.when {
                    Text(w).font(.system(size: 12.5)).monospacedDigit()
                        .foregroundColor(stop.locked_at != nil ? Pal.amber : Pal.muted)
                }
            }
            .frame(minHeight: 26)
        }
    }
}

struct EndRow: View {
    let end: RouteEnd
    let data: RouteData
    var body: some View {
        Link(destination: deepLink("go", ["day": data.day, "stop": "end", "maps": end.maps_url, "state": data.day_state])) {
            HStack(spacing: 9) {
                Image(systemName: "house.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(Pal.paper)
                    .frame(width: 18, height: 18)
                    .background(Pal.ink)
                    .clipShape(RoundedRectangle(cornerRadius: 4.5))
                Text(readable(end.label)).font(.system(size: 13.5, weight: .medium)).foregroundColor(Pal.muted).lineLimit(1)
                Spacer(minLength: 6)
                if let back = clock12(data.schedule?.finish_clock) {
                    Text("back \(back)").font(.system(size: 12.5)).monospacedDigit().foregroundColor(Pal.muted)
                }
            }
            .frame(minHeight: 26)
        }
    }
}

struct RouteView: View {
    let entry: RouteEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        if let data = entry.data {
            content(data)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Route").font(.system(size: 13, weight: .semibold)).foregroundColor(Pal.ink)
                Spacer()
                Button(intent: RefreshIntent()) {
                    Text("Route unavailable").font(.system(size: 14, weight: .medium)).foregroundColor(Pal.muted)
                }.buttonStyle(.plain)
                Spacer()
            }
        }
    }

    var large: Bool { family == .systemLarge }
    func rows(_ data: RouteData) -> [Stop] { data.stops.filter { !$0.done } }

    func content(_ data: RouteData) -> some View {
        let rows = rows(data)
        let miles = rows.dropFirst().reduce(0.0) { $0 + ($1.straight_line_miles_from_prev ?? 0) }
        let later = Array(rows.dropFirst().prefix(large ? 3 : 0))
        return VStack(alignment: .leading, spacing: 0) {
            header(data, rows: rows.count, miles: miles)
            if rows.isEmpty, let end = data.end, data.day_state == "ready_to_end" || data.day_state == "in_progress" {
                Spacer().frame(height: large ? 12 : 8)
                NextEnd(end: end, data: data, compact: !large)
                Spacer(minLength: 0)
            } else if rows.isEmpty {
                Spacer()
                emptyState(data)
                Spacer()
            } else {
                Spacer().frame(height: large ? 12 : 8)
                NextStop(stop: rows[0], data: data, compact: !large)
                if large {
                    if !later.isEmpty || data.end != nil {
                        Rectangle().fill(Pal.rule).frame(height: 1).padding(.top, 14).padding(.bottom, 6)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(later) { s in LaterRow(stop: s, data: data) }
                        if rows.count - 1 > later.count {
                            Text("\(rows.count - 1 - later.count) more after these")
                                .font(.system(size: 12)).foregroundColor(Pal.faint).padding(.leading, 27)
                        }
                        if let end = data.end { EndRow(end: end, data: data) }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// The day, what is left, and the update control with the time of the copy shown.
    func header(_ data: RouteData, rows: Int, miles: Double) -> some View {
        HStack(alignment: .center, spacing: 6) {
            Text(data.heading ?? "Today").font(.system(size: 13, weight: .semibold)).foregroundColor(Pal.ink)
            if rows > 0 {
                Text("\(rows) left" + (miles >= 1 ? " · \(Int(miles.rounded())) mi" : ""))
                    .font(.system(size: 12)).monospacedDigit().foregroundColor(Pal.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
            refresh(data)
        }
    }

    func refresh(_ data: RouteData?) -> some View {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let at = data.flatMap { f.date(from: $0.generated_at) } ?? entry.date
        return Button(intent: RefreshIntent()) {
            HStack(spacing: 4) {
                Text(at.formatted(date: .omitted, time: .shortened)).font(.system(size: 11.5)).monospacedDigit()
                Image(systemName: "arrow.clockwise").font(.system(size: 10.5, weight: .semibold))
            }
            .foregroundColor(Pal.ink)
            .padding(.horizontal, 9).frame(minHeight: 26)
            .background(Pal.control)
            .clipShape(Capsule())
        }.buttonStyle(.plain)
    }

    @ViewBuilder func emptyState(_ data: RouteData) -> some View {
        if data.day_state == "ready_to_end" {
            Link(destination: deepLink("odo", ["kind": "end", "day": data.day])) {
                Text("End odometer")
                    .font(.system(size: 15, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(Pal.green)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        } else {
            let worked = data.count > 0 || (data.visited_count ?? 0) > 0
            Text(worked ? "Done for the day" : "No stops")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(worked ? Pal.green : Pal.ink)
                .frame(maxWidth: .infinity)
        }
    }
}

struct FieldRouteWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FieldRouteWidget", provider: Provider()) { entry in
            RouteView(entry: entry)
                .containerBackground(Pal.paper, for: .widget)
        }
        .configurationDisplayName("Field Route")
        .description("The next stop and the rest of the day.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

// MARK: SDR calls widget

struct SdrEntry: TimelineEntry {
    let date: Date
    let data: SdrData?
}

struct SdrProvider: TimelineProvider {
    func placeholder(in context: Context) -> SdrEntry { SdrEntry(date: Date(), data: nil) }
    func getSnapshot(in context: Context, completion: @escaping (SdrEntry) -> Void) {
        Task { completion(SdrEntry(date: Date(), data: await SdrAPI.fetch())) }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SdrEntry>) -> Void) {
        Task {
            let entry = SdrEntry(date: Date(), data: await SdrAPI.fetch())
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }
}

/// Dial through the app, so the result sheet is waiting when the call ends.
func sdrCallURL(_ c: SdrCall) -> URL {
    var items = ["id": c.id, "name": c.name]
    if let a = c.account_id { items["account"] = a }
    if let t = c.tel_url { items["tel"] = t.replacingOccurrences(of: "tel:", with: "") }
    return deepLink("sdrcall", items)
}
func sdrLogURL(_ c: SdrCall) -> URL {
    deepLink("sdrlog", ["id": c.id, "name": c.name])
}

/// Five segments, one per call of the day's target.
struct SdrProgress: View {
    let done: Int
    let target: Int
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<max(target, 1), id: \.self) { i in
                Capsule().fill(i < done ? Pal.green : Pal.control).frame(height: 5)
            }
        }
    }
}

struct SdrRow: View {
    let call: SdrCall
    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Link(destination: sdrLogURL(call)) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        if call.priority == "high" {
                            Circle().fill(Pal.amber).frame(width: 6, height: 6)
                        }
                        Text(readable(call.name)).font(.system(size: 14, weight: .semibold)).foregroundColor(Pal.ink).lineLimit(1)
                    }
                    if let line = call.reason ?? call.buying {
                        Text(line).font(.system(size: 12)).foregroundColor(Pal.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
            }
            if call.tel_url != nil {
                Link(destination: sdrCallURL(call)) {
                    Image(systemName: "phone.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 40, height: 32)
                        .background(Pal.green)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
            }
        }
    }
}

struct SdrView: View {
    let entry: SdrEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        if let data = entry.data {
            switch family {
            case .accessoryRectangular: lock(data)
            case .systemSmall: small(data)
            default: list(data)
            }
        } else {
            Button(intent: RefreshIntent()) {
                Text("Calls unavailable").font(.system(size: 14, weight: .medium)).foregroundColor(Pal.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }.buttonStyle(.plain)
        }
    }

    func count(_ d: SdrData) -> String { "\(min(d.done, d.target)) of \(d.target)" }
    var finished: (SdrData) -> Bool { { $0.done >= $0.target || $0.calls.isEmpty } }

    func header(_ d: SdrData) -> some View {
        HStack(spacing: 6) {
            Text(d.heading == nil || d.heading == "Today" ? "Calls" : "Calls · \(d.heading!)")
                .font(.system(size: 13, weight: .semibold)).foregroundColor(Pal.ink).lineLimit(1)
            Spacer(minLength: 4)
            Button(intent: RefreshIntent()) {
                HStack(spacing: 4) {
                    Text(count(d)).font(.system(size: 12, weight: .semibold)).monospacedDigit()
                    Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .semibold))
                }
                .foregroundColor(Pal.ink)
                .padding(.horizontal, 9).frame(minHeight: 24)
                .background(Pal.control)
                .clipShape(Capsule())
            }.buttonStyle(.plain)
        }
    }

    @ViewBuilder func doneState(_ d: SdrData) -> some View {
        VStack(spacing: 3) {
            Text(d.done > 0 ? "Calls done" : "No calls").font(.system(size: 16, weight: .semibold))
                .foregroundColor(d.done > 0 ? Pal.green : Pal.ink)
            if let r = d.reached_week, r > 0 {
                Text("\(r) reached this week").font(.system(size: 12)).monospacedDigit().foregroundColor(Pal.muted)
            }
        }.frame(maxWidth: .infinity)
    }

    func small(_ d: SdrData) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(count(d)).font(.system(size: 22, weight: .semibold)).monospacedDigit().foregroundColor(Pal.ink)
                Spacer()
            }
            SdrProgress(done: d.done, target: d.target)
            Spacer(minLength: 0)
            if let c = d.calls.first, !finished(d) {
                Text(readable(c.name)).font(.system(size: 14, weight: .semibold)).foregroundColor(Pal.ink).lineLimit(2)
                if let line = c.reason ?? c.buying {
                    Text(line).font(.system(size: 11.5)).foregroundColor(Pal.muted).lineLimit(1)
                }
            } else {
                doneState(d)
            }
        }
        .widgetURL(d.calls.first.map(sdrCallURL))
    }

    func list(_ d: SdrData) -> some View {
        let large = family == .systemLarge
        let rows = Array(d.calls.prefix(large ? 5 : 3))
        return VStack(alignment: .leading, spacing: 0) {
            header(d)
            SdrProgress(done: d.done, target: d.target).padding(.top, 7)
            if finished(d) && rows.isEmpty {
                Spacer()
                doneState(d)
                Spacer()
            } else {
                VStack(alignment: .leading, spacing: large ? 10 : 6) {
                    ForEach(rows) { SdrRow(call: $0) }
                }.padding(.top, large ? 12 : 8)
                Spacer(minLength: 0)
                if large {
                    HStack {
                        if let r = d.reached_week {
                            Text("\(r) reached this week").font(.system(size: 12)).monospacedDigit().foregroundColor(Pal.muted)
                        }
                        Spacer()
                        if d.remaining > rows.count {
                            Text("\(d.remaining - rows.count) more queued").font(.system(size: 12)).monospacedDigit().foregroundColor(Pal.faint)
                        }
                    }
                }
            }
        }
    }

    func lock(_ d: SdrData) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(count(d)) calls").font(.system(size: 14, weight: .semibold)).monospacedDigit()
            if let c = d.calls.first, !finished(d) {
                Text(readable(c.name)).font(.system(size: 13)).lineLimit(1)
            }
        }
        .widgetURL(d.calls.first.map(sdrCallURL))
    }
}

struct SdrCallsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SdrCallsWidget", provider: SdrProvider()) { entry in
            SdrView(entry: entry)
                .containerBackground(Pal.paper, for: .widget)
        }
        .configurationDisplayName("SDR Calls")
        .description("The day's calls.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

@main
struct FieldRouteBundle: WidgetBundle {
    var body: some Widget {
        FieldRouteWidget()
        SdrCallsWidget()
    }
}
