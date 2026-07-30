package app.finalrun.android

import app.finalrun.android.data.ActionResponse
import app.finalrun.android.data.DeviceCache.getScreenHeight
import app.finalrun.android.data.DeviceCache.getScreenWidth

fun createErrorResponse(id: String, errorMsg: String): ActionResponse {
    return ActionResponse(
        requestId = id,
        success = false,
        message = errorMsg,
        data = null
    )
}

/** Inclusive range a PointPercent coordinate must fall in — see the KDoc below. */
private val SCREEN_FRACTION_RANGE = 0.0..1.0

/**
 * Convert a PointPercent coordinate to absolute screen pixels.
 *
 * UNIT CONTRACT: [xP] and [yP] are FRACTIONS in 0.0..1.0, not 0–100
 * percentages, despite the proto field names `x_percent`/`y_percent`. The
 * screen centre is (0.5, 0.5). Do NOT reintroduce a `/ 100`: the client sends
 * fractions (`PointPercent.fromJson({ xPercent: 0.25, … })` in
 * packages/common/src/models/test/DeviceAction.test.ts) and the iOS driver
 * multiplies without a divisor, so dividing here puts every tap within a few
 * pixels of the top-left corner. The range is stated on the proto message too,
 * so the three implementations can be checked against one another.
 *
 * 0.0 is a legitimate coordinate — the left or top edge — so it is NOT
 * rejected. `null` means the caller sent something outside 0.0..1.0 (including
 * NaN, which is in no range): most likely a 0–100 caller, whose point would
 * otherwise resolve far off screen. `DriverServiceImpl.tapPercent` turns that
 * null into an explicit failure response rather than tapping.
 */
fun getXYPercentOnScreen(xP: Double, yP: Double): Pair<Int, Int>? {
    if (xP !in SCREEN_FRACTION_RANGE || yP !in SCREEN_FRACTION_RANGE) return null
    val x = (xP * getScreenWidth()).toInt()
    val y = (yP * getScreenHeight()).toInt()
    return Pair(x, y)
}

/**
 * Calculate frame delay in milliseconds from FPS
 * Example calculation:
 * Frame Duration (in milliseconds)
 * Formula: (1 / Frame Rate) × 1000
 * (1 / 24) * 1000 = 41.6666
 * 
 * 4. Fix FPS calculation - ensure floating point division
 * Also adds bounds checking for safety
 */
fun calculateFrameDelay(frameRate: Int): Long {
    // Ensure valid frame rate (1-60 fps reasonable range)
    val fps = frameRate.coerceIn(1, 60)
    // Use floating point division to avoid integer truncation
    return (1000.0 / fps.toDouble()).toLong()
}