import UIKit
import Capacitor
import WebKit
import CoreLocation
import os

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = BridgeViewController()
        window?.makeKeyAndVisible()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MacWindow.fit(windowScene) }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        if let url = connectionOptions.urlContexts.first?.url { DeepLink.receive(url, from: window) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url, url.scheme == "fieldsalesos" { DeepLink.receive(url, from: window); return }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        DeepLink.drain()
        Task { await Outbox.flush() }
        LocationAlways.ask()
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// On the Mac the app opens on the map (the Route screen); the phone keeps Visit.
/// The server URL stays /nb, which is what keeps every other screen in the app
/// instead of handing it to the browser, so Route is loaded over the first page.
final class BridgeViewController: CAPBridgeViewController, UIGestureRecognizerDelegate {
    private static let log = Logger(subsystem: "com.osmoticventures.fieldsalesos", category: "pinch")
    override func viewDidLoad() {
        super.viewDidLoad()
        guard ProcessInfo.processInfo.isiOSAppOnMac, let webView else { return }
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: Self.largerText, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView.pageZoom = Self.savedZoom
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(trackpadPinch(_:)))
        pinch.cancelsTouchesInView = false
        pinch.delegate = self
        webView.addGestureRecognizer(pinch)
        Self.log.notice("pinch recognizer installed")
        DeepLink.load(webView, "/route")
    }

    /// A trackpad pinch on the Mac never reaches the page as a gesture, so it
    /// is handed over as "nativepinch" and a map under the fingers zooms
    /// (src/lib/shared/map-pinch.ts). Anywhere else the pinch zooms the whole
    /// app, the way Command plus and minus do, and the size is kept.
    private enum PinchMode { case asking, map, page }
    private var mode = PinchMode.asking
    private var zoomAtStart: CGFloat = 1

    @objc private func trackpadPinch(_ g: UIPinchGestureRecognizer) {
        guard let webView else { return }
        let state: String
        switch g.state {
        case .began: state = "began"
        case .changed: state = "changed"
        case .ended, .cancelled, .failed: state = "ended"
        default: return
        }
        if state == "began" {
            mode = .asking
            zoomAtStart = webView.pageZoom
        }
        if mode == .page {
            if state == "changed" { setZoom(zoomAtStart * g.scale) }
            if state == "ended" { Self.log.notice("pinch page zoom=\(webView.pageZoom, privacy: .public)") }
            return
        }
        // The page lays out in its own pixels, which a page zoom scales.
        let p = g.location(in: webView)
        let z = webView.pageZoom
        let js = (state == "began" ? "window.__pinchHit=false;" : "") + "window.dispatchEvent(new CustomEvent('nativepinch',{detail:{state:'\(state)',scale:\(g.scale),x:\(p.x / z),y:\(p.y / z)}}));window.__pinchHit===true"
        webView.evaluateJavaScript(js) { [weak self] hit, _ in
            guard let self, state == "began", self.mode == .asking else { return }
            let onMap = (hit as? Bool) == true
            self.mode = onMap ? .map : .page
            Self.log.notice("pinch began onMap=\(onMap, privacy: .public) at=\(p.x, privacy: .public),\(p.y, privacy: .public)")
            if !onMap, g.state == .changed { self.setZoom(self.zoomAtStart * g.scale) }
        }
    }

    private static let zoomKey = "mac.pageZoom"
    private static var savedZoom: CGFloat {
        let z = UserDefaults.standard.double(forKey: zoomKey)
        return z > 0 ? CGFloat(z) : 1
    }

    private func setZoom(_ z: CGFloat) {
        guard let webView else { return }
        let next = min(max(z, 0.5), 3)
        if abs(next - webView.pageZoom) < 0.005 { return }
        webView.pageZoom = next
        UserDefaults.standard.set(Double(next), forKey: Self.zoomKey)
    }

    override var keyCommands: [UIKeyCommand]? {
        guard ProcessInfo.processInfo.isiOSAppOnMac else { return super.keyCommands }
        return (super.keyCommands ?? []) + [
            UIKeyCommand(title: "Zoom In", action: #selector(zoomIn), input: "=", modifierFlags: .command),
            UIKeyCommand(title: "Zoom In", action: #selector(zoomIn), input: "+", modifierFlags: .command),
            UIKeyCommand(title: "Zoom Out", action: #selector(zoomOut), input: "-", modifierFlags: .command),
            UIKeyCommand(title: "Actual Size", action: #selector(zoomReset), input: "0", modifierFlags: .command),
        ]
    }
    @objc private func zoomIn() { setZoom((webView?.pageZoom ?? 1) * 1.1) }
    @objc private func zoomOut() { setZoom((webView?.pageZoom ?? 1) / 1.1) }
    @objc private func zoomReset() { setZoom(1) }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    /// Every font one point larger on the Mac: each px or rem font size in the
    /// page's stylesheets, Tailwind's --text-* sizes, and the body default.
    /// Spacing stays as it is. Stylesheets a later screen brings in get the
    /// same pass as they load.
    private static let largerText = """
    (function () {
      if (window.__largerText) return; window.__largerText = true;
      var done = new WeakSet();
      function bump(rules) {
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          if (r.cssRules) bump(r.cssRules);
          var s = r.style; if (!s) continue;
          var fs = s.getPropertyValue('font-size').trim();
          var m = /^([0-9.]+)(px|rem)$/.exec(fs);
          if (m) s.setProperty('font-size', m[2] === 'px' ? (parseFloat(m[1]) + 1) + 'px' : 'calc(' + fs + ' + 1px)', s.getPropertyPriority('font-size'));
          for (var j = 0; j < s.length; j++) {
            var p = s[j];
            if (/^--text-[a-z0-9]+$/.test(p)) {
              var v = s.getPropertyValue(p).trim();
              if (/^[0-9.]+(px|rem)$/.test(v)) s.setProperty(p, 'calc(' + v + ' + 1px)');
            }
          }
        }
      }
      function run() {
        for (var i = 0; i < document.styleSheets.length; i++) {
          var sh = document.styleSheets[i];
          if (done.has(sh)) continue;
          try { bump(sh.cssRules); done.add(sh); } catch (e) {}
        }
      }
      var base = document.createElement('style');
      base.textContent = 'body { font-size: 17px; }';
      document.head.prepend(base);
      done.add(base.sheet);
      run();
      document.addEventListener('load', function (e) { if (e.target.tagName === 'LINK') run(); }, true);
      new MutationObserver(run).observe(document.head, { childList: true });
      window.addEventListener('load', run);
    })();
    """
}

/// The Mac window opens large, centered, once per launch. A raised minimum
/// size forces the grow (a plain geometry request is ignored for an iPad app
/// on the Mac), then drops back so the window can still be resized.
@MainActor
enum MacWindow {
    private static var done = false

    static func fit(_ scene: UIWindowScene) {
        guard ProcessInfo.processInfo.isiOSAppOnMac, !done else { return }
        done = true
        let screen = scene.screen.bounds
        let size = CGSize(width: (screen.width * 0.9).rounded(), height: (screen.height * 0.88).rounded())
        scene.sizeRestrictions?.minimumSize = size
        let origin = CGPoint(x: ((screen.width - size.width) / 2).rounded(), y: ((screen.height - size.height) / 2).rounded())
        scene.requestGeometryUpdate(.Mac(systemFrame: CGRect(origin: origin, size: size)))
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            scene.sizeRestrictions?.minimumSize = CGSize(width: 900, height: 640)
        }
    }
}

/// Location is Always for this app, so arrival at a client and the day's miles
/// can be read without the app on screen. A first launch asks (iOS answers
/// While Using and holds Always provisionally); a phone already on While Using
/// gets iOS's one-time "Change to Always Allow" prompt. After that iOS allows
/// no second ask from the app, so nothing nags: the setting lives in
/// Settings > ClientOS > Location. The Mac has no Always, so it is skipped.
@MainActor
final class LocationAlways: NSObject, CLLocationManagerDelegate {
    private static let shared = LocationAlways()
    private static let upgradeAsked = "location.alwaysUpgradeAsked"
    private let manager = CLLocationManager()

    private override init() {
        super.init()
        manager.delegate = self
    }

    static func ask() {
        guard !ProcessInfo.processInfo.isiOSAppOnMac else { return }
        shared.askIfNeeded()
    }

    private func askIfNeeded() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestAlwaysAuthorization()
        case .authorizedWhenInUse where !UserDefaults.standard.bool(forKey: Self.upgradeAsked):
            UserDefaults.standard.set(true, forKey: Self.upgradeAsked)
            manager.requestAlwaysAuthorization()
        default:
            break
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.askIfNeeded() }
    }
}
