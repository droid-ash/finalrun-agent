package app.finalrun.android.data.hierarchy

import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.GridLayout
import android.widget.GridView
import android.widget.ListView
import android.widget.TableLayout
import androidx.test.platform.app.InstrumentationRegistry
import app.finalrun.android.data.DeviceCache
import app.finalrun.android.debugLog
import app.finalrun.android.errorLog
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONException
import java.util.UUID

object AccessibilityStreamer {
    private const val LOGTAG = "AccessibilityStreamer"

    // NAF excluded classes - copied from Finalrun
    private val NAF_EXCLUDED_CLASSES = arrayOf(
        GridView::class.java.name, GridLayout::class.java.name,
        ListView::class.java.name, TableLayout::class.java.name
    )

    /**
     * Depth-first search for the focused node under [node].
     *
     * The polling loop does NOT guarantee bounds stability, despite the
     * function's name: it returns the node on the first reading that matches the
     * bounds captured on entry, and returns the same node unconditionally once
     * the ten polls are exhausted. Both exits produce the same value, so the
     * only observable effect of the loop is a delay of up to ~5s for a node
     * whose bounds keep changing. Treat the result as "the focused node", never
     * as "a node that has settled".
     *
     * Implementing a real stability wait would change streaming latency in
     * native code with no test coverage, so it is deliberately left alone.
     */
    private suspend fun findStableFocusedNodeInRoot(
        node: AccessibilityNodeInfo?
    ): AccessibilityNodeInfo? {
        if (node == null) return null

        // 1) Find the focused node via DFS
        if (!node.isFocused) {
            for (i in 0 until node.childCount) {
                val child = node.getChild(i)
                findStableFocusedNodeInRoot(child)?.let { return it }
            }
            return null
        }

        // 2) Poll the focused node's bounds: up to 10 readings, 500ms apart.
        // `initialBounds` is never re-captured, so this exits on the first
        // reading equal to the entry bounds — and returns the node anyway when
        // the readings run out.
        val initialBounds = Rect().also { node.getBoundsInScreen(it) }
        val tempBounds = Rect()

        for (i in 1..10) {
            delay(500)
            node.getBoundsInScreen(tempBounds)
            if(tempBounds == initialBounds) return node
            else continue
        }
        return node
    }

    suspend fun getStableFocusedNode(): AccessibilityNodeInfo? {
        val roots = getWindowRoots()
        for (root in roots) {
            findStableFocusedNodeInRoot(root)?.let { return it }
        }
        return null
    }

    /**
     * THE VISIBILITY-FILTERED TRAVERSAL. `processNodeRecursive` descends into a
     * child only when `child.isVisibleToUser || insideWebView`, so off-screen and
     * hidden subtrees are absent from the result. Reads the CACHED window roots
     * (`getWindowRootsFast`).
     *
     * Callers: the two streaming paths — `DriverServiceImpl.startStreaming` (the
     * gRPC `StartStreaming` stream) and `ScreenStreamer.startStreaming` (the
     * legacy WebSocket frame loop).
     *
     * This is one of THREE hierarchy traversals in this object, and they do not
     * agree — see [getHierarchyForStreaming] and
     * [getHierarchyForStreamingRefreshed]. A client therefore receives a
     * different tree depending on which RPC it calls, and the planner prompt is
     * built from whichever it got. The divergence is documented rather than
     * unified on purpose: unifying it changes what the planner LLM sees, in
     * native code with zero test coverage, and belongs in its own change with
     * evidence. Do not "align" these three without that evidence.
     */
    fun getHierarchy(screenWidth: Int, screenHeight: Int): List<AccNode> {
        val nodeList = mutableListOf<AccNode>()
        val displayRect = getDisplayRect()
        val roots = getWindowRootsFast()
        
        for (root in roots) {
            if (root != null) {
                val rootNodes = processNodeRecursive(root, displayRect, 0)
                nodeList.addAll(rootNodes)
            }
        }
        
        return nodeList
    }

    /**
     * AN UNFILTERED TRAVERSAL over the CACHED window roots
     * (`getWindowRootsFast`). `getJsonArrForNodeInfo` applies no
     * `isVisibleToUser` filter, so this returns a strictly larger tree than
     * [getHierarchy] for the same screen.
     *
     * Despite the name, streaming does NOT use this: callers are
     * `ScreenStreamer.sendHierarchy` (the legacy WebSocket one-off hierarchy
     * message) and `DeviceActions.getHierarchy()`. See [getHierarchy] for the
     * three-way divergence and why it is left in place.
     */
    fun getHierarchyForStreaming(screenWidth: Int, screenHeight: Int): JSONArray {
        val jsonArray = JSONArray()
        val roots = getWindowRootsFast()
        for (root in roots) {
            if (root != null) {
                val nodeInfoJsonArr =
                    getJsonArrForNodeInfo(root, screenWidth, screenHeight) ?: JSONArray()
                for (i in 0 until nodeInfoJsonArr.length()) {
                    jsonArray.put(nodeInfoJsonArr[i])
                }
            }
        }
        return jsonArray
    }

    /**
     * AN UNFILTERED TRAVERSAL over REFRESHED window roots (`getWindowRoots`,
     * which refreshes the accessibility cache first). Same node set as
     * [getHierarchyForStreaming]; the difference is cache freshness, which costs
     * a refresh per call and is why it is reserved for one-off requests.
     *
     * Callers: the gRPC `GetHierarchy` and `GetScreenshotAndHierarchy` RPCs
     * (`DriverServiceImpl`). Those two RPCs therefore return a DIFFERENT tree
     * from the streaming path, which uses the visibility-filtered
     * [getHierarchy] — see its doc comment for the divergence and why it stands.
     */
    fun getHierarchyForStreamingRefreshed(screenWidth: Int, screenHeight: Int): JSONArray {
        val jsonArray = JSONArray()
        val roots = getWindowRoots()
        for (root in roots) {
            if (root != null) {
                val nodeInfoJsonArr =
                    getJsonArrForNodeInfo(root, screenWidth, screenHeight) ?: JSONArray()
                for (i in 0 until nodeInfoJsonArr.length()) {
                    jsonArray.put(nodeInfoJsonArr[i])
                }
            }
        }
        return jsonArray
    }

    private fun getJsonArrForNodeInfo(
        root: AccessibilityNodeInfo,
        screenWidth: Int,
        screenHeight: Int
    ): JSONArray? {
        val uuid = UUID.randomUUID().toString()
        val hierarchyNode = HierarchyNode()
        iterateHierarchy(root, hierarchyNode, uuid, null, 0, screenWidth, screenHeight)

        return try {
            hierarchyNode.getFlattenedHierarchy()
        } catch (e: JSONException) {
            debugLog(msg = e.message.toString())
            null
        }
    }

    private fun getListOfAccNode(
        root: AccessibilityNodeInfo,
        screenWidth: Int,
        screenHeight: Int
    ): List<AccNode> {
        val uuid = UUID.randomUUID().toString()
        val hierarchyNode = HierarchyNode()
        iterateHierarchy(root, hierarchyNode, uuid, null, 0, screenWidth, screenHeight)
        return hierarchyNode.flattenedNode
    }

    /**
     * Required an object of HierarchyNode which is helpful to identify matching bounds
     */
    fun getHierarchyNode(screenWidth: Int, screenHeight: Int): HierarchyNode {
        val hierarchyNode = HierarchyNode()
        val roots = getWindowRoots()
        for (root in roots) {
            if (root != null) {
                val uuid = UUID.randomUUID().toString()
                iterateHierarchy(root, hierarchyNode, uuid, null, 0, screenWidth, screenHeight)
            }
        }
        return hierarchyNode
    }



//    private fun printAccActiveWindows(windows: List<AccessibilityWindowInfo>?) {
//        if (windows.isNullOrEmpty()) return
//        val accWindowList: MutableList<AccWindow> = ArrayList()
//        for (windowInfo in windows) {
//            if (!windowInfo.isActive) continue
//            val accWindow = AccWindow()
//            val bounds = Rect()
//            windowInfo.getBoundsInScreen(bounds)
//            accWindow.bounds = bounds
//            accWindow.isFocused = windowInfo.isFocused
//            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
//                accWindow.isInPictureInPictureMode = windowInfo.isInPictureInPictureMode
//            }
//            val root: AccessibilityNodeInfo = windowInfo.root
//            val accNode = AccNode()
////            iterateHierarchy(root, accNode, screenWidth, screenHeight)
//            accWindow.accNode = accNode
//            accWindowList.add(accWindow)
//        }
//        try {
//            val jsonArray = JSONArray()
//            for (accWindow in accWindowList) {
//                jsonArray.put(accWindow.toJSON())
//            }
//            debugLog(msg = jsonArray.toString())
//        } catch (e: Exception) {
//            e.printStackTrace()
//        }
//    }

    private fun iterateHierarchy(
        nodeInfo: AccessibilityNodeInfo?,
        hierarchyNode: HierarchyNode,
        uuid: String,
        parentUUID: String?,
        nodeIndex: Int,
        screenWidth: Int,
        screenHeight: Int
    ) {
        if (nodeInfo == null) return
        addAllAccNodeInfo(
            nodeInfo,
            hierarchyNode,
            uuid,
            parentUUID,
            nodeIndex,
            screenWidth,
            screenHeight
        )

        val childCount: Int = nodeInfo.childCount
        if (childCount > 0) {
            for (i in 0 until childCount) {
                val child: AccessibilityNodeInfo = nodeInfo.getChild(i) ?: continue
                val childUUID = UUID.randomUUID().toString()
                iterateHierarchy(
                    child,
                    hierarchyNode,
                    childUUID,
                    uuid,
                    nodeIndex,
                    screenWidth,
                    screenHeight
                )
                val accNode = hierarchyNode.flattenedNodeMap[uuid] ?: continue
                (accNode.children as ArrayList<String>).add(childUUID)
            }
        }
    }

    private fun isOutBound(bounds: Rect?, screenWidth: Int, screenHeight: Int): Boolean {
        if (bounds == null) return true
        return bounds.right <= 0 || bounds.left >= screenWidth || bounds.top >= screenHeight || bounds.bottom <= 0
    }

    private fun addAllAccNodeInfo(
        nodeInfo: AccessibilityNodeInfo?,
        hierarchyNode: HierarchyNode,
        uuid: String,
        parentUUID: String?,
        nodeIndex: Int,
        screenWidth: Int,
        screenHeight: Int
    ) {
        if (nodeInfo != null) {
            val bounds = Rect()
            nodeInfo.getBoundsInScreen(bounds)
            if (bounds.width() <= 0 || bounds.height() <= 0) return
            if (isOutBound(bounds, screenWidth, screenHeight)) return

            val accNode = AccNode()
            accNode.bounds = bounds
            accNode.uuid = uuid
            accNode.parentId = parentUUID
            accNode.nodeIndex = nodeIndex

            hierarchyNode.flattenedNodeMap[uuid] = accNode
            hierarchyNode.flattenedNode += (accNode)

            accNode.id = nodeInfo.viewIdResourceName
            if (nodeInfo.className != null) accNode.clazz = nodeInfo.className.toString()

            val contentDescription: CharSequence? = nodeInfo.contentDescription
            accNode.contentDescription = contentDescription?.toString()
            accNode.isSelected = nodeInfo.isSelected
            accNode.isClickable = nodeInfo.isClickable
            accNode.isCheckable = nodeInfo.isCheckable
            accNode.isChecked = nodeInfo.isChecked
            accNode.isDismissible = nodeInfo.isDismissable
            accNode.isEditable = nodeInfo.isEditable
            accNode.isPassword = nodeInfo.isPassword
            accNode.isEnabled = nodeInfo.isEnabled
            accNode.isFocused = nodeInfo.isFocused
            accNode.isLongClickable = nodeInfo.isLongClickable
            accNode.isScrollable = nodeInfo.isScrollable
            accNode.isMultiLine = nodeInfo.isMultiLine
            accNode.isContextClickable = nodeInfo.isContextClickable
            accNode.isVisibleToUser = nodeInfo.isVisibleToUser
            val error: CharSequence? = nodeInfo.error
            accNode.error = error?.toString()
            accNode.inputType = nodeInfo.inputType
//            val collectionInfo: AccessibilityNodeInfo.CollectionInfo? = nodeInfo.collectionInfo
//            if (collectionInfo != null) {
//                accNode.collectionColumnCount = collectionInfo.columnCount
//                accNode.collectionRowCount = collectionInfo.rowCount
//                accNode.collectionIsHierarchical = collectionInfo.isHierarchical
//            }
            accNode.maxTextLength = nodeInfo.maxTextLength
//            val collectionItemInfo: AccessibilityNodeInfo.CollectionItemInfo? =
//                nodeInfo.collectionItemInfo
//            if (collectionItemInfo != null) {
//                accNode.collectionColumnIndex = collectionItemInfo.columnIndex
//                accNode.collectionRowIndex = collectionItemInfo.rowIndex
//                accNode.collectionIsSelected = collectionItemInfo.isSelected
//                accNode.collectionIsHeading = collectionItemInfo.isHeading
//                accNode.collectionColumnSpan = collectionItemInfo.columnSpan
//                accNode.collectionRowSpan = collectionItemInfo.rowSpan
//            }

            val text: CharSequence? = nodeInfo.text
            accNode.text = text?.toString()
            val packageName: CharSequence? = nodeInfo.packageName
            accNode.packaze = packageName?.toString()
        }
    }

    fun getCurrentFocusedNodeText(): String? {
        val hierarchy = getHierarchy(DeviceCache.getScreenWidth(), DeviceCache.getScreenHeight())
        for (accNode in hierarchy) {
            if (accNode.isFocused) return accNode.text
        }
        return null
    }

    private fun refreshAccessibilityCache() {
        try {
            DeviceCache.uiDevice.waitForIdle(500)
            InstrumentationRegistry.getInstrumentation().uiAutomation.serviceInfo = null
        } catch (_: NullPointerException) {
        }
    }

    /**
     * Get window roots using reflection with fallback - following Finalrun's approach
     */
    private fun getWindowRootsInternal(refreshCache: Boolean): List<AccessibilityNodeInfo?> {
        if(refreshCache) {
            refreshAccessibilityCache()
        }
        val uiAutomation = InstrumentationRegistry.getInstrumentation().uiAutomation

        return try {
            DeviceCache.uiDevice.javaClass
                .getDeclaredMethod("getWindowRoots")
                .apply { isAccessible = true }
                .let {
                    @Suppress("UNCHECKED_CAST")
                    it.invoke(DeviceCache.uiDevice) as Array<AccessibilityNodeInfo>
                }
                .toList()
        } catch (e: Exception) {
            errorLog(LOGTAG, "Unable to call getWindowRoots: ${e.message}")
            listOf(uiAutomation.rootInActiveWindow)
        }
    }

    /**
     * Get display rect following Finalrun's approach
     */
    private fun getDisplayRect(): Rect {
        val windowManager = InstrumentationRegistry.getInstrumentation()
            .context
            .getSystemService(Context.WINDOW_SERVICE) as WindowManager

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.currentWindowMetrics.bounds
        } else {
            val displayMetrics = DisplayMetrics()
            windowManager.defaultDisplay.getRealMetrics(displayMetrics)
            Rect(0, 0, displayMetrics.widthPixels, displayMetrics.heightPixels)
        }
    }

    /**
     * Process node recursively following Finalrun's pattern
     */
    private fun processNodeRecursive(
        node: AccessibilityNodeInfo,
        displayRect: Rect,
        index: Int,
        parentUUID: String? = null,
        insideWebView: Boolean = false
    ): List<AccNode> {
        val nodeList = mutableListOf<AccNode>()

        val accNode = createAccNodeFromNodeInfo(node, displayRect, index, parentUUID)
        if (accNode != null) {
            nodeList.add(accNode)

            val childCount = node.childCount
            for (i in 0 until childCount) {
                val child = node.getChild(i)
                if (child != null) {
                    // Follow Finalrun's visibility logic with WebView handling
                    if (child.isVisibleToUser || insideWebView) {
                        val childNodes = processNodeRecursive(
                            child,
                            displayRect,
                            i,
                            accNode.uuid,
                            insideWebView || child.className == "android.webkit.WebView"
                        )
                        nodeList.addAll(childNodes)

                        val childUUIDs = childNodes.filter { it.parentId == accNode.uuid }.map { it.uuid ?: "" }
                        (accNode.children as ArrayList<String>).addAll(childUUIDs)
                        
                        child.recycle()
                    } else {
//                        Log.i(LOGTAG, "Skipping invisible child: $child")
                    }
                } else {
//                    Log.i(LOGTAG, "Null child $i/$childCount, parent: $node")
                }
            }
        }
        
        return nodeList
    }

    private fun createAccNodeFromNodeInfo(
        nodeInfo: AccessibilityNodeInfo,
        displayRect: Rect,
        nodeIndex: Int,
        parentUUID: String? = null
    ): AccNode? {
        val bounds = getVisibleBoundsInScreen(nodeInfo, displayRect)

        if (bounds == null || bounds.width() <= 0 || bounds.height() <= 0) {
            return null
        }
        
        val accNode = AccNode()
        accNode.bounds = bounds
        accNode.uuid = UUID.randomUUID().toString()
        accNode.parentId = parentUUID
        accNode.nodeIndex = nodeIndex
        
        // Set NAF attribute if applicable
        if (!nafExcludedClass(nodeInfo) && !nafCheck(nodeInfo)) {
            // This node is NAF (Not Accessibility Friendly)
            // You can add a property to AccNode if needed to track this
        }
        
        accNode.id = safeCharSeqToString(nodeInfo.viewIdResourceName)
        accNode.clazz = safeCharSeqToString(nodeInfo.className)
        
        accNode.contentDescription = safeCharSeqToString(nodeInfo.contentDescription)
        accNode.isSelected = nodeInfo.isSelected
        accNode.isClickable = nodeInfo.isClickable
        accNode.isCheckable = nodeInfo.isCheckable
        accNode.isChecked = nodeInfo.isChecked
        accNode.isDismissible = nodeInfo.isDismissable
        accNode.isEditable = nodeInfo.isEditable
        accNode.isPassword = nodeInfo.isPassword
        accNode.isEnabled = nodeInfo.isEnabled
        accNode.isFocused = nodeInfo.isFocused
        accNode.isFocusable = nodeInfo.isFocusable
        accNode.isLongClickable = nodeInfo.isLongClickable
        accNode.isScrollable = nodeInfo.isScrollable
        accNode.isMultiLine = nodeInfo.isMultiLine
        accNode.isContextClickable = nodeInfo.isContextClickable
        accNode.isVisibleToUser = nodeInfo.isVisibleToUser
        
        accNode.error = safeCharSeqToString(nodeInfo.error)
        accNode.inputType = nodeInfo.inputType
        accNode.maxTextLength = nodeInfo.maxTextLength
        
        accNode.text = safeCharSeqToString(nodeInfo.text)
        accNode.packaze = safeCharSeqToString(nodeInfo.packageName)
        
        return accNode
    }

    /**
     * Get visible bounds in screen - copied from Finalrun
     */
    private fun getVisibleBoundsInScreen(node: AccessibilityNodeInfo?, displayRect: Rect): Rect? {
        if (node == null) {
            return null
        }
        val nodeRect = Rect()
        node.getBoundsInScreen(nodeRect)
        return if (nodeRect.intersect(displayRect)) {
            nodeRect
        } else {
            Rect()
        }
    }

    /**
     * Check if class is NAF excluded - copied from Finalrun
     */
    private fun nafExcludedClass(node: AccessibilityNodeInfo): Boolean {
        val className = safeCharSeqToString(node.className)
        for (excludedClassName in NAF_EXCLUDED_CLASSES) {
            if (className.endsWith(excludedClassName)) return true
        }
        return false
    }

    /**
     * NAF check - copied from Finalrun
     */
    private fun nafCheck(node: AccessibilityNodeInfo): Boolean {
        val isNaf = (node.isClickable && node.isEnabled
            && safeCharSeqToString(node.contentDescription).isEmpty()
            && safeCharSeqToString(node.text).isEmpty())
        return if (!isNaf) true else childNafCheck(node)
    }

    /**
     * Child NAF check - copied from Finalrun
     */
    private fun childNafCheck(node: AccessibilityNodeInfo): Boolean {
        val childCount = node.childCount
        for (x in 0 until childCount) {
            val childNode = node.getChild(x)
            if (childNode == null) continue
            if (!safeCharSeqToString(childNode.contentDescription).isEmpty()
                || !safeCharSeqToString(childNode.text).isEmpty()
            ) return true
            if (childNafCheck(childNode)) return true
        }
        return false
    }

    /**
     * Safe char sequence to string - copied from Finalrun
     */
    private fun safeCharSeqToString(cs: CharSequence?): String {
        return cs?.let { stripInvalidXMLChars(it) } ?: ""
    }

    /**
     * Strip invalid XML chars - copied from Finalrun
     */
    @Suppress("ComplexCondition")
    private fun stripInvalidXMLChars(cs: CharSequence): String {
        val ret = StringBuffer()
        var ch: Char
        for (i in 0 until cs.length) {
            ch = cs[i]
            if (ch.code >= 0x1 && ch.code <= 0x8 || ch.code >= 0xB && ch.code <= 0xC || ch.code >= 0xE && ch.code <= 0x1F ||
                ch.code >= 0x7F && ch.code <= 0x84 || ch.code >= 0x86 && ch.code <= 0x9f ||
                ch.code >= 0xFDD0 && ch.code <= 0xFDDF || ch.code >= 0x1FFFE && ch.code <= 0x1FFFF ||
                ch.code >= 0x2FFFE && ch.code <= 0x2FFFF || ch.code >= 0x3FFFE && ch.code <= 0x3FFFF ||
                ch.code >= 0x4FFFE && ch.code <= 0x4FFFF || ch.code >= 0x5FFFE && ch.code <= 0x5FFFF ||
                ch.code >= 0x6FFFE && ch.code <= 0x6FFFF || ch.code >= 0x7FFFE && ch.code <= 0x7FFFF ||
                ch.code >= 0x8FFFE && ch.code <= 0x8FFFF || ch.code >= 0x9FFFE && ch.code <= 0x9FFFF ||
                ch.code >= 0xAFFFE && ch.code <= 0xAFFFF || ch.code >= 0xBFFFE && ch.code <= 0xBFFFF ||
                ch.code >= 0xCFFFE && ch.code <= 0xCFFFF || ch.code >= 0xDFFFE && ch.code <= 0xDFFFF ||
                ch.code >= 0xEFFFE && ch.code <= 0xEFFFF || ch.code >= 0xFFFFE && ch.code <= 0xFFFFF ||
                ch.code >= 0x10FFFE && ch.code <= 0x10FFFF
            ) ret.append(".") else ret.append(ch)
        }
        return ret.toString()
    }

    /**
     * Convert a list of AccNode into a JSONArray without re-traversing the accessibility tree.
     */
    fun toJsonArray(nodes: List<AccNode>): JSONArray {
        val array = JSONArray()
        for (node in nodes) {
            try {
                array.put(node.toJSON())
            } catch (_: JSONException) {
            }
        }
        return array
    }

    /**
     * Original behavior with cache refresh. Use this for one-off queries.
     */
    private fun getWindowRoots(): List<AccessibilityNodeInfo?> = getWindowRootsInternal(true)

    /**
     * Faster variant without cache refresh. Use this inside high-frequency streaming loops.
     */
    private fun getWindowRootsFast(): List<AccessibilityNodeInfo?> = getWindowRootsInternal(false)
}