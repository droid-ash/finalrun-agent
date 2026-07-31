package app.finalrun.android.action

import android.content.Context
import android.content.Context.LOCATION_SERVICE
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Point
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.location.LocationProvider
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import androidx.test.uiautomator.clickNoSync
import app.finalrun.android.NAME
import app.finalrun.android.PACKAGE_NAME
import app.finalrun.android.data.DeviceCache
import app.finalrun.android.data.DeviceCache.context
import app.finalrun.android.data.DeviceCache.getScreenHeight
import app.finalrun.android.data.DeviceCache.getScreenWidth
import app.finalrun.android.data.DeviceCache.uiAutomation
import app.finalrun.android.data.DeviceCache.uiDevice
import app.finalrun.android.data.SetLocationAction
import app.finalrun.android.data.SingleArgument
import app.finalrun.android.data.hierarchy.AccessibilityStreamer
import app.finalrun.android.debugLog
import app.finalrun.android.errorLog
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import android.util.Base64
import app.finalrun.android.VERSION

object DeviceActions {

    private const val DATA_TYPE_STRING = "String"
    private const val DATA_TYPE_BOOLEAN = "Boolean"
    private const val DATA_BOOL_TRUE = "true"
    private const val DATA_BOOL_FALSE = "false"
    private const val DATA_TYPE_DECIMAL = "Decimal"
    private const val DATA_TYPE_INTEGER = "Integer"

    const val DEFAULT_QUALITY = 5
    const val SCREENSHOT_SCALE = 0.7f // Scaled down to improve performance
    private const val FINAL_RUN_ANDROID = "app.finalrun.android"
    private const val FINAL_RUN_ANDROID_TEST = "app.finalrun.android.test"

    //Default values for scroll action
    internal const val SCROLL_DOWN_X = 60
    internal const val SCROLL_DOWN_FROM = 60
    internal const val SCROLL_DOWN_TO = 10

    internal const val SCROLL_UP_X = 60
    internal const val SCROLL_UP_FROM = 20
    internal const val SCROLL_UP_TO = 90

    internal const val SCROLL_RIGHT_Y = 60
    internal const val SCROLL_RIGHT_FROM = 90
    internal const val SCROLL_RIGHT_TO = 10

    internal const val SCROLL_LEFT_Y = 60
    internal const val SCROLL_LEFT_FROM = 10
    internal const val SCROLL_LEFT_TO = 90

    private val geoHandler = Handler(Looper.getMainLooper())
    private var locationCounter = 0

    val windowManager: WindowManager by lazy {
        context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    }

    fun getAppList(context: Context): JSONArray {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        val apps = pm.queryIntentActivities(intent, 0)

        val jsonArray = JSONArray()
        for (resolveInfo in apps) {
            val pkgName = resolveInfo.activityInfo.packageName
            if (pkgName == FINAL_RUN_ANDROID || pkgName == FINAL_RUN_ANDROID_TEST) continue

            val label = resolveInfo.activityInfo.loadLabel(pm).toString()

            val version = try {
                val info = pm.getPackageInfo(pkgName, 0)
                info.versionName
            } catch (_: PackageManager.NameNotFoundException) {
            }

            val jsonObjApp = JSONObject().apply {
                put(NAME, label)
                put(PACKAGE_NAME, pkgName)
                put(VERSION, version)
            }
            jsonArray.put(jsonObjApp)
        }
        return jsonArray
    }

    /**
     * Returns the JPEG bytes of the screenshot, taken via instrumentation test
     */
    fun getScreenshotInByteArray(quality: Int = DEFAULT_QUALITY, scale: Float = SCREENSHOT_SCALE): ByteArray? {
        try {
            val bitmap: Bitmap = uiAutomation.takeScreenshot() ?: return null
            val scaledBitmap = scaleDownBitmap(bitmap, scale)
            val result = convertBitmapToByteArray(scaledBitmap, quality)
            if (scaledBitmap !== bitmap) {
                scaledBitmap.recycle()
            }
            bitmap.recycle()
            return result
        } catch (e: Throwable) {
            return null
        }
    }

    /**
     * Returns the Base64 of the screenshot, taken via instrumentation test
     */
    fun getScreenshotInBase64(quality: Int = DEFAULT_QUALITY, scale: Float = SCREENSHOT_SCALE): String? {
        try {
            val bitmap: Bitmap = uiAutomation.takeScreenshot() ?: return null
            val scaledBitmap = scaleDownBitmap(bitmap, scale)
            val result = encodeImage(scaledBitmap, quality)
            if (scaledBitmap !== bitmap) {
                scaledBitmap.recycle()
            }
            bitmap.recycle()
            return result
        } catch (e: Exception) {
            return null
        }
    }

    fun waitForIdle(idleTimeoutMillis: Long = 1000, globalTimeoutMillis: Long = 5000) {
        try {
            debugLog("waitForIdle: started")
            uiAutomation.waitForIdle(idleTimeoutMillis, globalTimeoutMillis)
        } catch (e: Exception) {
            errorLog("waitForIdle: UI did not become idle within the specified time: $e")
        } finally {
            debugLog("waitForIdle: ended")
        }
    }

    /**
     * Scales the bitmap down to shrink screenshot payloads before encoding
     * @param scale Scale factor (e.g., 0.5 = 50% size)
     * @return Scaled bitmap (or original if scale >= 1.0)
     */
    private fun scaleDownBitmap(bitmap: Bitmap, scale: Float): Bitmap {
        if (scale >= 1.0f) {
            return bitmap
        }
        
        val width = (bitmap.width * scale).toInt()
        val height = (bitmap.height * scale).toInt()
        
        debugLog("Screenshot: Scaling from ${bitmap.width}x${bitmap.height} to ${width}x${height} (scale=$scale)")
        
        return Bitmap.createScaledBitmap(bitmap, width, height, false)
    }

    private fun convertBitmapToByteArray(bitmap: Bitmap, quality: Int): ByteArray {
        val stream = ByteArrayOutputStream()
        val normalizedQuality = quality.coerceIn(0, 100)
        bitmap.compress(Bitmap.CompressFormat.JPEG, normalizedQuality, stream)
        return stream.toByteArray()
    }

    private fun encodeImage(bm: Bitmap, quality: Int): String {
        val b = convertBitmapToByteArray(bm, quality)
        return Base64.encodeToString(b, Base64.NO_WRAP)
//        debugLog("Screenshot: Bitmap size: ${bm.width}x${bm.height}, ByteArray size: ${b.size} bytes, Quality: $quality")

//        val base64String = Base64.encodeToString(b, Base64.NO_WRAP)
//        debugLog("Screenshot: Base64 string length: ${base64String.length}")

        // Validate that the Base64 string is valid UTF-8
//        try {
//            val utf8Bytes = base64String.toByteArray(Charsets.UTF_8)
//            val reconstructed = String(utf8Bytes, Charsets.UTF_8)
//            if (reconstructed != base64String) {
//                errorLog("Screenshot: UTF-8 validation failed! Original and reconstructed strings don't match")
//                errorLog("Screenshot: Original length: ${base64String.length}, Reconstructed length: ${reconstructed.length}")
//            } else {
////                debugLog("Screenshot: UTF-8 validation passed")
//            }
//        } catch (e: Exception) {
//            errorLog("Screenshot: UTF-8 validation exception: ${e.message}")
//        }

        // Additional Base64 validation
//        try {
//            Base64.decode(base64String, Base64.NO_WRAP)
////            debugLog("Screenshot: Base64 validation passed")
//        } catch (e: Exception) {
//            errorLog("Screenshot: Base64 validation failed: ${e.message}")
//        }
//
//        return base64String
    }

    fun getHierarchy() =
        AccessibilityStreamer.getHierarchyForStreaming(getScreenWidth(), getScreenHeight())

    fun tap(x: Int, y: Int): Boolean = uiDevice.clickNoSync(x, y)

    fun enterText(text: String, shouldClearText: Boolean, eraseCount: Int) {
        if (shouldClearText) clearTextFromFocusNode(eraseCount)

        // Command-injection guard: the fast path below interpolates the text into
        // an ADB shell command line ("input text ..."), so it is taken only when
        // every character is plain ASCII (code < 128) and none is a shell
        // metacharacter. Without this gate, test-controlled text containing `;`,
        // `$(...)`, backticks or quotes could be reinterpreted as command syntax
        // rather than typed literally (how much of that syntax is honored depends
        // on how the platform executes the command string — do not assume a full
        // shell, and do not assume its absence). The gate narrows the injection
        // surface rather than closing it: ASCII control characters such as
        // newline and carriage return pass both checks. Text the gate rejects
        // takes the clipboard-paste path, which never puts the text on a shell
        // command line — its only shell call is the fixed string
        // "input keyevent 279".
        val shellMetachars = setOf('&', '|', ';', '<', '>', '$', '`', '\\', '"', '\'', '(', ')', '{', '}', '!', '#', '~', '*', '?', '[', ']')
        val isSafeForShell = text.all { it.code < 128 && it !in shellMetachars }
        if (isSafeForShell) {
            val escaped = text.replace(" ", "%s")
            uiDevice.executeShellCommand("input text $escaped")
        } else {
            pasteText(text)
        }
    }

    private fun pasteText(text: String) {
        var previousClip: android.content.ClipData? = null
        val setLatch = java.util.concurrent.CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            try {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
                        as android.content.ClipboardManager
                previousClip = try { cm.primaryClip } catch (_: Exception) { null }
                cm.setPrimaryClip(android.content.ClipData.newPlainText("", text))
            } finally {
                setLatch.countDown()
            }
        }
        val clipboardSet = setLatch.await(2, java.util.concurrent.TimeUnit.SECONDS)
        if (!clipboardSet) {
            throw IllegalStateException("pasteText: timed out waiting for clipboard to be set")
        }
        uiDevice.executeShellCommand("input keyevent 279")

        val restoreLatch = java.util.concurrent.CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            try {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
                        as android.content.ClipboardManager
                val saved = previousClip
                if (saved != null) {
                    cm.setPrimaryClip(saved)
                } else {
                    cm.clearPrimaryClip()
                }
            } finally {
                restoreLatch.countDown()
            }
        }
        if (!restoreLatch.await(2, java.util.concurrent.TimeUnit.SECONDS)) {
            errorLog("pasteText: timed out waiting for clipboard restore")
        }
    }

    fun enterTextOnFocusNode(text: String, shouldClearText: Boolean) = runBlocking {
        val focusedNode = AccessibilityStreamer.getStableFocusedNode()
        var newText = text
        if (!shouldClearText) {
            debugLog("enterTextOnFocusNode: focusNode hintText: ${focusedNode?.hintText}")
            val isHintShowing = focusedNode?.isShowingHintText ?: false
            debugLog("enterTextOnFocusNode: focusNode isShowingHintText: $isHintShowing")
            if (!isHintShowing) {
                val currentText = focusedNode?.text?.toString() ?: ""
                newText = currentText + text
            }
        }
        val args = Bundle().apply {
            putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText
            )
        }
        focusedNode?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    fun clearTextFromFocusNode(eraseCount: Int) = runBlocking {
        for (i in 0..<eraseCount)
            uiDevice.executeShellCommand("input keyevent 67")
    }

    enum class ScrollDirection {
        SCROLL_DOWN, //Scroll top to bottom
        SCROLL_UP, //Scroll bottom to top
        SCROLL_RIGHT, //Scroll Left to Right
        SCROLL_LEFT //Scroll Right to Left
    }

    fun scroll(direction: ScrollDirection, fromScroll: Double, toScroll: Double) {
        val screenHeight = DeviceCache.getScreenHeight()
        val screenWidth = DeviceCache.getScreenWidth()
        when (direction) {
            ScrollDirection.SCROLL_UP, ScrollDirection.SCROLL_DOWN -> {
                val startX = (screenWidth * 0.6f).toInt()
                val startY = (screenHeight * fromScroll).toInt()
                val endX = (screenWidth * 0.6f).toInt()
                val endY = (screenHeight * toScroll).toInt()
                adbScroll(startX, startY, endX, endY)
                return
            }

            ScrollDirection.SCROLL_RIGHT, ScrollDirection.SCROLL_LEFT -> {
                val startX = (screenWidth * fromScroll).toInt()
                val startY = (screenHeight * 0.6f).toInt()
                val endX = (screenWidth * toScroll).toInt()
                val endY = (screenHeight * 0.6f).toInt()
                adbScroll(startX, startY, endX, endY)
                return
            }
        }
    }

    fun adbScroll(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        durationMs: Int = 500
    ): String {
        val command = "input swipe $startX $startY $endX $endY $durationMs"
        return uiDevice.executeShellCommand(command)
    }

    fun verifyValues(direction: ScrollDirection, fromScroll: Int, toScroll: Int): Point {
        val point = Point(fromScroll, toScroll)
        when (direction) {
            ScrollDirection.SCROLL_UP -> {
                return if (fromScroll < toScroll) {
                    debugLog("Scroll: $direction: values are correct: fromScroll($fromScroll), toScroll($toScroll)")
                    point
                } else {
                    debugLog("Scroll: $direction: fromScroll($fromScroll) is not less than toScroll($toScroll), using default values instead")
                    Point(SCROLL_UP_FROM, SCROLL_UP_TO)
                }
            }

            ScrollDirection.SCROLL_LEFT -> {
                return if (fromScroll < toScroll) {
                    debugLog("Scroll: $direction: values are correct: fromScroll($fromScroll), toScroll($toScroll)")
                    point
                } else {
                    debugLog("Scroll: $direction: fromScroll($fromScroll) is not less than toScroll($toScroll), using default values instead")
                    Point(SCROLL_LEFT_FROM, SCROLL_LEFT_TO)
                }
            }

            ScrollDirection.SCROLL_DOWN -> {
                return if (fromScroll > toScroll) {
                    debugLog("Scroll: $direction: values are correct: fromScroll($fromScroll), toScroll($toScroll)")
                    point
                } else {
                    debugLog("Scroll: $direction: fromScroll($fromScroll) is not greater than toScroll($toScroll), using default values instead")
                    Point(SCROLL_DOWN_FROM, SCROLL_DOWN_TO)
                }
            }

            ScrollDirection.SCROLL_RIGHT -> {
                return if (fromScroll > toScroll) {
                    debugLog("Scroll: $direction: values are correct: fromScroll($fromScroll), toScroll($toScroll)")
                    point
                } else {
                    debugLog("Scroll: $direction: fromScroll($fromScroll) is not greater than toScroll($toScroll), using default values instead")
                    Point(SCROLL_RIGHT_FROM, SCROLL_RIGHT_TO)
                }
            }
        }
    }

    fun rotate(): Boolean {
        val currentRotation: Int = uiDevice.displayRotation
        try {
            if (currentRotation == Surface.ROTATION_0) {
                // Device is in its natural orientation, so rotate it to the right (90° clockwise).
                uiDevice.setOrientationRight()
            } else {
                // Device is rotated, so revert back to its natural orientation.
                uiDevice.setOrientationNatural()
            }
            return true
        } catch (e: Exception) {
            errorLog("Error while rotating device: ${e.message}")
            return false
        }
    }

    fun getCurrentOrientation(): String {
        return when (uiDevice.displayRotation) {
            Surface.ROTATION_0 -> "Portrait"
            Surface.ROTATION_90 -> "Landscape"
            Surface.ROTATION_180 -> "Reverse Portrait"
            Surface.ROTATION_270 -> "Reverse Landscape"
            else -> "Unknown"
        }
    }

    fun rotateLeft() {
        uiDevice.setOrientationLeft()
    }

    fun rotateRight() {
        uiDevice.setOrientationRight()
    }

    fun rotateToPortrait() {
        uiDevice.setOrientationNatural()
    }

    fun setLocation(request: SetLocationAction) {
        try {
            locationCounter++
            val version = locationCounter

            geoHandler.removeCallbacksAndMessages(null)

            val latitude = request.lat
            val longitude = request.long
            val accuracy = 1F

            val locMgr = InstrumentationRegistry.getInstrumentation()
                .context
                .getSystemService(LOCATION_SERVICE) as LocationManager

            locMgr.addTestProvider(
                LocationManager.GPS_PROVIDER,
                false,
                true,
                false,
                false,
                true,
                false,
                false,
                Criteria.POWER_LOW,
                Criteria.ACCURACY_FINE
            )

            val newLocation = Location(LocationManager.GPS_PROVIDER)

            newLocation.latitude = latitude
            newLocation.longitude = longitude
            newLocation.accuracy = accuracy
            newLocation.altitude = 0.0
            locMgr.setTestProviderEnabled(LocationManager.GPS_PROVIDER, true)

            fun postLocation() {
                geoHandler.postDelayed({
                    if (locationCounter != version) {
                        return@postDelayed
                    }

                    newLocation.time = System.currentTimeMillis()
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
                        newLocation.elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
                    }
                    locMgr.setTestProviderStatus(
                        LocationManager.GPS_PROVIDER,
                        LocationProvider.AVAILABLE,
                        null, System.currentTimeMillis()
                    )

                    locMgr.setTestProviderLocation(LocationManager.GPS_PROVIDER, newLocation)

                    postLocation()
                }, 1000)
            }

            postLocation()

        } catch (t: Throwable) {
            errorLog("Failed to set mock location: ${t.message}")
        }
    }

    fun goToHomeScreen() = uiDevice.pressHome()

    fun pressBackButton() = uiDevice.pressBack()

    fun waitForAppLaunch(targetPackage: String, timeoutMs: Long): Boolean {
        return uiDevice.wait(Until.hasObject(By.pkg(targetPackage).depth(0)), timeoutMs)
    }

    fun launchApp(
        packageName: String,
        arguments: Map<String, SingleArgument?>?
    ): Pair<Boolean, String?> {
        val targetContext = InstrumentationRegistry.getInstrumentation().targetContext
        val intent: Intent? = getAppIntentForPackage(targetContext, packageName)

        if (intent == null) {
            errorLog("intent null for $packageName")
            return Pair(false, "Cannot launch: $packageName, maybe the app is not present")
        }

        if (!arguments.isNullOrEmpty()) addArgumentsToIntent(intent, arguments)

        return launchAppViaIntent(targetContext, intent)
    }

    private fun addArgumentsToIntent(
        intent: Intent,
        arguments: Map<String, SingleArgument?>?
    ) {
        intent.apply {
            arguments?.forEach { (key, args) ->
                if (args == null) {
                    errorLog("Missing or invalid SingleArguments args key: $key. Skipping extra.")
                    return@forEach
                }

                when (args.type) {
                    DATA_TYPE_STRING -> {
                        putExtra(key, args.value)
//                        debugLog("Valid $DATA_TYPE_STRING: key: $key, value: ${args.value}")
                    }

                    DATA_TYPE_BOOLEAN -> {
                        when (args.value.lowercase()) {
                            DATA_BOOL_TRUE -> {
                                putExtra(key, true)
//                                debugLog("Valid $DATA_TYPE_BOOLEAN: key: $key, value: true")
                            }

                            DATA_BOOL_FALSE -> {
                                putExtra(key, false)
//                                debugLog("Valid $DATA_TYPE_BOOLEAN: key: $key, value: false")
                            }

                            else -> errorLog("Invalid Boolean value for key: $key. Received: ${args.value}. Skipping extra.")
                        }
                    }

                    DATA_TYPE_DECIMAL -> {
                        val doubleValue = args.value.toDoubleOrNull()
                        if (doubleValue == null || !doubleValue.isFinite()) {
                            errorLog("Invalid or out-of-range Decimal value for key: $key. Received: ${args.value}. Skipping extra.")
                        } else {
                            putExtra(key, doubleValue)
//                            debugLog("Valid $DATA_TYPE_DECIMAL: key: $key, value: $doubleValue")
                        }
                    }

                    DATA_TYPE_INTEGER -> {
                        val intValue = args.value.toIntOrNull()
                        if (intValue == null) {
                            errorLog("Invalid or out-of-range Integer value for key: $key. Received: ${args.value}. Skipping extra.")
                        } else {
                            putExtra(key, intValue)
//                            debugLog("Valid $DATA_TYPE_INTEGER: key: $key, value: $intValue")
                        }
                    }

                    else -> errorLog("Unsupported Type: $type for key: $key, Skipping extra.")
                }
            }
        }
    }

    private fun getAppIntentForPackage(
        targetContext: Context,
        packageName: String,
        shouldClearTask: Boolean = true
    ): Intent? {
        val intent: Intent? =
            targetContext.packageManager.getLaunchIntentForPackage(packageName)?.apply {
                if (shouldClearTask) addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        return intent
    }

    fun switchToPrimaryApp(packageName: String): Pair<Boolean, String?> {
        val targetContext =
            InstrumentationRegistry.getInstrumentation().targetContext
        val intent: Intent? = getAppIntentForPackage(
            targetContext,
            packageName,
            shouldClearTask = false
        )
        return launchAppViaIntent(targetContext, intent)
    }

    private fun launchAppViaIntent(
        targetContext: Context,
        appIntent: Intent?
    ): Pair<Boolean, String?> {
        if (appIntent == null) {
            errorLog("app intent null for the app")
            return Pair(false, "Cannot launch app, maybe the app is not present")
        }
        return try {
            targetContext.startActivity(appIntent)
            Pair(true, null)
        } catch (e: Exception) {
            Pair(false, "Error while launching app: ${e.message}")
        }
    }

    fun resetLocation() {
        try {
            geoHandler.removeCallbacksAndMessages(null)

            // Reset location counter to invalidate any running updates
            locationCounter++

            val locMgr = InstrumentationRegistry.getInstrumentation()
                .context
                .getSystemService(LOCATION_SERVICE) as LocationManager

            try {
                locMgr.setTestProviderEnabled(LocationManager.GPS_PROVIDER, false)
                locMgr.removeTestProvider(LocationManager.GPS_PROVIDER)
            } catch (e: Exception) {
                // Provider might not exist, that's ok
                debugLog("Failed to remove test provider: ${e.message}")
            }

            debugLog("Location mocking has been reset")
        } catch (t: Throwable) {
            errorLog("Failed to reset mock location: ${t.message}")
        }
    }
}