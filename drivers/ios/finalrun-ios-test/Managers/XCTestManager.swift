//
//  XCTestManager.swift
//  finalrun-ios-test
//
//  Created by Ajay S on 22/02/24.
//

import Foundation
import XCTest
import os

protocol XCTestDelegate: AnyObject {
    func sendXCTestResponse(jsonString: String, completion: @escaping SuccessCallBack)
}

let constant_executeTestStep = "executeTestStep"

enum XCTestCommand: String {
    case Tap
    case ValidateText = "Validate Text"
    case ValidateElement = "Validate Element"
    case EnterText = "Enter Text"
    case Swipe
    case ScrollUp = "Scroll Up"
    case ScrollDown = "Scroll Down"
    case ScrollLeft = "Scroll Left"
    case ScrollRight = "Scroll Right"
    case VScroll = "V Scroll"
    case HScroll = "H Scroll"
    case HomeScreen = "goToHomeScreen"
    case LockScreen = "lockScreen"
    case Stop = "stopTestExecution"
}

@MainActor
class XCTestManager {
    
    weak var delegate: XCTestDelegate?
    
    private var findNodeTimer: Timer?
    
    private var stopTest = false
    
    private var timeoutStartTime: TimeInterval?
    
    func startTest(withTestRequest testRequest: Action) {
        invalidateTestTimer()
        stopTest = false
        DispatchQueue.main.asyncAfter(deadline: .now()) {
            self.timeoutStartTime = Date().timeIntervalSince1970
            self.prepareForTest(testRequest)
        }
    }
    
    func updateAppIds(updateAppIdAction: UpdateAppIdAction) {
        XCViewHierarchyManager.availableAppIds = updateAppIdAction.appIds
        self.sendTestResponse(withRequestId: updateAppIdAction.requestId, type: updateAppIdAction.type, success: true)
    }
    
    func performHomeAction(_ homeAction: HomeAction) {
        XCUIDevice.shared.press(.home)
        self.sendTestResponse(withRequestId: homeAction.requestId, type: homeAction.type, success: true)
    }
    
    func performPressKeyAction(_ pressKeyAction: PressKeyAction) {
        let keyString = pressKeyAction.key.lowercased()
        var success = false
        var message = ""
        
        // Map key strings to XCUIDevice button presses
        switch keyString {
        case "home":
            XCUIDevice.shared.press(.home)
            success = true
        case "lock":
            // Lock the device
            XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
            success = true
        case "enter", "return":
            // For keyboard keys, we need to type them
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.return.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        case "delete", "backspace":
            // For delete key
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.delete.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        case "tab":
            // For tab key
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.tab.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        case "escape", "esc":
            // For escape key
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.escape.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        case "up", "uparrow", "remote_up":
            // For up arrow
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.upArrow.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        case "down", "downarrow", "remote_down":
            // For down arrow
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.downArrow.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        case "left", "leftarrow", "remote_left":
            // For left arrow
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.leftArrow.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        case "right", "rightarrow", "remote_right":
            // For right arrow
            var eventPath = PointerEventPath.pathForTextInput()
            eventPath.typeKey(XCUIKeyboardKey.rightArrow.rawValue)
            let eventRecord = EventRecord(orientation: .portrait)
            _ = eventRecord.add(eventPath)
            RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { synthesizeSuccess in
                DispatchQueue.main.async {
                    self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: synthesizeSuccess)
                }
            }
            return // Early return since we're handling async
        default:
            success = false
            message = "Unsupported key: \(keyString)"
        }
        
        // Send response for non-keyboard keys
        if !message.isEmpty {
            print("PressKey error: \(message)")
        }
        self.sendTestResponse(withRequestId: pressKeyAction.requestId, type: pressKeyAction.type, success: success)
    }
    
    func performTapAction(_ tapAction: TapAction) {
        self.performTap(point: tapAction.point) { [weak self] success in
            DispatchQueue.main.async {
                self?.sendTestResponse(withRequestId: tapAction.requestId, type: tapAction.type, success: success)
            }
        }
    }
    
    func getDeviceScale(_ deviceScale: GetDeviceScaleAction) {
        // Get the device scale from UIScreen
        let scale = UIScreen.main.scale
        
        // Create response data with scale
        let responseData = ActionResponseData(
            type: deviceScale.type,
            screenshot: nil,
            screenWidth: nil,
            screenHeight: nil,
            hierarchy: nil,
            orientation: nil,
            x: nil,
            y: nil,
            scale: Float(scale)
        )
        
        // Create and send the response
        let testResponse = ActionResponse(
            requestId: deviceScale.requestId,
            type: deviceScale.type,
            success: true,
            message: nil,
            data: responseData
        )
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let jsonData = try encoder.encode(testResponse)
            let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
            self.delegate?.sendXCTestResponse(jsonString: jsonString, completion: { success in
                if success {
                    print("Device scale response sent successfully: \(deviceScale)")
                }
            })
        } catch let error {
            print("failure due to \(error.localizedDescription)")
        }
    }
    
    func performEnterTextAction(_ enterTextAction: EnterTextAction) {
        let enterTextValue = enterTextAction.value
        print("enterValue request: \(enterTextValue)")
        let appId = self.getForegroundAppId(XCViewHierarchyManager.availableAppIds)
        guard let appId = appId else { return }
        let app = XCUIApplication(bundleIdentifier: appId)
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists {
            if enterTextAction.shouldEraseText {
                // Delete characters first based on eraseCount (default 100)
                let deleteCount = enterTextAction.effectiveEraseCount
                let deleteText = String(repeating: XCUIKeyboardKey.delete.rawValue, count: deleteCount)
                print("Clearing text with \(deleteCount) delete keys")
                
                TextInputHelper.inputText(deleteText) { [weak self] success in
                    if success {
                        print("Entering: \(enterTextValue)")
                        TextInputHelper.inputText(enterTextValue) { [weak self] success in
                            DispatchQueue.main.async {
                                self?.sendTestResponse(withRequestId: enterTextAction.requestId, type: enterTextAction.type, success: success)
                            }
                        }
                    } else {
                        DispatchQueue.main.async {
                            self?.sendTestResponse(withRequestId: enterTextAction.requestId, type: enterTextAction.type, success: false)
                        }
                    }
                }
            } else {
                // Just enter the text without clearing
                print("Entering: \(enterTextValue)")
                TextInputHelper.inputText(enterTextValue) { [weak self] success in
                    DispatchQueue.main.async {
                        self?.sendTestResponse(withRequestId: enterTextAction.requestId, type: enterTextAction.type, success: success)
                    }
                }
            }
        }
    }
    
    func performScrollAction(_ scrollAction: ScrollAction) {
        let x1 = CGFloat(scrollAction.x1)
        let y1 = CGFloat(scrollAction.y1)
        let x2 = CGFloat(scrollAction.x2)
        let y2 = CGFloat(scrollAction.y2)
        let duration = Double(scrollAction.duration)/1000 // convert to seconds.
        self.performSwipe(x1: x1, y1: y1, x2: x2, y2: y2, duration: duration) { [weak self] success in
            DispatchQueue.main.async {
                self?.sendTestResponse(withRequestId: scrollAction.requestId, type: scrollAction.type, success: success)
            }
        }
    }
    
    private func prepareForTest(_ testRequest: Action) {
    }
    
    private func invalidateTestTimer() {
        findNodeTimer?.invalidate()
        findNodeTimer = nil
    }
    func performTap(point: Point, completion: @escaping SuccessCallBack) {
        let eventRecord = EventRecord(orientation: .portrait)
        _ = eventRecord.addPointerTouchEvent(
            at: CGPoint(x: point.x, y: point.y),
            touchUpAfter: 0.1
        )
        let start = Date()
        RunnerDaemonProxy().synthesize(eventRecord: eventRecord, completion: { success in
            let duration = Date().timeIntervalSince(start)
            print("Tapping took \(duration)")
            completion(success)
        })
    }
    
    func performSwipe(with orientation: UIInterfaceOrientation = .portrait, style: EventRecord.Style = .singeFinger, x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat, duration: Double, completion: @escaping SuccessCallBack) {
        let eventRecord = EventRecord(orientation: orientation, style: style)
        _ = eventRecord.addSwipeEvent(start: CGPoint(x: x1, y: y1), end: CGPoint(x: x2, y: y2), duration: duration)
        RunnerDaemonProxy().synthesize(eventRecord: eventRecord) { success in
            completion(success)
        }
    }
    private func getForegroundAppId(_ appIds: [String]) -> String? {
        if appIds.isEmpty {
            return nil
        }
        return appIds.first { appId in
            let app = XCUIApplication(bundleIdentifier: appId)
            return app.state == .runningForeground
        }
    }
    
    private func getForegroundApp(_ runningAppIds: [String]) -> XCUIApplication? {
        runningAppIds
            .map { XCUIApplication(bundleIdentifier: $0) }
            .first { app in app.state == .runningForeground }
    }
    func sendTestResponse(withRequestId requestId: String, type: String, success: Bool) {
        
        let testResponse = ActionResponse(requestId: requestId, type: type, success: success, message: nil, data: nil)
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let jsonData = try encoder.encode(testResponse)
            let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
            self.delegate?.sendXCTestResponse(jsonString: jsonString, completion: { success in
                if success {
                    
                }
            })
        } catch let error {
            print("failure due to \(error.localizedDescription)")
        }
    }
    
}
