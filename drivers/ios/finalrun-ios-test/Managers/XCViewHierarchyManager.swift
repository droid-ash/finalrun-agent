//
//  XCViewHierarchyManager.swift
//  finalrun-ios-test
//
//  Created by Ajay S on 30/01/24.
//
//  Enhanced to capture iOS system-level permission dialogs and alerts.
//  The hierarchy now includes:
//  - App-level UI elements (original functionality)
//  - System-level alerts (permission dialogs, system notifications)
//  - System-level overlays (sheets, popovers, modals)
//

import Foundation
import XCTest
import os

typealias SuccessCallBack = ((_ success: Bool) -> Void)
typealias TargetNodeCallBack = ((_ success: Bool, _ node: XCViewHierarchy?) -> Void)

protocol XCViewHierarchyDelegate: AnyObject {
    func sendAnyStringPayload(jsonString: String, completion: @escaping SuccessCallBack)
    func sendAnyImagePayload(imageData: Data, completion: @escaping SuccessCallBack)
}

@MainActor
class XCViewHierarchyManager {
    
    static let springboardBundleId = "com.apple.springboard"
    static let springboardApplication = XCUIApplication(bundleIdentifier: springboardBundleId)
    static let snapshotMaxDepth = 60
    private let compressionQuality: CGFloat = 0 // Most compressed, 1: Least compressed.

    /// Frame rates the streaming timer accepts, mirroring the Android driver's
    /// `frameRate.coerceIn(1, 60)` in TestUtils.calculateFrameDelay. Below 1 the
    /// interval is unbounded; above 60 the hierarchy snapshot cannot keep up.
    private static let streamingFpsRange = 1...60
    /// Used when StartStreaming omits `fps`.
    private static let defaultStreamingFps = 1
    
    private var sentImageData: Data?
    private var sentFlattenedHierarchy: [XCViewHierarchy]?
    private var canSendStreamingPayload = false
    
    private var hierarchyTimer: Timer?
    static var availableAppIds = [String]()
    weak var delegate: XCViewHierarchyDelegate?
    
    static var screenSize: CGSize?
    private var deviceOrientation: UIDeviceOrientation?
    
    func startStreaming(with startStreamingPayload: StartStreaming) {
        print("Streaming started")
        canSendStreamingPayload = true
        stopTimer()
        removeDataForComparison()
        guard hierarchyTimer == nil else { return }
        // Frame interval in seconds = 1 / fps, and the division MUST happen in
        // Double. Do NOT shorten this to `Double(1 / fps)`: that divides two
        // Ints and only then widens, so 1/24 == 0, the interval becomes 0, and
        // the timer fires as fast as the run loop allows. Android hit the same
        // trap and records it in TestUtils.calculateFrameDelay
        // (`1000.0 / fps.toDouble()`).
        let requestedFps = startStreamingPayload.fps ?? Self.defaultStreamingFps
        let fps = min(
            max(requestedFps, Self.streamingFpsRange.lowerBound),
            Self.streamingFpsRange.upperBound
        )
        hierarchyTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / Double(fps), repeats: true) { timer in
            self.sendXCViewHierarchy(with: startStreamingPayload)
        }
    }
    
    func stopStreaming() {
        canSendStreamingPayload = false
        stopTimer()
        removeDataForComparison()
//        let stopStreamingPayload = XCTestResponse(action: "stopStreaming", response: ResponseData(stepId: nil, testId: nil, testExecutionId: nil, testGroupId: nil, success: nil, code: 200, message: "Streaming stopped", screenshot: nil, failedReason: nil, node_bounds: nil, screenHeight: nil, screenWidth: nil))
//        do {
//            let encoder = JSONEncoder()
//            encoder.outputFormatting = .prettyPrinted
//            let jsonData = try encoder.encode(stopStreamingPayload)
//            let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
//            delegate?.sendAnyStringPayload(jsonString: jsonString, completion: { success in
//
//            })
//        } catch let error {
//            print("failure due to \(error.localizedDescription)")
//        }
    }
    
    private func stopTimer() {
        hierarchyTimer?.invalidate()
        hierarchyTimer = nil
    }
    
    private func removeDataForComparison() {
        sentImageData = nil
        sentFlattenedHierarchy = nil
    }
    
    func sendScreenshot(forRequestId id: String, quality: Int?) {
        let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) ?? XCViewHierarchyManager.springboardApplication

        let screenshot = XCUIScreen.main.screenshot()
        guard let jpegData = screenshot.image.jpegData(compressionQuality: CGFloat(Double(quality ?? 5)/100.0)) else {
            return
        }
        let base64String = jpegData.base64EncodedString()
        guard app.state == .runningForeground else {
            return
        }
        let currentOrientation = XCUIDevice.shared.orientation
        if XCViewHierarchyManager.screenSize == nil || deviceOrientation != currentOrientation {
            XCViewHierarchyManager.screenSize = app.frame.size
            deviceOrientation = currentOrientation
        }
        guard let screenWidth = XCViewHierarchyManager.screenSize?.width, let screenHeight = XCViewHierarchyManager.screenSize?.height else {
            return
        }
        // app.frame.size already reflects the current orientation, no need to swap
        let screenshotPayload = XCViewHierarchyPayload(type: "getScreenshot", requestId: id, success: true, data: XCViewHierarchyResponse(hierarchy: nil, screenshot: base64String, screenWidth: Int(screenWidth), screenHeight: Int(screenHeight), isKeyboardShown: app.keyboards.firstMatch.exists))
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let jsonData = try encoder.encode(screenshotPayload)
            let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
            self.delegate?.sendAnyStringPayload(jsonString: jsonString, completion: { success in
                if success {
                    print("screenshot sent")
                }
            })
        } catch let error {
            print("failure due to \(error.localizedDescription)")
        }
    }
    
    func sendScreenDimensions(forRequestId id: String) {
        let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) ?? XCViewHierarchyManager.springboardApplication
        
        guard app.state == .runningForeground else {
            return
        }
        
        let currentOrientation = XCUIDevice.shared.orientation
        if XCViewHierarchyManager.screenSize == nil || deviceOrientation != currentOrientation {
            XCViewHierarchyManager.screenSize = app.frame.size
            deviceOrientation = currentOrientation
        }
        
        guard let screenWidth = XCViewHierarchyManager.screenSize?.width, let screenHeight = XCViewHierarchyManager.screenSize?.height else {
            return
        }
        
        // app.frame.size already reflects the current orientation, no need to swap
        let screenDimensionPayload = XCViewHierarchyPayload(
            type: "getScreenDimension",
            requestId: id,
            success: true,
            data: XCViewHierarchyResponse(
                hierarchy: nil,
                screenshot: nil,
                screenWidth: Int(screenWidth),
                screenHeight: Int(screenHeight),
                isKeyboardShown: nil
            )
        )
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let jsonData = try encoder.encode(screenDimensionPayload)
            let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
            self.delegate?.sendAnyStringPayload(jsonString: jsonString, completion: { success in
                if success {
                    print("screen dimensions sent")
                }
            })
        } catch let error {
            print("failure due to \(error.localizedDescription)")
        }
    }
    
    func sendScreenshotAndHierarchy(forRequestId id: String, quality: Int?) {
        let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) ?? XCViewHierarchyManager.springboardApplication
        let flattenedHierarchy = XCViewHierarchyManager.getFlattenedHierarchy()
        var flattenedHierarchyString: String?
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let jsonData = try encoder.encode(flattenedHierarchy)
            flattenedHierarchyString = String(data: jsonData, encoding: .utf8) ?? ""
        } catch let error {
            print("Flattened Hierarchy JSON Encoding Error: \(error)")
        }
        let screenshot = XCUIScreen.main.screenshot()
        guard let jpegData = screenshot.image.jpegData(compressionQuality: CGFloat(Double(quality ?? 5)/100.0)) else {
            return
        }
        let base64String = jpegData.base64EncodedString()
        guard app.state == .runningForeground else {
            return
        }
        let currentOrientation = XCUIDevice.shared.orientation
        if XCViewHierarchyManager.screenSize == nil || deviceOrientation != currentOrientation {
            XCViewHierarchyManager.screenSize = app.frame.size
            deviceOrientation = currentOrientation
        }
        guard let screenWidth = XCViewHierarchyManager.screenSize?.width, let screenHeight = XCViewHierarchyManager.screenSize?.height else {
            return
        }
        // app.frame.size already reflects the current orientation, no need to swap
        let deviceTime = ISO8601DateFormatter().string(from: Date())
        let timezone = TimeZone.current.identifier
        let viewHierarchyPayload = XCViewHierarchyPayload(type: "getScreenshotAndHierarchy", requestId: id, success: true, data: XCViewHierarchyResponse(hierarchy: flattenedHierarchyString, screenshot: base64String, screenWidth: Int(screenWidth), screenHeight: Int(screenHeight), isKeyboardShown: app.keyboards.firstMatch.exists, deviceTime: deviceTime, timezone: timezone))
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let jsonData = try encoder.encode(viewHierarchyPayload)
            let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
            self.delegate?.sendAnyStringPayload(jsonString: jsonString, completion: { success in
                if success {
                    print("hierarchy and screenshot sent")
                }
            })
        } catch let error {
            print("failure due to \(error.localizedDescription)")
        }
    }
    
    func sendXCViewHierarchy(with startStreamingPayload: StartStreaming) {
        let app = XCViewHierarchyManager.getForegroundApp(XCViewHierarchyManager.availableAppIds) ?? XCViewHierarchyManager.springboardApplication
        let flattenedHierarchy = XCViewHierarchyManager.getFlattenedHierarchy()
        var flattenedHierarchyString: String?
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let jsonData = try encoder.encode(flattenedHierarchy)
            flattenedHierarchyString = String(data: jsonData, encoding: .utf8) ?? ""
        } catch let error {
            print("Flattened Hierarchy JSON Encoding Error: \(error)")
        }
        let screenshot = XCUIScreen.main.screenshot()
        guard let jpegData = screenshot.image.jpegData(compressionQuality: CGFloat(Double(startStreamingPayload.quality ?? 5)/100.0)) else {
            return
        }
        let byteArray = [UInt8](jpegData)
        let imageData = Data(byteArray)
        guard app.state == .runningForeground else {
            return
        }
        if XCViewHierarchyManager.screenSize == nil || deviceOrientation != XCUIDevice.shared.orientation {
            XCViewHierarchyManager.screenSize = app.frame.size
            deviceOrientation = XCUIDevice.shared.orientation
        }
        guard let screenWidth = XCViewHierarchyManager.screenSize?.width, let screenHeight = XCViewHierarchyManager.screenSize?.height, canSendStreamingPayload else {
            return
        }
        // app.frame.size already reflects the current orientation, no need to swap
        let viewHierarchyPayload = XCViewHierarchyPayload(type: "getHierarchyForEveryFrame", requestId: startStreamingPayload.requestId, success: true, data: XCViewHierarchyResponse(hierarchy: flattenedHierarchyString, screenWidth: Int(screenWidth), screenHeight: Int(screenHeight), isKeyboardShown: app.keyboards.firstMatch.exists))
        if sentFlattenedHierarchy != flattenedHierarchy {
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = .prettyPrinted
                let jsonData = try encoder.encode(viewHierarchyPayload)
                let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
                self.delegate?.sendAnyStringPayload(jsonString: jsonString, completion: { [weak self] success in
                    if success {
                        print("Hierarchy sent")
                        self?.sentFlattenedHierarchy = flattenedHierarchy
                    }
                })
            } catch let error {
                print("failure due to \(error.localizedDescription)")
            }
        }
        guard self.sentImageData != imageData else {
            return
        }
        self.delegate?.sendAnyImagePayload(imageData: imageData, completion: { [weak self] success in
            if success {
                print("Successfully sent image")
                self?.sentImageData = imageData
            }
        })
    }
    
    static func getFlattenedHierarchy() -> [XCViewHierarchy] {
        var flattenedHierarchy = [XCViewHierarchy]()
        let app = self.getForegroundApp(XCViewHierarchyManager.availableAppIds) ?? XCViewHierarchyManager.springboardApplication
        
        // Calculate screen dimensions ONCE at the start
        let screenSize = app.frame.size
        let screenDimensions = (width: Int(screenSize.width), height: Int(screenSize.height))
        
        do {
            let xcViewElement = try self.getHierarchy(app)
            flattenedHierarchy = self.dfs(xcViewElement: xcViewElement, screenDimensions: screenDimensions)
            
            if let systemAlerts = self.getSystemAlertHierarchy() {
                flattenedHierarchy += self.dfs(xcViewElement: systemAlerts, screenDimensions: screenDimensions)
            }
            
            let systemOverlays = self.getSystemOverlayHierarchy()
            for overlay in systemOverlays {
                flattenedHierarchy += self.dfs(xcViewElement: overlay, screenDimensions: screenDimensions)
            }
        } catch let error {
            print("failure due to \(error.localizedDescription)")
        }
        return flattenedHierarchy
    }
    
    static private func dfs(xcViewElement: XCViewElement, screenDimensions: (width: Int, height: Int)) -> [XCViewHierarchy] {
        let hierarchy = XCViewHierarchy(xcViewElement.root, uuid: xcViewElement.uuid, parentUUID: xcViewElement.parentUUID, children: xcViewElement.children)
        
        // Check if current element should be filtered (using passed dimensions, no recalculation)
        if shouldFilterElement(hierarchy, screenWidth: screenDimensions.width, screenHeight: screenDimensions.height) {
            return []
        }
        
        var result: [XCViewHierarchy] = [hierarchy]
        
        if let children = xcViewElement.xcChildren {
            for childData in children {
                result += dfs(xcViewElement: childData, screenDimensions: screenDimensions)
            }
        }
        return result
    }
    
    static func getForegroundApp(_ runningAppIds: [String]) -> XCUIApplication? {
        runningAppIds
            .map { XCUIApplication(bundleIdentifier: $0) }
            .first { app in app.state == .runningForeground }
    }
    
//    func getAppViewHierarchy(app: XCUIApplication, excludeKeyboardElements: Bool) throws -> XCViewElement {
//        // Fetch the view hierarchy of the springboard application
//        // to make it possible to interact with the home screen.
//        // Ignore any errors on fetching the springboard hierarchy.
//        let springboardHierarchy: XCViewElement?
//        do {
//            springboardHierarchy = try elementHierarchy(xcuiElement: XCViewHierarchyManager.springboardApplication)
//        } catch {
//            springboardHierarchy = nil
//        }
//
//        let appHierarchy = try getHierarchy(app)
//
//        let keyboard = app.keyboards.firstMatch
//        if (excludeKeyboardElements && keyboard.exists) {
//            let filteredChildren = appHierarchy.filterAllChildrenNotInKeyboardBounds(keyboard.frame)
//            return XCViewElement(children: [
//                springboardHierarchy,
//                XCViewElement(children: filteredChildren),
//            ].compactMap { $0 })
//        }
//
//        return XCViewElement(children: [
//            springboardHierarchy,
//            appHierarchy,
//        ].compactMap { $0 })
//    }
    
    static private func getHierarchy(_ element: XCUIElement) throws -> XCViewElement {
        do {
            var hierarchy = try elementHierarchy(xcuiElement: element)
            if hierarchy.depth() < XCViewHierarchyManager.snapshotMaxDepth {
                return hierarchy
            }
            let count = try element.snapshot().children.count
            var children: [XCViewElement] = []
            for i in 0..<count {
                let element = element.descendants(matching: .other).element(boundBy: i).firstMatch
                children.append(try getHierarchy(element))
            }
            hierarchy.xcChildren = children
            if let element = element as? XCUIApplication {
                if let keyboard = keyboardHierarchy(element) {
                    hierarchy.xcChildren?.append(keyboard)
                }
            }
            return hierarchy
        } catch _ {
            // In apps with bigger view hierarchys, calling
            // `XCUIApplication().snapshot().dictionaryRepresentation` or `XCUIApplication().allElementsBoundByIndex`
            // throws "Error kAXErrorIllegalArgument getting snapshot for element <AXUIElementRef 0x6000025eb660>"
            // We recover by selecting the first child of the app element,
            // which should be the window, and continue from there.

            let recoveryElement = try findRecoveryElement(element.children(matching: .any).firstMatch)
            let hierarchy = try getHierarchy(recoveryElement)

            // When the application element is skipped, try to fetch
            // the keyboard, alert and other custom element hierarchies separately.
            if let element = element as? XCUIApplication {
                let keyboard = keyboardHierarchy(element)
                
                let fullscreenAlert = fullScreenAlertHierarchy(element)

                let other = try customWindowElements(element)
            
                return XCViewElement(children: [
                    other,
                    keyboard,
                    fullscreenAlert,
                    hierarchy
                ].compactMap { $0 })
            }
            return hierarchy
        }
    }
    
    static private func keyboardHierarchy(_ element: XCUIApplication) -> XCViewElement? {
        guard element.keyboards.firstMatch.exists else {
            return nil
        }
        
        let keyboard = element.keyboards.firstMatch
        return try? elementHierarchy(xcuiElement: keyboard)
    }
    
    static private func customWindowElements(_ element: XCUIApplication) throws -> XCViewElement? {
        let windowElement = element.children(matching: .any).firstMatch
        if try windowElement.snapshot().children.count > 1 {
            return nil
        }
        return try? elementHierarchy(xcuiElement: windowElement)
    }
    
    static private func fullScreenAlertHierarchy(_ element: XCUIApplication) -> XCViewElement? {
        guard element.alerts.firstMatch.exists else {
            return nil
        }
        
        let alert = element.alerts.firstMatch
        return try? elementHierarchy(xcuiElement: alert)
    }
    
    /// Detects system-level alerts (like permission dialogs) that appear over apps
    /// These alerts belong to springboard/system, not the current app
    static private func getSystemAlertHierarchy() -> XCViewElement? {
        guard XCViewHierarchyManager.springboardApplication.alerts.firstMatch.exists else {
            return nil
        }
        
        do {
            let springboardAlert = XCViewHierarchyManager.springboardApplication.alerts.firstMatch
            let alertHierarchy = try elementHierarchy(xcuiElement: springboardAlert)
            
            print("System alert detected - likely a permission dialog")
            return alertHierarchy
        } catch let error {
            print("Failed to capture system alert hierarchy: \(error.localizedDescription)")
            return nil
        }
    }
    
    /// Comprehensive method to detect system-level overlays (sheets, modals, etc.)
    /// that might contain permission dialogs or other system interactions
    static private func getSystemOverlayHierarchy() -> [XCViewElement] {
        var systemOverlays: [XCViewElement] = []
        let springboard = XCViewHierarchyManager.springboardApplication
        
        if springboard.sheets.count > 0 {
            for i in 0..<springboard.sheets.count {
                let sheet = springboard.sheets.element(boundBy: i)
                if sheet.exists {
                    do {
                        let sheetHierarchy = try elementHierarchy(xcuiElement: sheet)
                        systemOverlays.append(sheetHierarchy)
                        print("System sheet detected - potential permission dialog")
                    } catch {
                        print("Failed to capture system sheet: \(error.localizedDescription)")
                    }
                }
            }
        }
        
        // Check for system popovers (iPad permission dialogs)
        if springboard.popovers.count > 0 {
            for i in 0..<springboard.popovers.count {
                let popover = springboard.popovers.element(boundBy: i)
                if popover.exists {
                    do {
                        let popoverHierarchy = try elementHierarchy(xcuiElement: popover)
                        systemOverlays.append(popoverHierarchy)
                        print("System popover detected - potential permission dialog")
                    } catch {
                        print("Failed to capture system popover: \(error.localizedDescription)")
                    }
                }
            }
        }
        
        return systemOverlays
    }
    
    static private func findRecoveryElement(_ element: XCUIElement) throws -> XCUIElement {
        if try element.snapshot().children.count > 1 {
            return element
        }
        let firstOtherElement = element.children(matching: .other).firstMatch
        if (firstOtherElement.exists) {
            return try findRecoveryElement(firstOtherElement)
        } else {
            return element
        }
    }
    
    static private func elementHierarchy(xcuiElement: XCUIElement) throws -> XCViewElement {
        let snapshotDictionary = try xcuiElement.snapshot().dictionaryRepresentation
        return XCViewElement(dict: snapshotDictionary)
    }
    
    // MARK: - Element Filtering Methods
    
    /// Checks if an element is completely outside the screen bounds
    private static func isElementOutOfBounds(_ bounds: XCBounds?, screenWidth: Int, screenHeight: Int) -> Bool {
        guard let bounds = bounds else { return true }

        if bounds.right ?? 0 <= 0 { return true }
        if bounds.left ?? 0 >= Double(screenWidth) { return true }
        if bounds.bottom ?? 0 <= 0 { return true }
        if bounds.top ?? 0 >= Double(screenHeight) { return true }
        
        return false
    }
    
    /// Checks if an element should be filtered out based on size and position
    private static func shouldFilterElement(_ hierarchy: XCViewHierarchy, screenWidth: Int, screenHeight: Int) -> Bool {
        guard let bounds = hierarchy.bounds else { return true }
        
        let width = (bounds.right ?? 0) - (bounds.left ?? 0)
        let height = (bounds.bottom ?? 0) - (bounds.top ?? 0)
        
        if width <= 0 || height <= 0 { return true }
        
        if isElementOutOfBounds(bounds, screenWidth: screenWidth, screenHeight: screenHeight) { return true }
        
        return false
    }
    
    /// Gets the current screen dimensions accounting for device orientation
    private static func getCurrentScreenDimensions() -> (width: Int, height: Int) {
        // Use getForegroundApp().frame.size for consistency with hierarchy bounds calculation
        let app = getForegroundApp(availableAppIds) ?? springboardApplication
        let size = app.frame.size
        
        let width = Int(size.width)
        let height = Int(size.height)
        
        return (width: width, height: height)
    }
}
