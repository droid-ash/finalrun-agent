//
//  XCViewElement.swift
//  finalrun-ios-test
//
//  Created by Ajay S on 08/02/24.
//

import Foundation
import XCTest

struct XCViewElement {
    let root: [XCUIElement.AttributeName : Any]
    var uuid: String?
    var parentUUID: String?
    var children = [String]()
    var xcChildren: [XCViewElement]?
    
    init(dict: [XCUIElement.AttributeName : Any]) {
        self.root = dict
        self.uuid = UUID().uuidString
        let childrenDictionaries = dict[XCUIElement.AttributeName(rawValue: "children")] as? [[XCUIElement.AttributeName: Any]]
        self.xcChildren = childrenDictionaries?.map { XCViewElement(dict: $0) } ?? []
        xcChildren?.indices.forEach { index in
            xcChildren?[index].parentUUID = uuid
            if let xcChildUUID = xcChildren?[index].uuid {
                self.children.append(xcChildUUID)
            }
        }
    }
    
    init(children: [XCViewElement]) {
        self.xcChildren = children
        self.root = [:]
    }
    
    func depth() -> Int {
        guard let children = xcChildren
        else { return 1 }

        let max = children
            .map { child in child.depth() + 1 }
            .max()

        return max ?? 1
    }
    
    func filterAllChildrenNotInKeyboardBounds(_ keyboardFrame: CGRect) -> [XCViewElement] {
        var filteredChildren = [XCViewElement]()
        func filterChildrenRecursively(_ element: XCViewElement, _ ancestorAdded: Bool) {
            func valueFor(_ name: String) -> Any {
                element.root[XCUIElement.AttributeName(rawValue: name)] as Any
            }
            let frame = valueFor("frame") as? XCFrame ?? .zero
            let childFrame = CGRect(
                x: frame["X"] ?? 0,
                y: frame["Y"] ?? 0,
                width: frame["Width"] ?? 0,
                height: frame["Height"] ?? 0
            )
            
            var currentAncestorAdded = ancestorAdded

            if !keyboardFrame.intersects(childFrame) && !ancestorAdded {
                filteredChildren.append(element)
                currentAncestorAdded = true // Prevent adding descendants of this element
            }
            element.xcChildren?.forEach { child in
                filterChildrenRecursively(child, currentAncestorAdded)
            }
        }
        filterChildrenRecursively(self, false)
        return filteredChildren
    }
}
