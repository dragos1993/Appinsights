import express from "express";
import fetch from "node-fetch";

// --- Application Insights (classic SDK; simple & stable) ---
const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
if (conn) {
  const appInsights = await import("applicationinsights");
  appInsights.default
    .setup(conn)
    .setAutoCollectRequests(true)
    .setAutoCollectDependencies(true) // outbound HTTP, DB libs, etc.
    .setAutoCollectExceptions(true)
    .setAutoCollectConsole(true)
    .setSendLiveMetrics(true)         // shows up in Live Metrics stream
    .setUseDiskRetryCaching(true)
    .start();
  console.log("Application Insights enabled.");
} else {
  console.warn("APPLICATIONINSIGHTS_CONNECTION_STRING not set; telemetry disabled.");
}

const app = express();

// health endpoints (K8s probes)
app.get("/healthz", (_, res) => res.status(200).send("ok"));
app.get("/readyz",  (_, res) => res.status(200).send("ready"));

// basic route
app.get("/", (_, res) => res.send("Hello from Node on AKS!"));

// generate request latency (simulate work)
app.get("/slow", async (_, res) => {
  const ms = Math.floor(200 + Math.random() * 1200);
  await new Promise(r => setTimeout(r, ms));
  res.send(`Slept ${ms}ms`);
});

// generate a dependency call (captured as Dependency in App Insights)
app.get("/external", async (_, res) => {
  await fetch("https://example.com", { method: "GET" });
  res.send("Fetched example.com");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
