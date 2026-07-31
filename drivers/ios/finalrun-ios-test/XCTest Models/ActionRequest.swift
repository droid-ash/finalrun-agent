import Foundation

// MARK: - Helper Types

struct Point: Codable {
    let x: Int
    let y: Int
}

struct PointPercent: Codable {
    let xP: Double
    let yP: Double
}

struct AppUpload: Codable {
    let packageName: String
}

struct SingleArgument: Codable {
    let type: String
    let value: String
}

// MARK: - Parent Action Enum

enum Action: Codable {
    case tap(TapAction)
    case tapPercent(TapPercentAction)
    case enterText(EnterTextAction)
    case scroll(ScrollAction)
    case eraseText(EraseTextAction)
    case copyText(CopyTextAction)
    case pasteText(PasteTextAction)
    case back(BackAction)
    case home(HomeAction)
    case rotate(RotateAction)
    case startStreaming(StartStreaming)
    case stopStreaming(StopStreaming)
    case stopExecution(StopExecution)
    case getHierarchy(GetHierarchy)
    case getScreenshot(GetScreenshot)
    case getScreenshotAndHierarchy(GetScreenshotAndHierarchy)
    case getScreenDimension(GetScreenDimension)
    case checkAppInForeground(CheckAppInForeground)
    case hideKeyboard(HideKeyboardAction)
    case killApp(KillAppAction)
    case launchApp(LaunchAppAction)
    case switchToPrimaryApp(SwitchToPrimaryAppAction)
    case pressKey(PressKeyAction)
    case setLocation(SetLocationAction)
    case updateAppIds(UpdateAppIdAction)
    case getDeviceScale(GetDeviceScaleAction)
    
    enum CodingKeys: String, CodingKey {
        case type
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "tap":
            self = .tap(try TapAction(from: decoder))
        case "tapPercent":
            self = .tapPercent(try TapPercentAction(from: decoder))
        case "enterText":
            self = .enterText(try EnterTextAction(from: decoder))
        case "scroll":
            self = .scroll(try ScrollAction(from: decoder))
        case "eraseText":
            self = .eraseText(try EraseTextAction(from: decoder))
        case "copyText":
            self = .copyText(try CopyTextAction(from: decoder))
        case "pasteText":
            self = .pasteText(try PasteTextAction(from: decoder))
        case "back":
            self = .back(try BackAction(from: decoder))
        case "home":
            self = .home(try HomeAction(from: decoder))
        case "rotate":
            self = .rotate(try RotateAction(from: decoder))
        case "startStreaming":
            self = .startStreaming(try StartStreaming(from: decoder))
        case "stopStreaming":
            self = .stopStreaming(try StopStreaming(from: decoder))
        case "stopExecution":
            self = .stopExecution(try StopExecution(from: decoder))
        case "getHierarchy":
            self = .getHierarchy(try GetHierarchy(from: decoder))
        case "getScreenshot":
            self = .getScreenshot(try GetScreenshot(from: decoder))
        case "getScreenshotAndHierarchy":
            self = .getScreenshotAndHierarchy(try GetScreenshotAndHierarchy(from: decoder))
        case "getScreenDimension":
            self = .getScreenDimension(try GetScreenDimension(from: decoder))
        case "checkAppInForeground":
            self = .checkAppInForeground(try CheckAppInForeground(from: decoder))
        case "hideKeyboard":
            self = .hideKeyboard(try HideKeyboardAction(from: decoder))
        case "killApp":
            self = .killApp(try KillAppAction(from: decoder))
        case "launchApp":
            self = .launchApp(try LaunchAppAction(from: decoder))
        case "switchToPrimaryApp":
            self = .switchToPrimaryApp(try SwitchToPrimaryAppAction(from: decoder))
        case "pressKey":
            self = .pressKey(try PressKeyAction(from: decoder))
        case "setLocation":
            self = .setLocation(try SetLocationAction(from: decoder))
        case "updateAppIds":
            self = .updateAppIds(try UpdateAppIdAction(from: decoder))
        case "getDeviceScale":
            self = .getDeviceScale(try GetDeviceScaleAction(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: CodingKeys.type,
                                                   in: container,
                                                   debugDescription: "Unknown type: \(type)")
        }
    }
    
    func encode(to encoder: Encoder) throws {
        switch self {
        case .tap(let action):
            try action.encode(to: encoder)
        case .tapPercent(let action):
            try action.encode(to: encoder)
        case .enterText(let action):
            try action.encode(to: encoder)
        case .scroll(let action):
            try action.self.encode(to: encoder)
        case .eraseText(let action):
            try action.encode(to: encoder)
        case .copyText(let action):
            try action.encode(to: encoder)
        case .pasteText(let action):
            try action.encode(to: encoder)
        case .back(let action):
            try action.encode(to: encoder)
        case .home(let action):
            try action.encode(to: encoder)
        case .rotate(let action):
            try action.encode(to: encoder)
        case .startStreaming(let action):
            try action.encode(to: encoder)
        case .stopStreaming(let action):
            try action.encode(to: encoder)
        case .stopExecution(let action):
            try action.encode(to: encoder)
        case .getHierarchy(let action):
            try action.encode(to: encoder)
        case .getScreenshot(let action):
            try action.encode(to: encoder)
        case .getScreenshotAndHierarchy(let action):
            try action.encode(to: encoder)
        case .getScreenDimension(let action):
            try action.encode(to: encoder)
        case .checkAppInForeground(let action):
            try action.encode(to: encoder)
        case .hideKeyboard(let action):
            try action.encode(to: encoder)
        case .killApp(let action):
            try action.encode(to: encoder)
        case .launchApp(let action):
            try action.encode(to: encoder)
        case .switchToPrimaryApp(let action):
            try action.encode(to: encoder)
        case .pressKey(let action):
            try action.encode(to: encoder)
        case .setLocation(let action):
            try action.encode(to: encoder)
        case .updateAppIds(let action):
            try action.encode(to: encoder)
        case .getDeviceScale(let action):
            try action.encode(to: encoder)
        }
    }
}

// MARK: - Action Subclasses

struct TapAction: Codable {
    let point: Point
    let repeatCount: Int?
    let delay: Int?
    let requestId: String
    let type: String = "tap"
    
    enum CodingKeys: String, CodingKey {
        case point, requestId, delay
        case repeatCount = "repeat"
    }
}

struct TapPercentAction: Codable {
    let point: PointPercent
    let repeatCount: Int?
    let delay: Int?
    let requestId: String
    let type: String = "tapPercent"
    
    enum CodingKeys: String, CodingKey {
        case point, requestId, delay
        case repeatCount = "repeat"
    }
}

struct EnterTextAction: Codable {
    let value: String
    let requestId: String
    let shouldEraseText: Bool
    let type: String
    let eraseCount: Int?
    
    var effectiveEraseCount: Int {
        return eraseCount ?? 100
    }
}

struct ScrollAction: Codable {
    let requestId: String
    let type: String
    let duration: Int
    let x1: Int
    let x2: Int
    let y1: Int
    let y2: Int
}

struct EraseTextAction: Codable {
    let requestId: String
    let type: String
}

struct CopyTextAction: Codable {
    let requestId: String
    let type: String
}

struct PasteTextAction: Codable {
    let requestId: String
    let type: String
}

struct BackAction: Codable {
    let requestId: String
    let type: String
}

struct HomeAction: Codable {
    let requestId: String
    let type: String
}

struct RotateAction: Codable {
    let requestId: String
    let type: String
}

struct StartStreaming: Codable {
    let requestId: String
    let fps: Int?   // Default can be provided by your business logic (e.g., 24)
    let quality: Int? // Default can be provided (e.g., 5)
    let type: String
}

struct StopStreaming: Codable {
    let requestId: String
    let type: String
}

struct StopExecution: Codable {
    let requestId: String
    let type: String
}

struct GetHierarchy: Codable {
    let requestId: String
    let type: String
}

struct GetScreenshot: Codable {
    let requestId: String
    let type: String
    let quality: Int?
}

struct GetScreenshotAndHierarchy: Codable {
    let requestId: String
    let type: String
    let quality: Int?
}

struct GetScreenDimension: Codable {
    let requestId: String
    let type: String
}

struct CheckAppInForeground: Codable {
    let requestId: String
    let packageName: String
    let timeout: Int  // timeout in seconds
    let type: String
}

struct HideKeyboardAction: Codable {
    let requestId: String
    let type: String
}

struct KillAppAction: Codable {
    let requestId: String
    let type: String
}

struct LaunchAppAction: Codable {
    let appUpload: AppUpload
    let allowAllPermissions: Bool
    let arguments: [String: SingleArgument]?
    let permissions: [String: String]?
    let shouldUninstallBeforeLaunch: Bool
    let requestId: String
    let type: String
}

struct SwitchToPrimaryAppAction: Codable {
    let packageName: String
    let requestId: String
    let type: String
}

struct PressKeyAction: Codable {
    let key: String
    let requestId: String
    let type: String
}

struct SetLocationAction: Codable {
    let lat: Double
    let long: Double
    let requestId: String
    let type: String
}

struct UpdateAppIdAction: Codable {
    let appIds: [String]
    let requestId: String
    let type: String
}

struct GetDeviceScaleAction: Codable {
    let requestId: String
    let type: String
}
