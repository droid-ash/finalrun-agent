package app.finalrun.android.streaming

import app.finalrun.android.GET_HIERARCHY_FOR_EVERY_FRAME
import app.finalrun.android.action.DeviceActions
import app.finalrun.android.data.ActionResponse
import app.finalrun.android.data.ActionResponseScreenshot
import app.finalrun.android.data.DeviceCache.getScreenHeight
import app.finalrun.android.data.DeviceCache.getScreenWidth
import app.finalrun.android.data.DeviceCache.objectMapper
import app.finalrun.android.data.hierarchy.AccNode
import app.finalrun.android.data.hierarchy.AccessibilityStreamer
import app.finalrun.android.debugLog
import app.finalrun.android.errorLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

import kotlinx.coroutines.launch
import org.java_websocket.WebSocket

object ScreenStreamer {

    private val streamingScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile
    private var isStreamingActive = false

    fun startStreaming(webSocket: WebSocket, frameDelay: Long, quality: Int) {
        stopStreaming()
        isStreamingActive = true
        
        streamingScope.launch {
            if (!isStreamingActive || !isActive) {
                debugLog("startStreaming: Cancelled before starting main loop")
                return@launch
            }
            
            var lastScreenshotHash: Int? = null
            var lastHierarchyNode: List<AccNode>? = null
            var lastHierarchyFrameMessage: String? = null

            debugLog("startStreaming: Starting main streaming loop with frameDelay: ${frameDelay}ms")

            while (isStreamingActive && isActive) {
                try {
                    val screenWidth = getScreenWidth()
                    val screenHeight = getScreenHeight()
                    if (screenWidth <= 0 || screenHeight <= 0) {
                        debugLog("startStreaming: screenWidth or screenHeight is 0, skipping")
                        delay(1000)
                        continue
                    }
                    val screenShotByteArray = DeviceActions.getScreenshotInByteArray(quality)
                    if (screenShotByteArray == null) {
                        debugLog("startStreaming: screenshot not available, skipping")
                        delay(1000)
                        continue
                    }

//                    val screenshot = Base64.encodeToString(screenShotByteArray, Base64.NO_WRAP)
                    val currentScreenshotHash = screenShotByteArray.contentHashCode()
                    // If screenshot hasn't changed since last frame, skip rebuilding hierarchy
                    if (currentScreenshotHash == lastScreenshotHash) {
                        webSocket.send(screenShotByteArray)
                        lastHierarchyFrameMessage?.let { webSocket.send(it) }
                        delay(frameDelay)
                        continue
                    }

                    val currentHierarchyNode = AccessibilityStreamer.getHierarchy(screenWidth, screenHeight)

//                    debugLog("ScreenStreamer: Sending binary screenshot data: ${screenShotByteArray.size} bytes")
                    webSocket.send(screenShotByteArray)
                    // Reuse the already-built hierarchy to avoid a second tree traversal
                    val accHierarchyJson = AccessibilityStreamer.toJsonArray(currentHierarchyNode).toString()
                    val actionResponseHierarchy = ActionResponseScreenshot(
                        screenWidth = screenWidth,
                        screenHeight = screenHeight,
                        hierarchy = accHierarchyJson
                    )
                    val actionResponse = ActionResponse(
                        type = GET_HIERARCHY_FOR_EVERY_FRAME,
                        success = true,
                        data = actionResponseHierarchy
                    )
                    val hierarchyJson = objectMapper.writeValueAsString(actionResponse)
                    if (hierarchyJson.isEmpty()) {
                        errorLog("ScreenStreamer: CRITICAL - Hierarchy JSON is empty! ActionResponse: $actionResponse")
                    } else {
                        webSocket.send(hierarchyJson)
                        lastHierarchyFrameMessage = hierarchyJson
                    }

                    lastScreenshotHash = currentScreenshotHash
                    lastHierarchyNode = currentHierarchyNode

                } catch (e: Exception) {
                    debugLog("startStreaming: Exception: ${e.message}")
                }
                delay(frameDelay)
            }
        }
    }

    private fun sendHierarchy(
        webSocket: WebSocket,
        screenWidth: Int,
        screenHeight: Int
    ) {
        val accHierarchy =
            AccessibilityStreamer.getHierarchyForStreaming(screenWidth, screenHeight)

        val actionResponseHierarchy = ActionResponseScreenshot(
            screenWidth = screenWidth,
            screenHeight = screenHeight,
            hierarchy = accHierarchy.toString()
        )
        val actionResponse = ActionResponse(
            type = GET_HIERARCHY_FOR_EVERY_FRAME,
            success = true,
            data = actionResponseHierarchy
        )

        val hierarchyJson = objectMapper.writeValueAsString(actionResponse)
//        debugLog("ScreenStreamer: Sending hierarchy JSON length: ${hierarchyJson.length}")
        
        if (hierarchyJson.isEmpty()) {
            errorLog("ScreenStreamer: CRITICAL - Hierarchy JSON is empty! ActionResponse: $actionResponse")
            errorLog("ScreenStreamer: Hierarchy string length: ${accHierarchy.toString().length}")
            return
        }
        
        webSocket.send(hierarchyJson)
    }

    fun stopStreaming() {
        try {
            debugLog("ScreenStreamer: Stopping streaming...")
            // The flag must go false BEFORE cancelChildren(): a coroutine already
            // launched by startStreaming but not yet past its isStreamingActive
            // guard then bails out there instead of entering the streaming loop.
            isStreamingActive = false
            streamingScope.coroutineContext.cancelChildren()
            // Add a small delay to ensure coroutines are fully cancelled
            // This helps prevent race conditions when quickly stopping and starting
            Thread.sleep(50)
            debugLog("ScreenStreamer: Streaming stopped")
        } catch (e: Exception) {
            errorLog("ScreenStreamer: stopStreaming() exception: ${e.message}")
        }
    }
}
