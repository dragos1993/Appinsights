import express from "express";
import fetch from "node-fetch";

// -------------------------------------------
// ✅ Application Insights setup
// -------------------------------------------
const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (conn) {
  const appInsights = await import("applicationinsights");

  appInsights.default
    .setup(conn)
    .setAutoCollectRequests(true)         // capture incoming requests
    .setAutoCollectDependencies(true)     // capture outbound HTTP calls
    .setAutoCollectExceptions(true)       // capture unhandled exceptions
    .setAutoCollectConsole(true)          // capture console.log/console.error
    .setSendLiveMetrics(true)             // Live Metrics (already working for you)
    .setUseDiskRetryCaching(true)         // persist telemetry if network fails
    .setInternalLogging(true, true)       // verbose diagnostics to pod logs
    .setSamplingPercentage(100);          // 🔥 send EVERYTHING (no sampling)

  appInsights.default.start();

  // Send a custom event immediately so we can see it in Logs -> customEvents table
  const client = appInsights.default.defaultClient;
  client.trackEvent({
    name: "boot_event",
    properties: { source: "node-aks-app", message: "App started on AKS" }
  });
  client.flush();
  console.log("✅ Application Insights enabled (sampling = 100%).");
} else {
  console.warn("❌ No Application Insights connection string found.");
}

// -------------------------------------------
// ✅ Express app
// -------------------------------------------
const app = express();

// readiness + liveness probes (needed by AKS)
app.get("/healthz", (_, res) => res.status(200).send("ok"));
app.get("/readyz", (_, res) => res.status(200).send("ready"));

// default route
app.get("/", (_, res) => {
  console.log("Root route hit.");
  res.send("Hello from Node on AKS (with App Insights ✅)");
});

// simulate slow endpoint (required for P75/P90/P95/P99 percentiles)
app.get("/slow", async (_, res) => {
  const ms = Math.floor(250 + Math.random() * 1500);
  await new Promise(resolve => setTimeout(resolve, ms));
  console.log(`Slow endpoint simulated ${ms}ms`);
  res.send(`Slow response: ${ms}ms`);
});

// simulate external dependency (shows up in dependencies table)
app.get("/external", async (_, res) => {
  console.log("Calling external dependency...");
  await fetch("https://example.com");   // App Insights automatically tracks this
  res.send("External call completed.");
});

// start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Listening on port ${port}`));
