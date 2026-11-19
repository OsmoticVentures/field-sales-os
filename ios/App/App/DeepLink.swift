import UIKit
import Capacitor
import WidgetKit

/// fieldsalesos:// links from the home-screen widget.
///   go?day=D&stop=ID&maps=U&state=S  the route view on that stop, then Maps to it;
///                        a day not started asks for the start odometer first
///   sdr?account=ID&call=C&to=notes  the SDR page with that client (or that
///                        queued call) loaded; to=notes lands on the call notes
///   call?account=ID&tel=N  the SDR page loaded for that client, then the dialer
///                        (no tel: red alert, nothing dials)
///   sdrcall?id=ID&name=N&account=A&tel=T  the SDR page on that client, then the
///                        dialer; the result sheet waits for the return
///   sdrlog?id=ID&name=N  the result sheet for that call, now
///   route?day=D&stop=ID  the route view on that day, scrolled to the stop
///   account?id=ID        the account sheet
///   odo?kind=start|end   odometer prompt (photo stays on the phone), then
///                        &go=ID opens Maps, &done=ID marks that stop done
///
/// A tap is never handled on arrival. It is parked and consumed once the
/// scene is foreground-active and the bridge is on screen, whichever of
/// cold launch, warm open or return from background got it here. A newer
/// tap replaces an older one; a parked tap older than a minute is dropped.
@MainActor
enum DeepLink {
    static let web = "https://osmoticventures.com/nb"

    private static var pending: (url: URL, at: Date)?
    private static weak var window: UIWindow?
    private static var polling = false

    static func receive(_ url: URL, from w: UIWindow?) {
        guard url.scheme == "fieldsalesos" else { return }
        pending = (url, Date())
        if let w { window = w }
        drain()
    }

    /// Runs on every tap, on every didBecomeActive, and on a short poll while
    /// a tap waits for the app to be ready.
    static func drain() {
        guard let p = pending else { SdrResult.resumeIfDue(window); return }
        if Date().timeIntervalSince(p.at) > 60 { pending = nil; return }
        guard let w = window, w.windowScene?.activationState == .foregroundActive,
              let vc = w.rootViewController as? CAPBridgeViewController,
              vc.isViewLoaded, vc.view.window != nil, let webView = vc.webView,
              vc.presentedViewController?.isBeingPresented != true,
              vc.presentedViewController?.isBeingDismissed != true else {
            poll()
            return
        }
        pending = nil
        // An alert or camera left up by an earlier tap would swallow this one.
        if let top = vc.presentedViewController {
            CameraCapture.shared.reset()
            top.dismiss(animated: false) { handle(p.url, vc: vc, webView: webView) }
        } else {
            handle(p.url, vc: vc, webView: webView)
        }
    }

    private static func poll() {
        guard !polling else { return }
        polling = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { polling = false; drain() }
    }

    private static func handle(_ url: URL, vc: CAPBridgeViewController, webView: WKWebView) {
        let q = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).compactMap { i in i.value.map { (i.name, $0) } }, uniquingKeysWith: { a, _ in a })
        switch url.host {
        case "go":
            let day = q["day"] ?? "", stop = q["stop"] ?? ""
            load(webView, "/route?day=\(day)&stop=\(stop)")
            let maps = q["maps"].flatMap(mapsURL)
            if q["state"] == "not_started", !day.isEmpty, OdoLog.started != day {
                odometer(kind: "start", day: day, go: stop, maps: maps, done: nil, vc: vc)
            } else if let maps {
                openMaps(maps, vc: vc)
            } else {
                Task { await resolveAndOpen(day: day, stop: stop, vc: vc) }
            }
        case "sdr":
            var c = URLComponents()
            c.queryItems = ["account", "call", "to"].compactMap { k in q[k].map { URLQueryItem(name: k, value: $0) } }
            if !(c.queryItems ?? []).isEmpty, let query = c.percentEncodedQuery { load(webView, "/prospect?\(query)") }
        case "call":
            if let id = q["account"] { load(webView, "/prospect?account=\(id)") }
            guard let tel = q["tel"], !tel.isEmpty, let dial = URL(string: "tel:\(tel)") else {
                alert(vc, "No phone number", "This account has no phone on file.")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { UIApplication.shared.open(dial) }
        case "sdrcall":
            if let id = q["account"] { load(webView, "/prospect?account=\(id)") }
            guard let call = q["id"], let tel = q["tel"], !tel.isEmpty, let dial = URL(string: "tel:\(tel)") else {
                alert(vc, "No phone number", "This account has no phone on file.")
                return
            }
            SdrResult.armed(call, name: q["name"] ?? "")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { UIApplication.shared.open(dial) }
        case "sdrlog":
            if let call = q["id"] { SdrResult.ask(call, name: q["name"] ?? "", vc: vc) }
        case "route":
            load(webView, "/route?day=\(q["day"] ?? "")&stop=\(q["stop"] ?? "")")
        case "account":
            if let id = q["id"] { load(webView, "/account/\(id)") }
        case "odo":
            odometer(kind: q["kind"] ?? "start", day: q["day"] ?? "", go: q["go"], maps: nil, done: q["done"], vc: vc)
        default: break
        }
    }

    static func load(_ webView: WKWebView, _ path: String) {
        if let u = URL(string: web + path) { webView.load(URLRequest(url: u)) }
    }

    static func mapsURL(_ s: String) -> URL? {
        URL(string: s.replacingOccurrences(of: "https://maps.apple.com/", with: "maps://"))
    }

    static func alert(_ vc: UIViewController, _ title: String, _ message: String?) {
        let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .destructive))
        (vc.presentedViewController ?? vc).present(a, animated: true)
    }

    /// Maps opens only from an active app; one retry covers the activation
    /// edge, then it says so in place.
    static func openMaps(_ u: URL, vc: UIViewController, retry: Bool = true) {
        UIApplication.shared.open(u) { ok in
            if ok { return }
            if retry { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { openMaps(u, vc: vc, retry: false) } }
            else { alert(vc, "Maps did not open", "Tap Go again.") }
        }
    }

    /// Links from an older widget carry only the stop id.
    static func resolveAndOpen(day: String, stop: String, vc: UIViewController) async {
        let data = await RouteAPI.fetch()
        await MainActor.run {
            let maps = stop == "end" ? data?.end?.maps_url : data?.stops.first(where: { $0.id == stop })?.maps_url
            if let u = maps.flatMap(mapsURL) { openMaps(u, vc: vc) }
            else if data == nil { alert(vc, "Route unavailable", "No connection. Tap Go again.") }
            else { alert(vc, "Stop not on the route", nil) }
        }
    }

    static func odometer(kind: String, day: String, go: String?, maps: URL?, done: String?, vc: UIViewController) {
        let alert = UIAlertController(title: kind == "end" ? "End odometer" : "Start odometer", message: nil, preferredStyle: .alert)
        let finish: () -> Void = { Task { await complete(kind: kind, day: day, go: go, maps: maps, done: done, vc: vc) } }
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            alert.addAction(UIAlertAction(title: "Take photo", style: .default) { _ in
                CameraCapture.shared.present(from: vc, onDone: finish)
            })
        }
        alert.addAction(UIAlertAction(title: "Bypass", style: .default) { _ in finish() })
        (vc.presentedViewController ?? vc).present(alert, animated: true)
    }

    /// Maps first, from the link itself, so a slow network never holds up the
    /// drive. The server writes follow and are kept until they land.
    static func complete(kind: String, day: String, go: String?, maps: URL?, done: String?, vc: UIViewController) async {
        if kind == "start", !day.isEmpty { OdoLog.started = day }
        if let maps { openMaps(maps, vc: vc) }
        else if let go, !day.isEmpty { await resolveAndOpen(day: day, stop: go, vc: vc) }
        if let done, !day.isEmpty { await Outbox.send(["action": "done", "day": day, "id": done]) }
        if !day.isEmpty { await Outbox.send(["action": "odo", "kind": kind, "day": day]) }
        WidgetCenter.shared.reloadAllTimelines()
    }
}

/// The call result sheet. A call dialed from the widget arms it; once the app
/// has gone to the background (the call) and comes back, the sheet asks how
/// it went. One tap files the result, then the next call is offered.
@MainActor
enum SdrResult {
    private static let key = "sdrPendingCall"
    private static var wentAway = false

    static func armed(_ id: String, name: String) {
        UserDefaults.standard.set(["id": id, "name": name, "at": String(Date().timeIntervalSince1970)], forKey: key)
        wentAway = false
    }

    static func backgrounded() {
        if UserDefaults.standard.dictionary(forKey: key) != nil { wentAway = true }
    }

    static func resumeIfDue(_ window: UIWindow?) {
        guard wentAway, let d = UserDefaults.standard.dictionary(forKey: key) as? [String: String],
              let id = d["id"], let at = Double(d["at"] ?? "") else { return }
        if Date().timeIntervalSince1970 - at > 3 * 3600 { UserDefaults.standard.removeObject(forKey: key); return }
        guard let vc = window?.rootViewController, vc.presentedViewController == nil else { return }
        wentAway = false
        UserDefaults.standard.removeObject(forKey: key)
        ask(id, name: d["name"] ?? "", vc: vc)
    }

    static func ask(_ id: String, name: String, vc: UIViewController) {
        let sheet = UIAlertController(title: readableName(name), message: nil, preferredStyle: .actionSheet)
        for r in SdrAPI.results {
            sheet.addAction(UIAlertAction(title: r.label, style: .default) { _ in
                Task { await file(id, result: r.key, vc: vc) }
            })
        }
        sheet.addAction(UIAlertAction(title: "Not now", style: .cancel))
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = vc.view
            pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY, width: 0, height: 0)
        }
        (vc.presentedViewController ?? vc).present(sheet, animated: true)
    }

    private static func file(_ id: String, result: String, vc: UIViewController) async {
        await Outbox.send(["action": "call_result", "id": id, "result": result])
        WidgetCenter.shared.reloadAllTimelines()
        guard let data = await SdrAPI.fetch() else { return }
        let next = data.calls.first { $0.id != id }
        let title = "\(min(data.done, data.target)) of \(data.target) calls"
        let a = UIAlertController(title: title, message: next.map { "Next: \(readableName($0.name))" }, preferredStyle: .alert)
        if let next, next.tel_url != nil {
            a.addAction(UIAlertAction(title: "Call", style: .default) { _ in
                var c = URLComponents()
                c.scheme = "fieldsalesos"; c.host = "sdrcall"
                c.queryItems = [URLQueryItem(name: "id", value: next.id), URLQueryItem(name: "name", value: next.name),
                                URLQueryItem(name: "tel", value: (next.tel_url ?? "").replacingOccurrences(of: "tel:", with: ""))]
                    + (next.account_id.map { [URLQueryItem(name: "account", value: $0)] } ?? [])
                if let u = c.url { DeepLink.receive(u, from: vc.view.window) }
            })
            a.addAction(UIAlertAction(title: "Later", style: .cancel))
            (vc.presentedViewController ?? vc).present(a, animated: true)
        } else {
            (vc.presentedViewController ?? vc).present(a, animated: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { a.dismiss(animated: true) }
        }
    }

    /// Names in capitals read in normal case.
    static func readableName(_ s: String) -> String {
        let letters = s.filter { $0.isLetter }
        guard !letters.isEmpty, letters == letters.uppercased() else { return s }
        return s.capitalized
    }
}

/// The last day whose start odometer was taken here, so a widget face that
/// has not refreshed yet never asks for it twice.
enum OdoLog {
    static var started: String? {
        get { UserDefaults.standard.string(forKey: "odoStartedDay") }
        set { UserDefaults.standard.set(newValue, forKey: "odoStartedDay") }
    }
}

/// Route writes that failed for want of signal, retried on every return to
/// the app. Bounded to the last 20.
enum Outbox {
    private static let key = "routeOutbox"

    static func send(_ body: [String: String]) async {
        if await RouteAPI.post(body) { return }
        var q = (UserDefaults.standard.array(forKey: key) as? [[String: String]]) ?? []
        q.append(body)
        UserDefaults.standard.set(Array(q.suffix(20)), forKey: key)
    }

    static func flush() async {
        let q = (UserDefaults.standard.array(forKey: key) as? [[String: String]]) ?? []
        guard !q.isEmpty else { return }
        UserDefaults.standard.removeObject(forKey: key)
        var sent = false
        for body in q {
            if await RouteAPI.post(body) { sent = true } else {
                var rest = (UserDefaults.standard.array(forKey: key) as? [[String: String]]) ?? []
                rest.append(body)
                UserDefaults.standard.set(Array(rest.suffix(20)), forKey: key)
            }
        }
        if sent { WidgetCenter.shared.reloadAllTimelines() }
    }
}

/// The camera. The photo goes to the camera roll and nowhere else; it is
/// filed by hand in Expensos.
final class CameraCapture: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    static let shared = CameraCapture()
    private var onDone: (() -> Void)?

    func reset() { onDone = nil }

    func present(from vc: UIViewController, onDone: @escaping () -> Void) {
        self.onDone = onDone
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.delegate = self
        (vc.presentedViewController ?? vc).present(p, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        if let img = info[.originalImage] as? UIImage { UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil) }
        picker.dismiss(animated: true) { self.onDone?(); self.onDone = nil }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) { self.onDone?(); self.onDone = nil }
    }
}
