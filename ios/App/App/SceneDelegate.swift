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
        LocationAlways.becameActive()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        LocationAlways.resignedActive()
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
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(trackpadPinch(_:)))
        pinch.cancelsTouchesInView = false
        pinch.delegate = self
        webView.addGestureRecognizer(pinch)
        Self.log.notice("pinch recognizer installed")
        DeepLink.load(webView, "/route")
    }

    /// A trackpad pinch on the Mac never reaches the page as a gesture, so it
    /// is handed over as "nativepinch" and a map under the fingers zooms
    /// (src/lib/shared/map-pinch.ts). Nothing else in the app zooms.
    @objc private func trackpadPinch(_ g: UIPinchGestureRecognizer) {
        guard let webView else { return }
        let state: String
        switch g.state {
        case .began: state = "began"
        case .changed: state = "changed"
        case .ended, .cancelled, .failed: state = "ended"
        default: return
        }
        let p = g.location(in: webView)
        let send = "window.dispatchEvent(new CustomEvent('nativepinch',{detail:{state:'\(state)',scale:\(g.scale),x:\(p.x),y:\(p.y)}}))"
        guard state == "began" else { webView.evaluateJavaScript(send); return }
        webView.evaluateJavaScript("window.__pinchHit=false;\(send);window.__pinchHit===true") { hit, _ in
            Self.log.notice("pinch began onMap=\((hit as? Bool) == true, privacy: .public) at=\(p.x, privacy: .public),\(p.y, privacy: .public)")
        }
    }

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
/// can be read without the app on screen. The Mac has no Always, so it is skipped.
///
/// iOS only grants a real Always in two steps. Asking for Always first only
/// gives a provisional Always shown as While Using, and every later Always ask
/// is ignored, so the upgrade prompt never comes. The order that works:
/// 1. Not asked yet: ask for While Using.
/// 2. Now While Using, upgrade never asked: ask for Always. iOS shows
///    "Change to Always Allow" right away. This ask is spent once per install.
/// 3. Still not Always after that (kept While Using, or denied): one alert per
///    launch that opens Settings > ClientOS > Location.
@MainActor
final class LocationAlways: NSObject, CLLocationManagerDelegate {
    private static let shared = LocationAlways()
    private static let upgradeAsked = "location.alwaysUpgradeAsked"
    private let manager = CLLocationManager()

    /// The upgrade prompt is on screen or about to be; hold the Settings alert.
    private var upgradePending = false
    /// The app went inactive after the upgrade ask, so the prompt really showed.
    private var promptShown = false
    private var alertShownThisLaunch = false

    private override init() {
        super.init()
        manager.delegate = self
    }

    static func becameActive() {
        guard !ProcessInfo.processInfo.isiOSAppOnMac else { return }
        let s = shared
        if s.upgradePending && s.promptShown {
            s.upgradePending = false
            s.promptShown = false
        }
        s.step()
    }

    static func resignedActive() {
        guard !ProcessInfo.processInfo.isiOSAppOnMac else { return }
        if shared.upgradePending { shared.promptShown = true }
    }

    private func step() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .restricted:
            break
        case .authorizedWhenInUse where !UserDefaults.standard.bool(forKey: Self.upgradeAsked):
            UserDefaults.standard.set(true, forKey: Self.upgradeAsked)
            upgradePending = true
            promptShown = false
            manager.requestAlwaysAuthorization()
            // If iOS shows nothing, don't hold the Settings alert forever.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, self.upgradePending, !self.promptShown else { return }
                self.upgradePending = false
                self.step()
            }
        default:
            if !upgradePending { offerSettings() }
        }
    }

    private func offerSettings() {
        guard !alertShownThisLaunch,
              UIApplication.shared.applicationState == .active,
              let root = UIApplication.shared.connectedScenes
                .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
                .first?.rootViewController else { return }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        if top is UIAlertController { return }
        alertShownThisLaunch = true

        let alert = UIAlertController(
            title: "ClientOS needs Always location",
            message: "So it can log arrivals and miles with the app closed. In Settings, tap Location, then Always.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        })
        alert.preferredAction = alert.actions.last
        top.present(alert, animated: true)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            // A change means any pending upgrade prompt was answered.
            if self.upgradePending && manager.authorizationStatus != .authorizedWhenInUse {
                self.upgradePending = false
            }
            self.step()
        }
    }
}
