import express from "express";
import fetch from "node-fetch";

const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

let ai;
if (conn) {
  const appInsights = await import("applicationinsights");
  ai = appInsights.default;

  ai
    .setup(conn)
    .setAutoCollectRequests(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectConsole(true)
    .setSendLiveMetrics(true)
    .setUseDiskRetryCaching(true)
    .setInternalLogging(true, true);

  ai.start();
  ai.defaultClient.config.samplingPercentage = 100;

  ai.defaultClient.trackEvent({
    name: "boot_event",
    properties: { message: "AKS Node app started" }
  });

  console.log("✅ AI enabled, sampling=100%");
} else {
  console.warn("❌ AI connection string missing — telemetry disabled.");
}

const app = express();

/* ---- Manual request tracking (guarantees rows in `requests`) ---- */
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

/* Probes */
app.get("/healthz", (_, res) => res.send("ok"));
app.get("/readyz",  (_, res) => res.send("ready"));

/* Routes */
app.get("/", (_, res) => res.send("Hello from Node on AKS (AI ✅)"));

app.get("/slow", async (_, res) => {
  const ms = Math.floor(250 + Math.random() * 1500);
  await new Promise(r => setTimeout(r, ms));
  res.send(`Slow response: ${ms}ms`);
});

app.get("/external", async (_, res) => {
  await fetch("https://example.com");
  res.send("External call done.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Listening on ${port}`));
