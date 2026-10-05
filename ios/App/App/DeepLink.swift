import UIKit
import Capacitor
import WidgetKit

/// fieldsalesos:// links from the home-screen widget.
///   go?day=D&stop=ID&maps=U&state=S  the route view on that stop, then Maps to it;
///                        a day not started asks for the start odometer first
///   sdr?account=ID       the SDR page with that client loaded
///   call?account=ID&tel=N  the SDR page loaded for that client, then the dialer
///                        (no tel: red alert, nothing dials)
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
        guard let p = pending else { return }
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
            if let id = q["account"] { load(webView, "/prospect?account=\(id)") }
        case "call":
            if let id = q["account"] { load(webView, "/prospect?account=\(id)") }
            guard let tel = q["tel"], !tel.isEmpty, let dial = URL(string: "tel:\(tel)") else {
                alert(vc, "No phone number", "This account has no phone on file.")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { UIApplication.shared.open(dial) }
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
            if let u = data?.stops.first(where: { $0.id == stop })?.mapsURL { openMaps(u, vc: vc) }
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
