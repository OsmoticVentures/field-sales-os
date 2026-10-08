import UIKit
import Capacitor

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
final class BridgeViewController: CAPBridgeViewController {
    override func instanceDescriptor() -> InstanceDescriptor {
        let d = super.instanceDescriptor()
        if ProcessInfo.processInfo.isiOSAppOnMac { d.serverURL = DeepLink.web + "/route" }
        return d
    }
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
