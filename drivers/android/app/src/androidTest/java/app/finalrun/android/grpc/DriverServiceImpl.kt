package app.finalrun.android.grpc

import android.content.res.Resources
import app.finalrun.android.action.DeviceActions
import app.finalrun.android.action.DeviceActions.DEFAULT_QUALITY
import app.finalrun.android.action.DeviceActions.getCurrentOrientation
import app.finalrun.android.action.DeviceActions.tap
import app.finalrun.android.calculateFrameDelay
import app.finalrun.android.data.DeviceCache.context
import app.finalrun.android.data.DeviceCache.getScreenHeight
import app.finalrun.android.data.DeviceCache.getScreenWidth
import app.finalrun.android.data.SetLocationAction
import app.finalrun.android.data.SingleArgument
import app.finalrun.android.data.hierarchy.AccessibilityStreamer
import app.finalrun.android.debugLog
import app.finalrun.android.errorLog
import app.finalrun.android.getXYPercentOnScreen
import app.finalrun.android.streaming.ScreenStreamer
import com.google.protobuf.ByteString
import io.grpc.stub.StreamObserver
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * gRPC service implementation for the Android driver.
 *
 * Handles all incoming RPC calls from the TypeScript client
 * (packages/device-node).
 * Each method corresponds to an action that can be performed on the device.
 */
class DriverServiceImpl : DriverServiceGrpc.DriverServiceImplBase() {

    private val isStreaming = AtomicBoolean(false)
    
    // Coroutine scope for streaming operations (uses SupervisorJob so child failures don't cancel the scope)
    private val streamingScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    
    // Current streaming job (tracked for graceful shutdown)
    private var streamingJob: Job? = null

    // ==========================================================================
    // Device Interaction Actions
    // ==========================================================================

    override fun tap(request: TapRequest, responseObserver: StreamObserver<TapResponse>) {
        debugLog("gRPC: Processing Tap at x=${request.point.x}, y=${request.point.y}")
        try {
            tap(request.point.x, request.point.y)
            val response = TapResponse.newBuilder()
                .setSuccess(true)
                .setX(request.point.x)
                .setY(request.point.y)
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            errorLog("gRPC: Tap failed: ${e.message}")
            val response = TapResponse.newBuilder()
                .setSuccess(false)
                .setMessage("Tap failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun tapPercent(request: TapPercentRequest, responseObserver: StreamObserver<TapResponse>) {
        debugLog("gRPC: Processing TapPercent at xP=${request.point.xPercent}, yP=${request.point.yPercent}")
        try {
            val (x, y) = getXYPercentOnScreen(request.point.xPercent, request.point.yPercent)
                ?: throw Exception("Failed to calculate screen coordinates from percentage")
            tap(x, y)
            val response = TapResponse.newBuilder()
                .setSuccess(true)
                .setX(x)
                .setY(y)
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            errorLog("gRPC: TapPercent failed: ${e.message}")
            val response = TapResponse.newBuilder()
                .setSuccess(false)
                .setMessage("TapPercent failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun enterText(request: EnterTextRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing EnterText: value=${request.value}, shouldErase=${request.shouldEraseText}")
        try {
            val eraseCount = if (request.hasEraseCount()) request.eraseCount else 100
            DeviceActions.enterText(request.value, request.shouldEraseText, eraseCount)
            sendSuccessResponse(responseObserver)
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "EnterText failed: ${e.message}")
        }
    }

    override fun eraseText(request: EraseTextRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing EraseText")
        try {
            DeviceActions.clearTextFromFocusNode(100)
            sendSuccessResponse(responseObserver)
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "EraseText failed: ${e.message}")
        }
    }

    override fun copyText(request: CopyTextRequest, responseObserver: StreamObserver<ActionResponse>) {
        sendErrorResponse(responseObserver, "CopyText not implemented in Android driver")
    }

    override fun pasteText(request: PasteTextRequest, responseObserver: StreamObserver<ActionResponse>) {
        sendErrorResponse(responseObserver, "PasteText not implemented in Android driver")
    }

    override fun back(request: BackRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing Back")
        try {
            val success = DeviceActions.pressBackButton()
            if (success) {
                sendSuccessResponse(responseObserver)
            } else {
                sendErrorResponse(responseObserver, "Back button press failed")
            }
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "Back failed: ${e.message}")
        }
    }

    override fun home(request: HomeRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing Home")
        try {
            val success = DeviceActions.goToHomeScreen()
            if (success) {
                sendSuccessResponse(responseObserver)
            } else {
                sendErrorResponse(responseObserver, "Home button press failed")
            }
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "Home failed: ${e.message}")
        }
    }

    override fun rotate(request: RotateRequest, responseObserver: StreamObserver<RotateResponse>) {
        debugLog("gRPC: Processing Rotate")
        try {
            val success = DeviceActions.rotate()
            val orientation = getCurrentOrientation()
            val response = RotateResponse.newBuilder()
                .setSuccess(success)
                .setOrientation(orientation)
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            val response = RotateResponse.newBuilder()
                .setSuccess(false)
                .setMessage("Rotate failed: ${e.message}")
                .setOrientation("unknown")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun hideKeyboard(request: HideKeyboardRequest, responseObserver: StreamObserver<ActionResponse>) {
        sendErrorResponse(responseObserver, "HideKeyboard not implemented in Android driver")
    }

    override fun pressKey(request: PressKeyRequest, responseObserver: StreamObserver<ActionResponse>) {
        sendErrorResponse(responseObserver, "PressKey not implemented in Android driver")
    }

    // ==========================================================================
    // App Management
    // ==========================================================================

    override fun launchApp(request: LaunchAppRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing LaunchApp: packageName=${request.appUpload.packageName}")
        try {
            val arguments: Map<String, SingleArgument?> = request.argumentsMap.mapValues { (_, v) ->
                SingleArgument(type = v.type, value = v.value)
            }
            val res = DeviceActions.launchApp(
                request.appUpload.packageName,
                arguments
            )
            if (res.first) {
                sendSuccessResponse(responseObserver, res.second)
            } else {
                sendErrorResponse(responseObserver, res.second ?: "Launch failed")
            }
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "LaunchApp failed: ${e.message}")
        }
    }

    override fun killApp(request: KillAppRequest, responseObserver: StreamObserver<ActionResponse>) {
        sendErrorResponse(responseObserver, "KillApp not implemented in Android driver")
    }

    override fun switchToPrimaryApp(request: SwitchToPrimaryAppRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing SwitchToPrimaryApp: packageName=${request.packageName}")
        try {
            val res = DeviceActions.switchToPrimaryApp(request.packageName)
            if (res.first) {
                sendSuccessResponse(responseObserver, res.second)
            } else {
                sendErrorResponse(responseObserver, res.second ?: "Switch to primary app failed")
            }
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "SwitchToPrimaryApp failed: ${e.message}")
        }
    }

    override fun checkAppInForeground(request: CheckAppInForegroundRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing CheckAppInForeground: packageName=${request.packageName}")
        try {
            val timeout = request.timeoutSeconds * 1000L
            val success = DeviceActions.waitForAppLaunch(
                targetPackage = request.packageName,
                timeoutMs = timeout
            )
            if (success) {
                sendSuccessResponse(responseObserver, "App launched successfully")
            } else {
                sendErrorResponse(responseObserver, "Failed to launch app")
            }
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "CheckAppInForeground failed: ${e.message}")
        }
    }

    override fun getAppList(request: GetAppListRequest, responseObserver: StreamObserver<AppListResponse>) {
        debugLog("gRPC: Processing GetAppList")
        try {
            val appListJson = DeviceActions.getAppList(context)
            val builder = AppListResponse.newBuilder()
                .setSuccess(true)

            for (i in 0 until appListJson.length()) {
                val app = appListJson.getJSONObject(i)
                val appInfoBuilder = DeviceAppInfo.newBuilder()
                    .setPackageName(app.getString("packageName"))
                    .setName(app.getString("name"))

                if (app.has("version") && !app.isNull("version")) {
                    appInfoBuilder.version = app.getString("version")
                }

                builder.addApps(appInfoBuilder.build())
            }

            responseObserver.onNext(builder.build())
            responseObserver.onCompleted()
        } catch (e: Exception) {
            val response = AppListResponse.newBuilder()
                .setSuccess(false)
                .setMessage("GetAppList failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun updateAppIds(request: UpdateAppIdsRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing UpdateAppIds: ${request.appIdsList}")
        // This is primarily used for iOS, but acknowledge it for Android
        sendSuccessResponse(responseObserver, "App IDs updated")
    }

    // ==========================================================================
    // Device Info
    // ==========================================================================

    override fun getDeviceScale(request: GetDeviceScaleRequest, responseObserver: StreamObserver<DeviceScaleResponse>) {
        debugLog("gRPC: Processing GetDeviceScale")
        try {
            val scale = Resources.getSystem().displayMetrics.density
            val response = DeviceScaleResponse.newBuilder()
                .setSuccess(true)
                .setScale(scale)
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            val response = DeviceScaleResponse.newBuilder()
                .setSuccess(false)
                .setMessage("GetDeviceScale failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun getScreenDimension(request: GetScreenDimensionRequest, responseObserver: StreamObserver<ScreenDimensionResponse>) {
        debugLog("gRPC: Processing GetScreenDimension")
        try {
            val response = ScreenDimensionResponse.newBuilder()
                .setSuccess(true)
                .setScreenWidth(getScreenWidth())
                .setScreenHeight(getScreenHeight())
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            val response = ScreenDimensionResponse.newBuilder()
                .setSuccess(false)
                .setMessage("GetScreenDimension failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun setLocation(request: SetLocationRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing SetLocation: lat=${request.latitude}, long=${request.longitude}")
        try {
            val setLocationAction = SetLocationAction(
                lat = request.latitude,
                long = request.longitude,
                requestId = "grpc-set-location"
            )
            DeviceActions.setLocation(setLocationAction)
            sendSuccessResponse(responseObserver)
        } catch (e: Exception) {
            sendErrorResponse(responseObserver, "SetLocation failed: ${e.message}")
        }
    }

    // ==========================================================================
    // Screenshot and Hierarchy
    // ==========================================================================

    override fun getScreenshot(request: GetScreenshotRequest, responseObserver: StreamObserver<ScreenshotResponse>) {
        debugLog("gRPC: Processing GetScreenshot")
        try {
            val quality = if (request.hasQuality()) request.quality else DEFAULT_QUALITY
            val screenshot = DeviceActions.getScreenshotInBase64(quality = quality)
            val response = ScreenshotResponse.newBuilder()
                .setSuccess(true)
                .setScreenshot(screenshot)
                .setScreenWidth(getScreenWidth())
                .setScreenHeight(getScreenHeight())
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            val response = ScreenshotResponse.newBuilder()
                .setSuccess(false)
                .setMessage("GetScreenshot failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    /**
     * Get raw screenshot bytes (no base64 encoding).
     * 
     * Optimized for comparison-only scenarios like stability checking where base64
     * encoding/decoding overhead is wasteful. Returns raw JPEG bytes directly.
     * 
     * Performance benefit: ~140-245ms savings per stability check (4 screenshots)
     * - Eliminates base64 encoding on device (~5-10ms per screenshot)
     * - Reduces gRPC transfer size by ~33%
     * - Eliminates base64 decoding on client (~30-50ms per screenshot)
     */
    override fun getRawScreenshot(request: GetRawScreenshotRequest, responseObserver: StreamObserver<RawScreenshotResponse>) {
        debugLog("gRPC: Processing GetRawScreenshot")
        try {
            val quality = if (request.hasQuality()) request.quality else DEFAULT_QUALITY
            val screenshotBytes = DeviceActions.getScreenshotInByteArray(quality = quality)
            
            if (screenshotBytes == null) {
                val response = RawScreenshotResponse.newBuilder()
                    .setSuccess(false)
                    .setMessage("Failed to capture screenshot")
                    .build()
                responseObserver.onNext(response)
                responseObserver.onCompleted()
                return
            }

            val response = RawScreenshotResponse.newBuilder()
                .setSuccess(true)
                .setScreenshot(ByteString.copyFrom(screenshotBytes))
                .setScreenWidth(getScreenWidth())
                .setScreenHeight(getScreenHeight())
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            val response = RawScreenshotResponse.newBuilder()
                .setSuccess(false)
                .setMessage("GetRawScreenshot failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun getHierarchy(request: GetHierarchyRequest, responseObserver: StreamObserver<ScreenshotResponse>) {
        debugLog("gRPC: Processing GetHierarchy")
        try {
            val screenWidth = getScreenWidth()
            val screenHeight = getScreenHeight()
            val hierarchy = AccessibilityStreamer.getHierarchyForStreamingRefreshed(screenWidth, screenHeight)
            val response = ScreenshotResponse.newBuilder()
                .setSuccess(true)
                .setHierarchy(hierarchy.toString())
                .setScreenWidth(screenWidth)
                .setScreenHeight(screenHeight)
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        } catch (e: Exception) {
            val response = ScreenshotResponse.newBuilder()
                .setSuccess(false)
                .setMessage("GetHierarchy failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    override fun getScreenshotAndHierarchy(request: GetScreenshotAndHierarchyRequest, responseObserver: StreamObserver<ScreenshotResponse>) {
        debugLog("gRPC: Processing GetScreenshotAndHierarchy")
        try {
            val quality = if (request.hasQuality()) request.quality else DEFAULT_QUALITY
            val screenWidth = getScreenWidth()
            val screenHeight = getScreenHeight()
            
            // OPTIMIZATION: Fetch screenshot and hierarchy in parallel using coroutines
            // Note: runBlocking is acceptable here for request-response RPC that must wait for results
            runBlocking {
                val hierarchyDeferred = async(Dispatchers.Default) {
                    AccessibilityStreamer.getHierarchyForStreamingRefreshed(screenWidth, screenHeight)
                }
                
                val screenshotDeferred = async(Dispatchers.Default) {
                    DeviceActions.getScreenshotInBase64(quality = quality)
                }
                
                val hierarchy = hierarchyDeferred.await()
                val screenshot = screenshotDeferred.await()
                
                val deviceTime = java.time.ZonedDateTime.now().format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
                val timezone = java.util.TimeZone.getDefault().id

                val response = ScreenshotResponse.newBuilder()
                    .setSuccess(true)
                    .setScreenshot(screenshot)
                    .setHierarchy(hierarchy.toString())
                    .setScreenWidth(screenWidth)
                    .setScreenHeight(screenHeight)
                    .setDeviceTime(deviceTime)
                    .setTimezone(timezone)
                    .build()
                responseObserver.onNext(response)
                responseObserver.onCompleted()
            }
        } catch (e: Exception) {
            val response = ScreenshotResponse.newBuilder()
                .setSuccess(false)
                .setMessage("GetScreenshotAndHierarchy failed: ${e.message}")
                .build()
            responseObserver.onNext(response)
            responseObserver.onCompleted()
        }
    }

    // ==========================================================================
    // Streaming
    // ==========================================================================

    override fun startStreaming(request: StartStreamingRequest, responseObserver: StreamObserver<StreamFrame>) {
        val fps = if (request.hasFps()) request.fps else 24
        val quality = if (request.hasQuality()) request.quality else DEFAULT_QUALITY
        val frameDelay = calculateFrameDelay(fps)

        debugLog("gRPC: Starting streaming with fps=$fps, quality=$quality, frameDelay=$frameDelay")
        
        streamingJob?.cancel()
        isStreaming.set(true)

        streamingJob = streamingScope.launch {
            var lastScreenshotHash: Int? = null
            var lastHierarchyJson: String? = null
            
            try {
                while (isStreaming.get() && isActive) {
                    try {
                        val screenWidth = getScreenWidth()
                        val screenHeight = getScreenHeight()
                        
                        if (screenWidth <= 0 || screenHeight <= 0) {
                            delay(1000)
                            continue
                        }
                        
                        val screenshotBytes = DeviceActions.getScreenshotInByteArray(quality)
                        if (screenshotBytes == null) {
                            delay(frameDelay)
                            continue
                        }
                        
                        val currentScreenshotHash = screenshotBytes.contentHashCode()
                        
                        val frameBuilder = StreamFrame.newBuilder()
                            .setImageData(ByteString.copyFrom(screenshotBytes))
                            .setScreenWidth(screenWidth)
                            .setScreenHeight(screenHeight)
                        
                        // If screenshot changed, get new hierarchy; otherwise reuse last one
                        if (currentScreenshotHash != lastScreenshotHash) {
                            val hierarchyNodes = AccessibilityStreamer.getHierarchy(screenWidth, screenHeight)
                            val hierarchyJson = AccessibilityStreamer.toJsonArray(hierarchyNodes).toString()
                            lastHierarchyJson = hierarchyJson
                            lastScreenshotHash = currentScreenshotHash
                        }
                        
                        if (lastHierarchyJson != null) {
                            frameBuilder.setHierarchy(lastHierarchyJson)
                        }

                        responseObserver.onNext(frameBuilder.build())
                        delay(frameDelay)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        errorLog("gRPC: Streaming error: ${e.message}")
                        break
                    }
                }
            } finally {
                debugLog("gRPC: Streaming ended")
                try {
                    responseObserver.onCompleted()
                } catch (e: Exception) {
                    // Ignore errors on completion
                }
            }
        }
    }

    override fun stopStreaming(request: StopStreamingRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing StopStreaming")
        isStreaming.set(false)
        
        streamingJob?.let { job ->
            streamingScope.launch {
                // Give 500ms for graceful shutdown, then force cancel
                withTimeoutOrNull(500) { job.join() }
                if (job.isActive) {
                    debugLog("gRPC: Forcibly cancelling streaming job")
                    job.cancel()
                }
                streamingJob = null
            }
        }
        
        ScreenStreamer.stopStreaming()
        sendSuccessResponse(responseObserver)
    }

    override fun stopExecution(request: StopExecutionRequest, responseObserver: StreamObserver<ActionResponse>) {
        debugLog("gRPC: Processing StopExecution")
        isStreaming.set(false)
        streamingJob?.cancel()
        sendSuccessResponse(responseObserver)
    }
    
    /**
     * Cleanup all streaming resources. Should be called when the service is being destroyed.
     * This cancels the streaming scope and all coroutines running within it.
     */
    fun cleanup() {
        debugLog("gRPC: DriverServiceImpl cleanup called")
        isStreaming.set(false)
        streamingScope.cancel()
    }

    // ==========================================================================
    // Helper Methods
    // ==========================================================================

    private fun sendSuccessResponse(responseObserver: StreamObserver<ActionResponse>, message: String? = null) {
        val builder = ActionResponse.newBuilder().setSuccess(true)
        message?.let { builder.setMessage(it) }
        responseObserver.onNext(builder.build())
        responseObserver.onCompleted()
    }

    private fun sendErrorResponse(responseObserver: StreamObserver<ActionResponse>, message: String) {
        errorLog("gRPC: $message")
        val response = ActionResponse.newBuilder()
            .setSuccess(false)
            .setMessage(message)
            .build()
        responseObserver.onNext(response)
        responseObserver.onCompleted()
    }
}
