import AppKit
import Foundation

// MARK: - Server process management

final class ServerManager {
    static let shared = ServerManager()

    private var process: Process?
    private let projectDir = "/Users/andre/ContextHub/paperclip"
    private let serverPort = 3101
    private let uiPort = 3102

    var isRunning: Bool {
        guard let proc = process else { return isPortOpen(serverPort) }
        return proc.isRunning
    }

    func start(onOutput: @escaping (String) -> Void) {
        guard !isRunning else { return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-l", "-c", "cd '\(projectDir)' && pnpm run dev 2>&1"]
        proc.currentDirectoryURL = URL(fileURLWithPath: projectDir)

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if let str = String(data: data, encoding: .utf8), !str.isEmpty {
                DispatchQueue.main.async { onOutput(str) }
            }
        }

        proc.terminationHandler = { _ in
            DispatchQueue.main.async { onOutput("[server stopped]\n") }
        }

        try? proc.run()
        process = proc
    }

    func stop() {
        process?.interrupt()
        process = nil
    }

    func openUI() {
        let url = URL(string: "http://127.0.0.1:\(uiPort)")!
        NSWorkspace.shared.open(url)
    }

    private func isPortOpen(_ port: Int) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", "lsof -i :\(port) -sTCP:LISTEN -t"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        try? task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - Status bar controller

final class StatusBarController: NSObject {
    private var statusItem: NSStatusItem!
    private var menu: NSMenu!
    private var logWindow: NSWindow?
    private var logTextView: NSTextView?
    private var statusMenuItem: NSMenuItem!
    private var toggleMenuItem: NSMenuItem!
    private var timer: Timer?

    override init() {
        super.init()
        setupStatusItem()
        setupMenu()
        startPolling()
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateIcon()
    }

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        let running = ServerManager.shared.isRunning
        // Use paperclip symbol — SF Symbols "paperclip" available macOS 11+
        let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
        if let img = NSImage(systemSymbolName: "paperclip", accessibilityDescription: "Paperclip") {
            let configured = img.withSymbolConfiguration(config) ?? img
            configured.isTemplate = true
            button.image = configured
        } else {
            button.title = running ? "📎" : "📎"
        }
        button.appearsDisabled = !running
    }

    private func setupMenu() {
        menu = NSMenu()

        statusMenuItem = NSMenuItem(title: "Stopped", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        menu.addItem(.separator())

        toggleMenuItem = NSMenuItem(title: "Start Paperclip", action: #selector(toggleServer), keyEquivalent: "s")
        toggleMenuItem.target = self
        menu.addItem(toggleMenuItem)

        let openItem = NSMenuItem(title: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        let logItem = NSMenuItem(title: "Show Logs", action: #selector(showLogs), keyEquivalent: "l")
        logItem.target = self
        menu.addItem(logItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
        refreshMenu()
    }

    private func refreshMenu() {
        let running = ServerManager.shared.isRunning
        statusMenuItem.title = running ? "Running on :3101" : "Stopped"
        statusMenuItem.image = {
            let name = running ? "circle.fill" : "circle"
            let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)
            img?.isTemplate = false
            return img
        }()
        toggleMenuItem.title = running ? "Stop Paperclip" : "Start Paperclip"
        updateIcon()
    }

    private func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.refreshMenu()
        }
    }

    @objc private func toggleServer() {
        if ServerManager.shared.isRunning {
            ServerManager.shared.stop()
            appendLog("[user] Stopped server.\n")
        } else {
            appendLog("[user] Starting server...\n")
            ServerManager.shared.start { [weak self] line in
                self?.appendLog(line)
            }
        }
        refreshMenu()
    }

    @objc private func openBrowser() {
        ServerManager.shared.openUI()
    }

    @objc private func showLogs() {
        if logWindow == nil { createLogWindow() }
        logWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func quit() {
        ServerManager.shared.stop()
        NSApp.terminate(nil)
    }

    private func appendLog(_ text: String) {
        guard let tv = logTextView else { return }
        let attributed = NSAttributedString(
            string: text,
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                .foregroundColor: NSColor.labelColor,
            ]
        )
        tv.textStorage?.append(attributed)
        tv.scrollToEndOfDocument(nil)
    }

    private func createLogWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 700, height: 400),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Paperclip — Server Logs"
        window.isReleasedWhenClosed = false

        let scrollView = NSScrollView(frame: window.contentView!.bounds)
        scrollView.autoresizingMask = [.width, .height]
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false

        let textView = NSTextView(frame: scrollView.bounds)
        textView.isEditable = false
        textView.isSelectable = true
        textView.autoresizingMask = [.width]
        textView.backgroundColor = NSColor(named: NSColor.Name("controlBackgroundColor")) ?? .black
        textView.textContainerInset = NSSize(width: 8, height: 8)

        scrollView.documentView = textView
        window.contentView?.addSubview(scrollView)

        logWindow = window
        logTextView = textView
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: StatusBarController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // no Dock icon
        controller = StatusBarController()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // keep running when log window is closed
    }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
