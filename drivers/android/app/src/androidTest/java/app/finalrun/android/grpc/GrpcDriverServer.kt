package app.finalrun.android.grpc

import io.grpc.Grpc
import io.grpc.InsecureServerCredentials
import io.grpc.Server
import app.finalrun.android.debugLog
import app.finalrun.android.errorLog
import java.util.concurrent.TimeUnit

/**
 * gRPC server for the Android driver.
 *
 * This replaces WebSocketServerImpl. It starts a gRPC server on the specified port
 * and handles incoming RPC calls from the TypeScript client (packages/device-node).
 */
class GrpcDriverServer(private val port: Int) {
    private var server: Server? = null
    private var driverService: DriverServiceImpl? = null

    companion object {
        private var instance: GrpcDriverServer? = null

        @Synchronized
        fun start(port: Int) {
            instance?.stop()
            instance = GrpcDriverServer(port)
            instance?.start()
        }

        @Synchronized
        fun stop() {
            instance?.stop()
            instance = null
        }

        fun getInstance(): GrpcDriverServer? = instance
    }

    fun start() {
        try {
            // Create service instance so we can call cleanup() on shutdown
            driverService = DriverServiceImpl()
            
            // Use Grpc.newServerBuilderForPort for OkHttp provider compatibility
            server = Grpc.newServerBuilderForPort(port, InsecureServerCredentials.create())
                .addService(driverService)
                .build()
                .start()

            debugLog("gRPC server started on port $port")

            // Handle server termination gracefully
            // Note: Calls shutdown() directly to avoid potential issues with stop() wrapper
            Runtime.getRuntime().addShutdownHook(Thread {
                debugLog("Shutting down gRPC server due to JVM shutdown")
                shutdown()
            })
        } catch (e: Exception) {
            errorLog("Failed to start gRPC server: ${e.message}")
            throw e
        }
    }

    fun stop() {
        try {
            shutdown()
        } catch (e: Exception) {
            errorLog("Error stopping gRPC server: ${e.message}")
        }
    }

    /**
     * Internal shutdown method that performs the actual cleanup.
     * Uses the server reference as a guard - if null, cleanup already happened.
     * Synchronized to ensure thread safety during concurrent stop/start calls.
     */
    @Synchronized
    private fun shutdown() {
        val srv = server ?: return
        server = null  // Clear immediately to prevent re-entry

        debugLog("Stopping gRPC server...")
        
        // Clean up DriverServiceImpl resources (cancels streamingScope)
        driverService?.cleanup()
        driverService = null
        srv.shutdown()
        if (!srv.awaitTermination(5, TimeUnit.SECONDS)) {
            debugLog("Forcing gRPC server shutdown...")
            srv.shutdownNow()
        }
        debugLog("gRPC server stopped")
    }

//    fun blockUntilShutdown() {
//        server?.awaitTermination()
//    }

//    fun isRunning(): Boolean = server != null && !server!!.isShutdown && !server!!.isTerminated
}
