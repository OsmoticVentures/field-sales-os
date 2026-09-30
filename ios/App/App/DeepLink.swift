import UIKit
import Capacitor
import WidgetKit

/// fieldsalesos:// links from the home-screen widget.
///   sdr?account=ID       the SDR page with that client loaded
///   call?account=ID&tel=N  the SDR page loaded for that client, then the dialer
///                        (no tel: red alert, nothing dials)
///   account?id=ID        the account sheet
///   odo?kind=start|end   odometer prompt (photo stays on the phone), then
///                        &go=ID opens Maps, &done=ID marks that stop done
enum DeepLink {
    static let web = "https://osmoticventures.com/nb"

    static func handle(_ url: URL, from window: UIWindow?, attempt: Int = 0) {
        guard url.scheme == "fieldsalesos" else { return }
        guard let vc = window?.rootViewController as? CAPBridgeViewController, let webView = vc.webView else {
            if attempt < 20 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { handle(url, from: window, attempt: attempt + 1) } }
            return
        }
        let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).compactMap { i in i.value.map { (i.name, $0) } })
        switch url.host {
        case "sdr":
            if let id = q["account"] { load(webView, "/prospect?account=\(id)") }
        case "call":
            guard let id = q["account"] else { return }
            load(webView, "/prospect?account=\(id)")
            guard let tel = q["tel"], !tel.isEmpty, let dial = URL(string: "tel:\(tel)") else {
                let a = UIAlertController(title: "No phone number", message: "This account has no phone on file.", preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "OK", style: .destructive))
                (vc.presentedViewController ?? vc).present(a, animated: true)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { UIApplication.shared.open(dial) }
        case "account":
            if let id = q["id"] { load(webView, "/account/\(id)") }
        case "odo":
            odometer(kind: q["kind"] ?? "start", day: q["day"] ?? "", go: q["go"], done: q["done"], vc: vc)
        default: break
        }
    }

    static func load(_ webView: WKWebView, _ path: String) {
        if let u = URL(string: web + path) { webView.load(URLRequest(url: u)) }
    }

    static func odometer(kind: String, day: String, go: String?, done: String?, vc: UIViewController) {
        let alert = UIAlertController(title: kind == "end" ? "End odometer" : "Start odometer", message: nil, preferredStyle: .alert)
        let finish: () -> Void = { Task { await complete(kind: kind, day: day, go: go, done: done) } }
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            alert.addAction(UIAlertAction(title: "Take photo", style: .default) { _ in
                CameraCapture.shared.present(from: vc, onDone: finish)
            })
        }
        alert.addAction(UIAlertAction(title: "Bypass", style: .default) { _ in finish() })
        (vc.presentedViewController ?? vc).present(alert, animated: true)
    }

    static func complete(kind: String, day: String, go: String?, done: String?) async {
        if let done, !day.isEmpty { await RouteAPI.post(["action": "done", "day": day, "id": done]) }
        if !day.isEmpty { await RouteAPI.post(["action": "odo", "kind": kind, "day": day]) }
        WidgetCenter.shared.reloadAllTimelines()
        if let go, !day.isEmpty, let data = await RouteAPI.fetch(), let stop = data.stops.first(where: { $0.id == go }), let u = stop.mapsURL {
            await MainActor.run { UIApplication.shared.open(u) }
        }
    }
}

/// The camera. The photo goes to the camera roll and nowhere else; it is
/// filed by hand in Expensos.
final class CameraCapture: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    static let shared = CameraCapture()
    private var onDone: (() -> Void)?

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
