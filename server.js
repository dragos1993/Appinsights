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
    .setAutoCollectRequests(true)         // capture incoming HTTP requests
    .setAutoCollectDependencies(true)     // outbound HTTP dependencies
    .setAutoCollectExceptions(true)
    .setAutoCollectConsole(true)
    .setSendLiveMetrics(true)
    .setUseDiskRetryCaching(true)
    .setInternalLogging(true, true);      // verbose SDK logs to container logs

  // ✅ Start sends telemetry automatically
  appInsights.default.start();

  // ✅ Disable sampling (send everything)
  appInsights.default.defaultClient.config.samplingPercentage = 100;

  // ✅ Emit custom event so we can check in Logs → customEvents table
  appInsights.default.defaultClient.trackEvent({
    name: "boot_event",
    properties: { message: "AKS Node app started" }
  });

  console.log("✅ Application Insights enabled, sampling = 100%");
} else {
  console.warn("❌ AI connection string missing — telemetry disabled.");
}

// -------------------------------------------
// ✅ Express app
// -------------------------------------------
const app = express();

// Health probes required by AKS
app.get("/healthz", (_, res) => res.send("ok"));
app.get("/readyz", (_, res) => res.send("ready"));

// Root route
app.get("/", (_, res) => {
  console.log("Root endpoint hit.");
  res.send("Hello from Node on AKS (with App Insights ✅)");
});

// Slow endpoint (latency)
app.get("/slow", async (_, res) => {
  const ms = Math.floor(Math.random() * 1500) + 250;
  await new Promise(r => setTimeout(r, ms));
  res.send(`Slow endpoint responded in ${ms} ms`);
});

// External dependency (tracks in dependencies table)
app.get("/external", async (_, res) => {
  await fetch("https://example.com");
  res.send("External call done.");
});

// Start web server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Listening on ${port}`));
