Here is the exact sequence of steps we did, from zero → seeing logs and live metrics in Application Insights (Live Metrics Stream) for your NodeJS app deployed in AKS.

✅ STEPS WE DID (End-to-End)
1. Create AKS Cluster + Log Analytics Workspace

We created the AKS cluster and selected:

✔ Enable Monitoring
✔ Attach Log Analytics Workspace

This is critical — App Insights needs the workspace to store telemetry.

2. Create Application Insights (standalone)

We created an Application Insights resource manually.

➡️ Application Insights generated a connection string

Example:

InstrumentationKey=xxxx;IngestionEndpoint=https://westeurope-1.in.applicationinsights.azure.com/

3. Install the Application Insights SDK in the Node app

Inside your NodeJS code, we added:

const appInsights = require("applicationinsights");
appInsights.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
  .setAutoCollectRequests(true)
  .setAutoCollectPerformance(true)
  .setAutoCollectDependencies(true)
  .setSendLiveMetrics(true)   // <-- required for Live Metrics
  .start();


📌 The important bit is:
setSendLiveMetrics(true)
That allows Live Metrics Stream to show real-time logs.

4. Create a Kubernetes Secret with the connection string

We created a secret in the demo namespace:

apiVersion: v1
kind: Secret
metadata:
  name: appinsights-conn
  namespace: demo
type: Opaque
stringData:
  APPLICATIONINSIGHTS_CONNECTION_STRING: "<paste-from-Azure>"


Applied via:

kubectl apply -f deployment.yaml

5. Inject the secret into Deployment (ENV VAR)

In the pod spec:

env:
  - name: APPLICATIONINSIGHTS_CONNECTION_STRING
    valueFrom:
      secretKeyRef:
        name: appinsights-conn
        key: APPLICATIONINSIGHTS_CONNECTION_STRING


This makes the connection string available inside the container.

6. Add tolerations (your node was tainted)

Your AKS nodes had a taint:

node.kubernetes.io/unreachable:NoSchedule

We added:

tolerations:
  - key: "node.kubernetes.io/unreachable"
    operator: "Exists"
    effect: "NoSchedule"


Otherwise the pod wouldn’t schedule → App wouldn’t run → No logs in App Insights.

7. Expose the app via LoadBalancer
apiVersion: v1
kind: Service
spec:
  type: LoadBalancer


We then used the external IP to trigger requests from browser/Postman, so telemetry appears.

8. (Optional for Grafana) Role Assignments

We assigned:

Monitoring Reader

Log Analytics Reader

To allow Grafana to query Log Analytics.

9. Logs appeared in App Insights ✅

Once the pod was scheduled and traffic hit the service:

➡️ AppRequests table gets filled
➡️ Live Metrics starts showing traffic
➡️ Traces, Dependencies appear if used in code

You verified everything in:
Azure → Application Insights → Live Metrics Stream

And we saw live logs like:

Request POST /api/test 200 OK
Request GET /healthz 200 OK (Fast)

🔥 Why Live Metrics Worked?

Because we satisfied all 3 requirements:

Requirement	Done?
Instrument app with Application Insights SDK	✅
Enable setSendLiveMetrics(true)	✅
Live logs sent via ingestion endpoint	✅

Live Metrics does not use Log Analytics.
It streams data directly from your app → App Insights.

❓ Why then Grafana uses Log Analytics Workspace?
Service	Uses
App Insights Live Metrics	Real-time streaming from app (SDK → App Insights)
Grafana	Queries stored telemetry (via Log Analytics workspace)

Telemetry flow:

AKS → App Insights → Stored into Log Analytics Workspace → Grafana queries it
