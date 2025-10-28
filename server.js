import express from "express";
import https from "https"; // ✅ native https ensures dependencies are collected

// ✅ App Insights Connection String is injected from Kubernetes secret
const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

let ai;
if (conn) {
  const appInsights = await import("applicationinsights");
  ai = appInsights.default;

  ai
    .setup(conn)
    .setAutoCollectRequests(true)          // capture incoming HTTP requests
    .setAutoCollectDependencies(true)      // outbound dependencies
    .setAutoCollectExceptions(true)
    .setAutoCollectConsole(true)
    .setSendLiveMetrics(true)
    .setUseDiskRetryCaching(true)
    .setInternalLogging(true, true);       // verbose AI logs to container logs

  ai.start();

  // ✅ Disable sampling = log 100% of requests + dependencies
  ai.defaultClient.config.samplingPercentage = 100;

  // ✅ Custom event so we see something in customEvents table
  ai.defaultClient.trackEvent({
    name: "boot_event",
    properties: { message: "AKS Node app started" }
  });

  console.log("✅ Application Insights enabled (sampling: 100%)");
} else {
  console.warn("❌ APPLICATIONINSIGHTS_CONNECTION_STRING is missing. Telemetry OFF.");
}

const app = express();

/* -----------------------------------------------------
   ✅ Middleware: manual request tracking (guarantees `requests` table)
----------------------------------------------------- */
if (ai?.defaultClient) {
  app.use((req, res, next) => {
    const start = Date.now();

    res.on("finish", () => {
      const duration = Date.now() - start;

      ai.defaultClient.trackRequest({
        name: `${req.method} ${req.originalUrl}`,
        url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        duration,
        resultCode: res.statusCode,
        success: res.statusCode < 400,
        time: new Date()
      });
    });

    next();
  });
}

/* -----------------------------------------------------
   ✅ Health endpoints for Kubernetes probes
----------------------------------------------------- */
app.get("/healthz", (_, res) => res.send("ok"));
app.get("/readyz", (_, res) => res.send("ready"));

/* -----------------------------------------------------
   ✅ Base endpoint (shows up in `requests`)
----------------------------------------------------- */
app.get("/", (_, res) => {
  console.log("Root endpoint hit");
  res.send("Hello from Node on AKS ✅ (with App Insights)");
});

/* -----------------------------------------------------
   ✅ Slow endpoint - shows latency percentiles (P75/P90/P95/P99)
----------------------------------------------------- */
app.get("/slow", async (_, res) => {
  const ms = Math.floor(300 + Math.random() * 1500);
  await new Promise(r => setTimeout(r, ms));
  res.send(`Slow response: ${ms}ms`);
});

/* -----------------------------------------------------
   ✅ /external endpoint - sends dependency telemetry (HTTP call)
----------------------------------------------------- */
app.get("/external", async (_, res) => {
  const start = Date.now();

  https.get("https://example.com", (r) => {
    r.resume(); // drain response

    r.on("end", () => {
      ai?.defaultClient.trackDependency({
        name: "GET https://example.com",
        data: "https://example.com",
        target: "example.com",
        duration: Date.now() - start,
        resultCode: r.statusCode?.toString() ?? "200",
        success: (r.statusCode ?? 200) < 400,
        dependencyTypeName: "HTTP"
      });

      res.send("External dependency call logged ✅");
    });

  }).on("error", (err) => {
    ai?.defaultClient.trackException({ exception: err });
    ai?.defaultClient.trackDependency({
      name: "GET https://example.com",
      data: "https://example.com",
      target: "example.com",
      duration: Date.now() - start,
      resultCode: "ERR",
      success: false,
      dependencyTypeName: "HTTP"
    });

    res.status(502).send("External dependency failed ❌");
  });
});

/* -----------------------------------------------------
   ✅ Start server
----------------------------------------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Node app listening on port ${port}`));
