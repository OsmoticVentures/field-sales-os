import UIKit
import Capacitor
import WebKit

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
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// On the Mac the app opens on the map (the Route screen); the phone keeps Visit.
/// The server URL stays /nb, which is what keeps every other screen in the app
/// instead of handing it to the browser, so Route is loaded over the first page.
final class BridgeViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        guard ProcessInfo.processInfo.isiOSAppOnMac, let webView else { return }
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: Self.largerText, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        DeepLink.load(webView, "/route")
    }

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
