import UIKit
import WebKit
import BackgroundTasks
import os

/// THE PHONE NEVER LOSES A NOTE (2026-11-23). The page's outbox keeps every
/// note in the web view's own store, which iOS may clear and which only runs
/// while the app is open. So each unsent note is also handed here the moment
/// it is saved (src/lib/core/native-outbox.ts, message "noteOutbox"), and kept
/// in a file in Application Support, which survives the app being killed and
/// the web view's data being cleared.
///
/// This copy sends itself: the moment the app leaves the screen (iOS gives a
/// few seconds), and again on a background refresh while any note is unsent.
/// It sends to the same door with the same idempotency key as the page, so
/// whichever gets there first files it and the other is answered the same
/// row. The widget's bearer (Secrets.widgetToken) is its pass; the door only
/// lets it put a note in the server's inbox, as Juan.
///
/// A note leaves this file when the server has it, when the page says it is
/// done (sent, discarded, taken back), or after 14 days. At most 200.
enum NoteOutbox {
    static let task = "com.osmoticventures.fieldsalesos.notes"
    private static let log = Logger(subsystem: "com.osmoticventures.fieldsalesos", category: "notes")
    private static let maxAge: TimeInterval = 14 * 86_400
    private static let maxCount = 200
    private static let queue = DispatchQueue(label: "note-outbox")

    struct Note: Codable {
        let key: String
        let rep: String?
        let json: Data
        let queuedAt: Date
    }

    private static var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("note-outbox.json")
    }

    private static func read() -> [Note] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([Note].self, from: data)) ?? []
    }

    private static func write(_ notes: [Note]) {
        let keep = notes.filter { Date().timeIntervalSince($0.queuedAt) < maxAge }.suffix(maxCount)
        guard let data = try? JSONEncoder().encode(Array(keep)) else { return }
        // Readable after the first unlock, so a background refresh with the
        // phone locked can still send.
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// From the page: {notes: [{key, rep, json}], done: [key]}.
    static func receive(_ body: Any) {
        guard let msg = body as? [String: Any] else { return }
        queue.sync {
            var notes = read()
            let done = Set((msg["done"] as? [String]) ?? [])
            notes.removeAll { done.contains($0.key) }
            for n in (msg["notes"] as? [[String: Any]]) ?? [] {
                guard let key = n["key"] as? String, let json = n["json"],
                      let data = try? JSONSerialization.data(withJSONObject: json) else { continue }
                if notes.contains(where: { $0.key == key }) { continue }
                notes.append(Note(key: key, rep: n["rep"] as? String, json: data, queuedAt: Date()))
            }
            write(notes)
        }
    }

    static var pending: Int { queue.sync { read().count } }

    /// Send every note once. A note the server took, or refused for good,
    /// leaves the file; one that met no signal waits for the next try.
    @discardableResult
    static func flush() async -> Int {
        let notes = queue.sync { read() }
        guard !notes.isEmpty else { return 0 }
        var gone = Set<String>()
        for n in notes {
            var r = URLRequest(url: URL(string: Secrets.base + "/api/visit/touchpoint")!)
            r.httpMethod = "POST"
            r.timeoutInterval = 20
            r.setValue("Bearer " + Secrets.widgetToken, forHTTPHeaderField: "Authorization")
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.setValue(n.key, forHTTPHeaderField: "Idempotency-Key")
            if let rep = n.rep { r.setValue(rep, forHTTPHeaderField: "x-nb-as") }
            r.httpBody = n.json
            guard let (data, resp) = try? await URLSession.shared.data(for: r),
                  let status = (resp as? HTTPURLResponse)?.statusCode else { continue }
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let accepted = ((obj?["result"] as? [String: Any])?["accepted"] as? Bool) == true
            if status == 200 && accepted {
                gone.insert(n.key)
            } else if status == 400 || status == 422 {
                // The door said no for good (a test note, an empty one); the
                // page keeps it in red where he can see it.
                gone.insert(n.key)
            }
            log.notice("note \(n.key, privacy: .public) -> \(status, privacy: .public)")
        }
        let left: Int = queue.sync {
            var now = read()
            now.removeAll { gone.contains($0.key) }
            write(now)
            return now.count
        }
        return left
    }

    // MARK: background

    /// Called once from didFinishLaunching, before it returns.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: task, using: nil) { t in
            guard let t = t as? BGAppRefreshTask else { return }
            schedule()
            let work = Task {
                let left = await flush()
                t.setTaskCompleted(success: left == 0)
            }
            t.expirationHandler = { work.cancel() }
        }
    }

    /// Ask iOS for a refresh while anything is unsent. iOS decides when.
    static func schedule() {
        guard pending > 0 else { return }
        let req = BGAppRefreshTaskRequest(identifier: task)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    /// The app just left the screen: send now, inside the time iOS allows.
    static func sendOnLeaving() {
        guard pending > 0 else { return }
        var id: UIBackgroundTaskIdentifier = .invalid
        id = UIApplication.shared.beginBackgroundTask(withName: "notes") {
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
        Task {
            await flush()
            schedule()
            if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
        }
    }
}

/// The page's hand-off: window.webkit.messageHandlers.noteOutbox.postMessage(...)
final class NoteOutboxHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the app's own pages may hand a note over.
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.host == "osmoticventures.com" else { return }
        NoteOutbox.receive(message.body)
    }
}
