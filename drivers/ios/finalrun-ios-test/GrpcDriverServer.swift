// MARK: - GrpcDriverServer.swift
// gRPC server for the iOS driver using grpc-swift v2.x
// This replaces XCTestWSServer.swift with gRPC-based communication

import Foundation
import UIKit
import GRPCCore
import GRPCNIOTransportHTTP2
import XCTest
import os.log

private let serverLogger = OSLog(subsystem: "app.finalrun.driver", category: "GrpcServer")

// MARK: - AtomicFlag

/// Thread-safe atomic boolean flag using NSLock
/// Similar to Java's AtomicBoolean, used for cross-thread synchronization
final class AtomicFlag: @unchecked Sendable {
    private var _value: Bool
    private let lock = NSLock()
    
    init(_ initialValue: Bool) {
        _value = initialValue
    }
    
    func get() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }
    
    func set(_ newValue: Bool) {
        lock.lock()
        defer { lock.unlock() }
        _value = newValue
    }
}

// MARK: - gRPC Server

/// gRPC Driver Server for iOS
///
/// This server starts a gRPC service on the device, allowing the Dart client
/// to send commands and receive responses over HTTP/2.
@available(iOS 18.0, *)
@MainActor
final class GrpcDriverServer {
    private let port: Int
    private let testManager = XCTestManager()
    private let viewHierarchyManager = XCViewHierarchyManager()
    
    init(port: Int) {
        self.port = port
        os_log("GrpcDriverServer: Initialized on port %d", log: serverLogger, type: .error, port)
    }
    
    func start() async throws {
        os_log("GrpcDriverServer: Creating transport on port %d...", log: serverLogger, type: .error, port)
        
        // Create the transport
        let transport = HTTP2ServerTransport.Posix(
            address: .ipv4(host: "0.0.0.0", port: port),
            transportSecurity: .plaintext
        )
        
        // Create the service implementation
        let service = DriverServiceImpl(
            testManager: testManager,
            viewHierarchyManager: viewHierarchyManager
        )
        
        // Create and start the server
        let server = GRPCServer(
            transport: transport,
            services: [service]
        )
        
        os_log("GrpcDriverServer: Server created, calling serve()...", log: serverLogger, type: .error)
        
        // Run the server (blocks until stopped)
        do {
            try await server.serve()
            os_log("GrpcDriverServer: serve() RETURNED (unexpected!)", log: serverLogger, type: .error)
        } catch {
            os_log("GrpcDriverServer: serve() THREW ERROR: %{public}@", log: serverLogger, type: .error, String(describing: error))
            throw error
        }
    }
}


// MARK: - Service Implementation

@available(iOS 18.0, *)
@MainActor
final class DriverServiceImpl: FRDriverService.SimpleServiceProtocol {
    private let testManager: XCTestManager
    private let viewHierarchyManager: XCViewHierarchyManager
    // AtomicFlag is Sendable, so it can be safely accessed from nonisolated functions
    private let isStreaming = AtomicFlag(false)

    /// JPEG quality used when a screenshot request omits `quality`.
    ///
    /// 5 is the value every live participant in this contract already uses: the
    /// TypeScript client sends `quality ?? 5` at all three screenshot call
    /// sites (packages/device-node/src/grpc/GrpcDriverClient.ts), the Android
    /// driver uses 5, and driver.proto documents `Default: 5` on all four
    /// screenshot request messages. Do NOT raise this to 10 "to match the Dart
    /// default": there is no Dart code in this repository, so that claim cannot
    /// be checked against anything, and every live consumer contradicts it.
    ///
    /// `nonisolated` because both readers — `getScreenshot` and
    /// `getRawScreenshot` — are `nonisolated func`s while the enclosing class is
    /// `@MainActor`. An immutable `Sendable` static is safe to read from any
    /// isolation, so this only states what is already true, and it states it in
    /// a way this target's SWIFT_VERSION 6.0 strict concurrency checking cannot
    /// read differently.
    private nonisolated static let defaultScreenshotQuality = 5

    /// Accepted range for a `StartStreaming` fps, and the range every requested
    /// fps is clamped into before it is used as a divisor.
    ///
    /// The clamp is not cosmetic: `startStreaming` computes
    /// `UInt64(1_000_000_000 / fps)`, so `fps == 0` divides by zero and a
    /// negative fps converts a negative Int to UInt64 — in Swift both are traps,
    /// not errors, and a trap here kills the XCUITest runner hosting the driver.
    /// Bounds match XCViewHierarchyManager's `streamingFpsRange` and Android's
    /// `TestUtils.calculateFrameDelay` (`coerceIn(1, 60)`), so all three
    /// streaming paths accept the same range.
    private nonisolated static let streamingFpsRange = 1...60

    /// fps used when a `StartStreaming` request omits the field.
    ///
    /// 24 — driver.proto's documented default for this RPC, and the value this
    /// handler has always used. Deliberately NOT XCViewHierarchyManager's
    /// `defaultStreamingFps` of 1: that constant defaults the legacy WebSocket
    /// timer path, and aligning the two would change this RPC's behaviour rather
    /// than just guard its arithmetic.
    private nonisolated static let defaultStreamingFps = 24

    init(testManager: XCTestManager, viewHierarchyManager: XCViewHierarchyManager) {
        self.testManager = testManager
        self.viewHierarchyManager = viewHierarchyManager
        os_log("DriverServiceImpl: Initialized", log: serverLogger, type: .error)
    }
    
    /// Response for an RPC this driver does not implement.
    ///
    /// Returning `success = true` from a handler that does nothing is worse
    /// than returning an error: the caller cannot tell "done" from "silently
    /// ignored", so a test passes having never performed the step. The Android
    /// driver answers its own unimplemented actions the same way — false plus a
    /// message naming the action (see DriverServiceImpl.copyText / pasteText /
    /// hideKeyboard) — and so does `back` below.
    private nonisolated func unsupportedOnIOS(_ action: String) -> FRActionResponse {
        var response = FRActionResponse()
        response.success = false
        response.message = "\(action) not supported on iOS"
        logRpc(action, success: false)
        return response
    }

    /// Helper to log RPC request/response
    private nonisolated func logRpc(_ method: String, params: String = "", success: Bool? = nil) {
        if let success = success {
            os_log("RPC [%{public}@] -> success=%{public}@", log: serverLogger, type: .error, method, success ? "true" : "false")
        } else {
            os_log("RPC [%{public}@] <- %{public}@", log: serverLogger, type: .error, method, params)
        }
    }

    
    // MARK: - Device Interaction
    
    nonisolated func tap(request: FRTapRequest, context: GRPCCore.ServerContext) async throws -> FRTapResponse {
        let x = Int(request.point.x)
        let y = Int(request.point.y)
        logRpc("tap", params: "x=\(x), y=\(y)")
        
        let success = await performTapSync(x: x, y: y)
        
        var response = FRTapResponse()
        response.success = success
        response.x = request.point.x
        response.y = request.point.y
        logRpc("tap", success: success)
        return response
    }
    
    nonisolated func tapPercent(request: FRTapPercentRequest, context: GRPCCore.ServerContext) async throws -> FRTapResponse {
        // Calculate screen coordinates on MainActor first
        let (x, y) = await MainActor.run { () -> (Int, Int) in
            let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
                ?? XCViewHierarchyManager.springboardApplication
            let screenSize = app.frame.size
            let x = Int(request.point.xPercent * Double(screenSize.width))
            let y = Int(request.point.yPercent * Double(screenSize.height))
            print("gRPC tapPercent: percent=(\(request.point.xPercent), \(request.point.yPercent)) -> screenSize=\(screenSize) -> point=(\(x), \(y))")
            return (x, y)
        }
        
        // Perform tap with await
        let success = await performTapSync(x: x, y: y)
        
        var response = FRTapResponse()
        response.success = success
        response.x = Int32(x)
        response.y = Int32(y)
        return response
    }
    
    nonisolated func enterText(request: FREnterTextRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let success = await MainActor.run {
            performEnterTextSync(text: request.value)
        }
        
        var response = FRActionResponse()
        response.success = success
        return response
    }
    
    nonisolated func eraseText(request: FREraseTextRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let success = await MainActor.run {
            let deleteText = String(repeating: XCUIKeyboardKey.delete.rawValue, count: 100)
            return performEnterTextSync(text: deleteText)
        }
        
        var response = FRActionResponse()
        response.success = success
        return response
    }
    
    nonisolated func copyText(request: FRCopyTextRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        return unsupportedOnIOS("CopyText")
    }
    
    nonisolated func pasteText(request: FRPasteTextRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        return unsupportedOnIOS("PasteText")
    }
    
    nonisolated func back(request: FRBackRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        var response = FRActionResponse()
        response.success = false
        response.message = "Back action not supported on iOS"
        return response
    }
    
    nonisolated func home(request: FRHomeRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        await MainActor.run {
            XCUIDevice.shared.press(.home)
        }
        
        var response = FRActionResponse()
        response.success = true
        return response
    }
    
    nonisolated func rotate(request: FRRotateRequest, context: GRPCCore.ServerContext) async throws -> FRRotateResponse {
        logRpc("rotate")
        
        let result = await MainActor.run { () -> (success: Bool, orientation: String, message: String) in
            let device = XCUIDevice.shared
            let currentOrientation = device.orientation
            
            // Toggle logic: If portrait-ish, go landscape. If landscape-ish, go portrait.
            if currentOrientation == .landscapeLeft || currentOrientation == .landscapeRight {
                // Currently in landscape -> rotate back to portrait
                device.orientation = .portrait
            } else {
                // Currently in portrait, unknown, faceUp, faceDown, etc. -> rotate to landscape
                device.orientation = .landscapeLeft  // landscapeLeft = home button on right
            }
            
            // Small delay to allow rotation to complete
            Thread.sleep(forTimeInterval: 0.3)
            
            // Get the new orientation after rotation
            let newOrientation = device.orientation
            let orientationString = self.orientationToString(newOrientation)
            
            return (true, orientationString, "")
        }
        
        var response = FRRotateResponse()
        response.success = result.success
        response.orientation = result.orientation
        if !result.message.isEmpty {
            response.message = result.message
        }
        logRpc("rotate", success: result.success)
        return response
    }
    
    /// Converts UIDeviceOrientation to a human-readable string
    private nonisolated func orientationToString(_ orientation: UIDeviceOrientation) -> String {
        switch orientation {
        case .portrait:
            return "Portrait"
        case .portraitUpsideDown:
            return "Reverse Portrait"
        case .landscapeLeft:
            return "Landscape"  // Home button on right
        case .landscapeRight:
            return "Reverse Landscape"  // Home button on left
        case .faceUp:
            return "Face Up"
        case .faceDown:
            return "Face Down"
        case .unknown:
            return "Unknown"
        @unknown default:
            return "Unknown"
        }
    }

    
    nonisolated func hideKeyboard(request: FRHideKeyboardRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        return unsupportedOnIOS("HideKeyboard")
    }
    
    nonisolated func pressKey(request: FRPressKeyRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let key = request.key.lowercased()
        
        let result = await MainActor.run { () -> (success: Bool, message: String) in
            var success = true
            var message = ""
            
            switch key {
            case "home":
                XCUIDevice.shared.press(.home)
            case "enter", "return":
                performKeyPressSync(key: XCUIKeyboardKey.return.rawValue)
            case "delete", "backspace":
                performKeyPressSync(key: XCUIKeyboardKey.delete.rawValue)
            default:
                success = false
                message = "Unsupported key: \(key)"
            }
            return (success, message)
        }
        
        var response = FRActionResponse()
        response.success = result.success
        if !result.message.isEmpty {
            response.message = result.message
        }
        return response
    }
    
    nonisolated func swipe(request: FRSwipeRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let startX = Int(request.startX)
        let startY = Int(request.startY)
        let endX = Int(request.endX)
        let endY = Int(request.endY)
        let durationMs = Int(request.durationMs)
        logRpc("swipe", params: "(\(startX),\(startY)) -> (\(endX),\(endY)), duration=\(durationMs)ms")
        
        let success = await MainActor.run {
            performSwipeSync(startX: startX, startY: startY, endX: endX, endY: endY, durationMs: durationMs)
        }
        
        var response = FRActionResponse()
        response.success = success
        logRpc("swipe", success: success)
        return response
    }
    
    // MARK: - App Management
    
    nonisolated func launchApp(request: FRLaunchAppRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let bundleId = request.appUpload.packageName
        logRpc("launchApp", params: bundleId)
        
        let result = await MainActor.run { () -> (success: Bool, message: String) in
            let app = XCUIApplication(bundleIdentifier: bundleId)
            
            // Build launch arguments from request.arguments
            // Note: `type` field is data type (string/int/bool), not env vs arg
            // All arguments are passed as launchArguments in "-key" "value" format
            var launchArgs: [String] = []
            for (key, arg) in request.arguments {
                // Pass as "-key" "value" pairs (standard iOS launch argument format)
                launchArgs.append("-\(key)")
                launchArgs.append(arg.value)
            }
            
            // Decide: activate() if no args and app running, otherwise launch()
            let hasArgs = !launchArgs.isEmpty
            
            if !hasArgs && app.state == .runningForeground {
                // No arguments and already in foreground - just activate (no-op but ensures focus)
                app.activate()
            } else {
                // Need to launch (applies arguments, or app not running)
                if !launchArgs.isEmpty {
                    app.launchArguments = launchArgs
                }
                app.launch()
            }
            
            // Wait briefly and verify app state
            Thread.sleep(forTimeInterval: 0.5)
            
            if app.state == .runningForeground {
                return (true, "")
            } else {
                return (false, "App failed to reach foreground state: \(app.state.rawValue)")
            }
        }
        
        var response = FRActionResponse()
        response.success = result.success
        if !result.message.isEmpty {
            response.message = result.message
        }
        logRpc("launchApp", success: result.success)
        return response
    }
    
    nonisolated func killApp(request: FRKillAppRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let bundleId = request.packageName
        
        await MainActor.run {
            let app = XCUIApplication(bundleIdentifier: bundleId)
            app.terminate()
        }
        
        var response = FRActionResponse()
        response.success = true
        return response
    }
    
    nonisolated func switchToPrimaryApp(request: FRSwitchToPrimaryAppRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let bundleId = request.packageName
        
        await MainActor.run {
            let app = XCUIApplication(bundleIdentifier: bundleId)
            app.activate()
        }
        
        var response = FRActionResponse()
        response.success = true
        return response
    }
    
    nonisolated func checkAppInForeground(request: FRCheckAppInForegroundRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let bundleId = request.packageName
        
        let isForeground = await MainActor.run {
            let app = XCUIApplication(bundleIdentifier: bundleId)
            return app.state == .runningForeground
        }
        
        var response = FRActionResponse()
        response.success = isForeground
        if !isForeground {
            response.message = "App is not in foreground"
        }
        return response
    }
    
    nonisolated func getAppList(request: FRGetAppListRequest, context: GRPCCore.ServerContext) async throws -> FRAppListResponse {
        // Same contract as unsupportedOnIOS, but this RPC returns an
        // FRAppListResponse: an empty `apps` list with success = true is
        // indistinguishable from a device with no apps installed.
        var response = FRAppListResponse()
        response.success = false
        response.message = "GetAppList not supported on iOS"
        logRpc("GetAppList", success: false)
        return response
    }
    
    nonisolated func updateAppIds(request: FRUpdateAppIdsRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        let count = request.appIds.count
        await MainActor.run {
            XCViewHierarchyManager.availableAppIds = request.appIds
            print("gRPC: updateAppIds received \(count) app IDs: \(request.appIds.prefix(3))...")
        }
        
        var response = FRActionResponse()
        response.success = true
        return response
    }
    
    // MARK: - Device Info
    
    nonisolated func getDeviceScale(request: FRGetDeviceScaleRequest, context: GRPCCore.ServerContext) async throws -> FRDeviceScaleResponse {
        let scale = await MainActor.run { Float(UIScreen.main.scale) }
        
        var response = FRDeviceScaleResponse()
        response.success = true
        response.scale = scale
        return response
    }
    
    nonisolated func getScreenDimension(request: FRGetScreenDimensionRequest, context: GRPCCore.ServerContext) async throws -> FRScreenDimensionResponse {
        // Use getForegroundApp for consistency with streaming and tapPercent
        let screenSize = await MainActor.run { 
            (XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
                ?? XCViewHierarchyManager.springboardApplication).frame.size 
        }
        
        var response = FRScreenDimensionResponse()
        response.success = true
        response.screenWidth = Int32(screenSize.width)
        response.screenHeight = Int32(screenSize.height)
        return response
    }
    
    nonisolated func setLocation(request: FRSetLocationRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        return unsupportedOnIOS("SetLocation")
    }
    
    // MARK: - Screenshot and Hierarchy
    
    nonisolated func getScreenshot(request: FRGetScreenshotRequest, context: GRPCCore.ServerContext) async throws -> FRScreenshotResponse {
        let quality = request.hasQuality ? Int(request.quality) : Self.defaultScreenshotQuality
        
        let result = await MainActor.run { () -> (screenshot: String, screenSize: CGSize)? in
            // Use getForegroundApp for consistency
            let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
                ?? XCViewHierarchyManager.springboardApplication
            let screenSize = app.frame.size
            guard screenSize.width > 0, screenSize.height > 0 else { return nil }
            
            let screenshot = XCUIScreen.main.screenshot()
            let compressionQuality = CGFloat(Double(quality) / 100.0)
            guard let jpegData = screenshot.image.jpegData(compressionQuality: compressionQuality) else {
                return nil
            }
            let base64 = jpegData.base64EncodedString()
            return (base64, screenSize)
        }
        
        var response = FRScreenshotResponse()
        response.success = result != nil
        response.screenshot = result?.screenshot ?? ""
        response.screenWidth = Int32(result?.screenSize.width ?? 0)
        response.screenHeight = Int32(result?.screenSize.height ?? 0)
        return response
    }
    
    /// Get raw screenshot bytes (no base64 encoding).
    ///
    /// Optimized for comparison-only scenarios like stability checking where base64
    /// encoding/decoding overhead is wasteful. Returns raw JPEG bytes directly.
    ///
    /// Performance benefit: ~140-245ms savings per stability check (4 screenshots)
    /// - Eliminates base64 encoding on device (~10-20ms per screenshot)
    /// - Reduces gRPC transfer size by ~33%
    /// - Eliminates base64 decoding on client (~30-50ms per screenshot)
    nonisolated func getRawScreenshot(request: FRGetRawScreenshotRequest, context: GRPCCore.ServerContext) async throws -> FRRawScreenshotResponse {
        let quality = request.hasQuality ? Int(request.quality) : Self.defaultScreenshotQuality
        
        let result = await MainActor.run { () -> (jpegData: Data, screenSize: CGSize)? in
            // Use getForegroundApp for consistency with other screenshot methods
            let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
                ?? XCViewHierarchyManager.springboardApplication
            let screenSize = app.frame.size
            guard screenSize.width > 0, screenSize.height > 0 else { return nil }
            
            let screenshot = XCUIScreen.main.screenshot()
            let compressionQuality = CGFloat(Double(quality) / 100.0)
            guard let jpegData = screenshot.image.jpegData(compressionQuality: compressionQuality) else {
                return nil
            }
            // Return raw Data directly, no base64 encoding
            return (jpegData, screenSize)
        }
        
        var response = FRRawScreenshotResponse()
        response.success = result != nil
        if let result = result {
            response.screenshot = result.jpegData  // Raw bytes, NOT base64
            response.screenWidth = Int32(result.screenSize.width)
            response.screenHeight = Int32(result.screenSize.height)
        } else {
            response.message = "Failed to capture screenshot"
        }
        return response
    }
    
    nonisolated func getHierarchy(request: FRGetHierarchyRequest, context: GRPCCore.ServerContext) async throws -> FRScreenshotResponse {
        let result = await MainActor.run { () -> (hierarchy: String, screenSize: CGSize) in
            // Use getForegroundApp for consistency
            let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
                ?? XCViewHierarchyManager.springboardApplication
            let flattenedHierarchy = XCViewHierarchyManager.getFlattenedHierarchy()
            var hierarchyJson = "[]"
            if let jsonData = try? JSONEncoder().encode(flattenedHierarchy) {
                hierarchyJson = String(data: jsonData, encoding: .utf8) ?? "[]"
            }
            return (hierarchyJson, app.frame.size)
        }
        
        var response = FRScreenshotResponse()
        response.success = true
        response.hierarchy = result.hierarchy
        response.screenWidth = Int32(result.screenSize.width)
        response.screenHeight = Int32(result.screenSize.height)
        return response
    }
    
    nonisolated func getScreenshotAndHierarchy(request: FRGetScreenshotAndHierarchyRequest, context: GRPCCore.ServerContext) async throws -> FRScreenshotResponse {
        let quality = request.hasQuality ? Int(request.quality) : 5
        logRpc("getScreenshotAndHierarchy", params: "quality=\(quality)")
        
        let result = await MainActor.run { () -> (String, String, CGSize, String, String)? in
            // Use getForegroundApp for consistency with streaming
            let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
                ?? XCViewHierarchyManager.springboardApplication
            let screenSize = app.frame.size
            guard screenSize.width > 0, screenSize.height > 0 else { return nil }
            
            // Capture screenshot (synchronous UIKit call)
            let screenshot = XCUIScreen.main.screenshot()

            let compressionQuality = CGFloat(Double(quality) / 100.0)
            guard let jpegData = screenshot.image.jpegData(compressionQuality: compressionQuality) else {
                return nil
            }
            let base64 = jpegData.base64EncodedString()
            
            // Get hierarchy (synchronous call)
            let flattenedHierarchy = XCViewHierarchyManager.getFlattenedHierarchy()
            var hierarchyJson = "[]"
            if let jsonData = try? JSONEncoder().encode(flattenedHierarchy) {
                hierarchyJson = String(data: jsonData, encoding: .utf8) ?? "[]"
            }
            
            let formatter = ISO8601DateFormatter()
            formatter.timeZone = TimeZone.current
            let deviceTime = formatter.string(from: Date())
            let timezone = TimeZone.current.identifier
            
            return (base64, hierarchyJson, screenSize, deviceTime, timezone)
        }
        
        var response = FRScreenshotResponse()
        response.success = result != nil
        response.screenshot = result?.0 ?? ""
        response.hierarchy = result?.1 ?? "[]"
        response.screenWidth = Int32(result?.2.width ?? 0)
        response.screenHeight = Int32(result?.2.height ?? 0)
        response.deviceTime = result?.3 ?? ""
        response.timezone = result?.4 ?? ""
        logRpc("getScreenshotAndHierarchy", success: response.success)
        return response
    }
    
    // MARK: - Streaming (Server Streaming RPC)
    
    nonisolated func startStreaming(
        request: FRStartStreamingRequest,
        response: GRPCCore.RPCWriter<FRStreamFrame>,
        context: GRPCCore.ServerContext
    ) async throws {
        // The requested fps MUST be clamped before it is used as a divisor. An
        // unclamped `request.fps` is attacker- or bug-supplied Int32: 0 makes
        // `1_000_000_000 / fps` an integer division by zero and a negative value
        // makes `UInt64(...)` a negative-to-unsigned conversion — both TRAP in
        // Swift, which terminates the XCUITest runner and takes the whole driver
        // with it. Clamping is the same protection XCViewHierarchyManager's
        // legacy timer path applies (`streamingFpsRange`), and the same range
        // Android's TestUtils.calculateFrameDelay coerces to.
        let requestedFps = request.hasFps ? Int(request.fps) : Self.defaultStreamingFps
        let fps = min(
            max(requestedFps, Self.streamingFpsRange.lowerBound),
            Self.streamingFpsRange.upperBound
        )
        let quality = request.hasQuality ? Int(request.quality) : Self.defaultScreenshotQuality
        let frameDelayNs = UInt64(1_000_000_000 / fps)
        
        os_log("gRPC: Starting streaming with fps=%d, quality=%d", log: serverLogger, type: .error, fps, quality)
        isStreaming.set(true)
        
        var lastSentHierarchy: [XCViewHierarchy]?
        var lastSentImageData: Data?
        var consecutiveErrors = 0
        let maxConsecutiveErrors = 10
        var frameCount = 0
        
        while isStreaming.get() && !Task.isCancelled {
            frameCount += 1
            do {
                let frame = await MainActor.run { () -> FRStreamFrame? in
                    // Use getForegroundApp like WebSocket code
                    let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
                        ?? XCViewHierarchyManager.springboardApplication
                    
                    // Check if app is in foreground - if not, skip this frame (don't crash)
                    guard app.state == .runningForeground else { 
                        // App transitioning - skip frame silently like WebSocket does
                        return nil 
                    }
                    
                    // Read screen size fresh on every frame (like Android's getDisplayMetrics())
                    // This ensures correct dimensions immediately after rotation
                    let screenSize = app.frame.size
                    guard screenSize.width > 0, screenSize.height > 0 else { return nil }
                    
                    // Also update the static cache for other methods that use it
                    XCViewHierarchyManager.screenSize = screenSize
                    
                    // Capture screenshot
                    let screenshot = XCUIScreen.main.screenshot()
                    let compressionQuality = CGFloat(Double(quality) / 100.0)
                    guard let jpegData = screenshot.image.jpegData(compressionQuality: compressionQuality) else {
                        return nil
                    }
                    
                    // Check if image changed
                    let imageChanged = lastSentImageData != jpegData
                    
                    // Get hierarchy safely - wrap in case of errors during app transition
                    var flattenedHierarchy: [XCViewHierarchy] = []
                    // Using the existing getFlattenedHierarchy which has its own try-catch
                    flattenedHierarchy = XCViewHierarchyManager.getFlattenedHierarchy()
                    
                    let hierarchyChanged = lastSentHierarchy != flattenedHierarchy
                    
                    // Like WebSocket: skip if nothing changed
                    guard imageChanged || hierarchyChanged else { return nil }
                    
                    // Build frame
                    var frame = FRStreamFrame()
                    frame.screenWidth = Int32(screenSize.width)
                    frame.screenHeight = Int32(screenSize.height)
                    
                    // Only include image if changed (like WebSocket sentImageData check line 264)
                    if imageChanged {
                        frame.imageData = jpegData
                        lastSentImageData = jpegData
                    }
                    
                    // Only include hierarchy if changed (like WebSocket sentFlattenedHierarchy check line 248)
                    if hierarchyChanged {
                        var hierarchyJson = "[]"
                        if let jsonData = try? JSONEncoder().encode(flattenedHierarchy) {
                            hierarchyJson = String(data: jsonData, encoding: .utf8) ?? "[]"
                        }
                        frame.hierarchy = hierarchyJson
                        lastSentHierarchy = flattenedHierarchy
                    }
                    
                    return frame
                }
                
                if let frame = frame {
                    try await response.write(frame)
                    consecutiveErrors = 0  // Reset error count on success
                }
                
            } catch {
                consecutiveErrors += 1
                os_log("gRPC: Streaming error (attempt %d): %{public}@", log: serverLogger, type: .error, consecutiveErrors, String(describing: error))
                
                // If too many consecutive errors, stop streaming gracefully
                if consecutiveErrors >= maxConsecutiveErrors {
                    os_log("gRPC: Too many errors, ending stream", log: serverLogger, type: .error)
                    isStreaming.set(false)
                    break
                }
                // Continue loop - don't crash the server
            }
            
            try? await Task.sleep(nanoseconds: frameDelayNs)
        }
        
        os_log("gRPC: Streaming ended after %d frames", log: serverLogger, type: .error, frameCount)
        isStreaming.set(false)  // Ensure flag is reset on normal exit
    }
    
    nonisolated func stopStreaming(request: FRStopStreamingRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        isStreaming.set(false)
        
        var response = FRActionResponse()
        response.success = true
        return response
    }
    
    nonisolated func stopExecution(request: FRStopExecutionRequest, context: GRPCCore.ServerContext) async throws -> FRActionResponse {
        isStreaming.set(false)
        
        var response = FRActionResponse()
        response.success = true
        return response
    }
}

// MARK: - Helper Methods (must be called on MainActor)

/// Performs a tap at the given coordinates using EventRecord + async RunnerDaemonProxy
/// Properly waits for the tap gesture to complete before returning, preventing race conditions with subsequent actions.
@MainActor
private func performTapSync(x: Int, y: Int) async -> Bool {
    // Use EventRecord + RunnerDaemonProxy.synthesize() which waits for completion
    // This fixes intermittent tap failures caused by the old fire-and-forget approach
    let interfaceOrientation = getCurrentInterfaceOrientation()
    let eventRecord = EventRecord(orientation: interfaceOrientation)
    _ = eventRecord.addPointerTouchEvent(
        at: CGPoint(x: CGFloat(x), y: CGFloat(y)),
        touchUpAfter: 0.1  // 100ms touch duration
    )
    
    do {
        try await RunnerDaemonProxy().synthesize(eventRecord: eventRecord)
        return true
    } catch {
        print("Tap failed at (\(x), \(y)): \(error.localizedDescription)")
        return false
    }
}

@MainActor
private func performSwipeSync(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Int) -> Bool {
    // Use XCUICoordinate API which handles orientation internally
    let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) 
        ?? XCViewHierarchyManager.springboardApplication
    
    // Get screen size in current orientation
    let screenSize = app.frame.size
    
    // Create normalized coordinates (0.0 to 1.0)
    let startNormX = CGFloat(startX) / screenSize.width
    let startNormY = CGFloat(startY) / screenSize.height
    let endNormX = CGFloat(endX) / screenSize.width
    let endNormY = CGFloat(endY) / screenSize.height
    
    // Create coordinates relative to the app window
    let startCoord = app.coordinate(withNormalizedOffset: CGVector(dx: startNormX, dy: startNormY))
    let endCoord = app.coordinate(withNormalizedOffset: CGVector(dx: endNormX, dy: endNormY))
    
    // Calculate velocity based on duration and distance
    // XCUIGestureVelocity is in points per second
    let distance = sqrt(pow(CGFloat(endX - startX), 2) + pow(CGFloat(endY - startY), 2))
    let durationSec = max(0.1, Double(durationMs) / 1000.0)  // Minimum 0.1 sec
    let velocity = distance / durationSec
    
    // Perform the swipe using press-drag gesture
    // press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:) is the most reliable method
    startCoord.press(forDuration: 0.05, thenDragTo: endCoord, withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: 0)
    
    return true
}

@MainActor
private func performEnterTextSync(text: String) -> Bool {
    var success = false
    let semaphore = DispatchSemaphore(value: 0)
    
    TextInputHelper.inputText(text) { result in
        success = result
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 10.0)
    return success
}

@MainActor
private func performKeyPressSync(key: String) {
    var eventPath = PointerEventPath.pathForTextInput()
    eventPath.typeKey(key)
    // Use actual device orientation instead of hardcoded .portrait
    let interfaceOrientation = getCurrentInterfaceOrientation()
    let eventRecord = EventRecord(orientation: interfaceOrientation)
    _ = eventRecord.add(eventPath)
    RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { _ in }
}

/// Converts the current UIDeviceOrientation to UIInterfaceOrientation for EventRecord
@MainActor
private func getCurrentInterfaceOrientation() -> UIInterfaceOrientation {
    let deviceOrientation = XCUIDevice.shared.orientation
    switch deviceOrientation {
    case .portrait:
        return .portrait
    case .portraitUpsideDown:
        return .portraitUpsideDown
    case .landscapeLeft:
        // Device landscapeLeft = Interface landscapeRight (they're inverted)
        return .landscapeRight
    case .landscapeRight:
        // Device landscapeRight = Interface landscapeLeft (they're inverted)
        return .landscapeLeft
    case .faceUp, .faceDown, .unknown:
        // Default to portrait for ambiguous orientations
        return .portrait
    @unknown default:
        return .portrait
    }
}

