📘 Project Documentation
AKS + Node.js + Application Insights + Azure Managed Grafana

End-to-End Monitoring using Log Analytics (KQL) & SLO Dashboards

✅ Architecture Overview
Node.js App (App Insights SDK)
        │ telemetry (requests, dependencies, traces…)
        ▼
Application Insights (Ingestion layer)
        │ stores telemetry
        ▼
Log Analytics Workspace (KQL storage)
        │ queried by Grafana
        ▼
Azure Managed Grafana (Dashboards)


✅ Application Insights = SDK ingestion + Live Metrics
✅ Log Analytics = where telemetry is stored
✅ Grafana = visualisation via KQL queries (AppRequests / AppDependencies tables)

1. Create Resource Group
az group create -n aks-rg1 -l eastus

2. Create Log Analytics Workspace (storage backend)
az monitor log-analytics workspace create \
  -g aks-rg1 \
  -n log-aks-demo \
  -l eastus

LAW_ID=$(az monitor log-analytics workspace show -g aks-rg1 -n log-aks-demo --query id -o tsv)

3. Create AKS (RBAC + AAD + Monitoring enabled)
az aks create \
  --resource-group aks-rg1 \
  --name aks-demo \
  --location eastus \
  --node-count 2 \
  --node-vm-size Standard_A2_v2 \
  --generate-ssh-keys \
  --enable-aad \
  --aad-admin-group-object-ids "<AAD_GROUP_OBJECT_ID>" \
  --enable-azure-rbac \
  --disable-local-accounts \
  --enable-addons monitoring \
  --workspace-resource-id "$LAW_ID"


Add kubeconfig:

az aks get-credentials -g aks-rg1 -n aks-demo

4. Build & Push Docker image to ACR

ACR already exists: aksdemoacr4895.azurecr.io

Enable admin on ACR:

az acr update -n aksdemoacr4895 --admin-enabled true


Pull ACR credentials:

ACR_USER=$(az acr credential show -n aksdemoacr4895 --query username -o tsv)
ACR_PASS=$(az acr credential show -n aksdemoacr4895 --query passwords[0].value -o tsv)


Create registry pull secret in AKS:

kubectl create secret docker-registry acr-pull \
  --docker-server=aksdemoacr4895.azurecr.io \
  --docker-username="$ACR_USER" \
  --docker-password="$ACR_PASS" \
  --namespace demo

5. Configure Application Insights

Create secret in AKS for connection string:

kubectl -n demo create secret generic appinsights-conn \
  --from-literal=APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=...;IngestionEndpoint=https://..."

6. Node.js Instrumentation (Application Insights SDK)
const appInsights = require("applicationinsights");

appInsights.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
  .setAutoCollectDependencies(true)
  .setAutoCollectRequests(true)
  .setAutoCollectPerformance(true)
  .start();

7. Deploy to AKS

Update deployment to use the image & pull secret:

kubectl -n demo set image deploy/node-aks-app \
  web=aksdemoacr4895.azurecr.io/node-aks-app:1.0.4

kubectl -n demo patch deployment node-aks-app \
  --type merge -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"acr-pull"}]}}}}'


Verify:

kubectl -n demo get pods


Get load balancer IP:

kubectl -n demo get svc node-aks-svc

8. Generate traffic
LB=$(kubectl -n demo get svc node-aks-svc -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

for i in {1..10}; do curl http://$LB/; done

9. Configure Azure Managed Grafana

Assign Roles so Grafana can read LAW:

export MSYS2_ARG_CONV_EXCL="--scope"   # only required in Git Bash on Windows

az role assignment create \
  --assignee-object-id "<Grafana Managed Identity ID>" \
  --role "Monitoring Reader" \
  --scope "$LAW_ID"

az role assignment create \
  --assignee-object-id "<Grafana Managed Identity ID>" \
  --role "Log Analytics Reader" \
  --scope "$LAW_ID"

10. Grafana Dashboard (SLO Metrics)
All panels must be configured like:
Setting	Value
Datasource	Azure Monitor
Service	Logs
Resource	Select Log Analytics Workspace (DefaultWorkspace-...)
Format	Time series / Table (per panel requirement)
✔ Key KQL Queries Used in Dashboard
✅ Uptime
AppRequests
| where $__timeFilter(TimeGenerated)
| summarize uptime = 100.0 * avg(toint(Success)) by bin(TimeGenerated, 1m)

✅ 4xx / 5xx Error Rate
AppRequests
| where $__timeFilter(TimeGenerated)
| extend Code = toint(ResultCode)
| summarize total=count(),
            c4xx=countif(Code between (400 .. 499)),
            c5xx=countif(Code between (500 .. 599))
          by bin(TimeGenerated,1m)
| extend rate4xx = 100.0 * todouble(c4xx)/todouble(total),
         rate5xx = 100.0 * todouble(c5xx)/todouble(total)

✅ MTTR (Minutes)
let S =
    AppRequests
    | where $__timeFilter(TimeGenerated)
    | summarize total=count(), errors=countif(Success == false) by ts = bin(TimeGenerated, 1m)
    | extend er = 100.0 * todouble(errors) / todouble(total)
    | order by ts asc;
let start =
    toscalar(S | serialize | extend bad = er > 5.0 | extend prev_bad = prev(bad)
             | where bad == true and (prev_bad == false or isnull(prev_bad))
             | top 1 by ts desc
             | project start_ts = ts);
let rec =
    toscalar(S | where ts > start | where er <= 5.0 | top 1 by ts asc | project rec_ts = ts);
print mttr_min = iif(isnull(start) or isnull(rec), real(null),
                     todouble(datetime_diff('minute', rec, start)))

✅ Latency Percentiles
AppRequests
| where $__timeFilter(TimeGenerated)
| summarize P75=percentile(DurationMs,75),
            P90=percentile(DurationMs,90),
            P95=percentile(DurationMs,95),
            P99=percentile(DurationMs,99)
          by bin(TimeGenerated,5m)

✅ Requests Per Second (RPS)
AppRequests
| where $__timeFilter(TimeGenerated)
| summarize rps = count() / 60 by bin(TimeGenerated, 1m)

✅ Unauthorized Rate (401)
AppRequests
| where $__timeFilter(TimeGenerated)
| summarize total=count(), unauthorized=countif(tostring(ResultCode)=="401") by bin(TimeGenerated,1m)
| extend rate = 100.0 * todouble(unauthorized)/todouble(total)

📌 Why do we need App Insights if Grafana uses Log Analytics?
Component	Purpose
Application Insights	SDK for your code + telemetry ingestion + Live Metrics
Log Analytics Workspace	Stores structured telemetry tables (AppRequests, AppDependencies)
Grafana	Visualizes KQL queries from LAW

➡ Application Insights collects telemetry
➡ Log Analytics stores telemetry
➡ Grafana queries Log Analytics

DONE ✅

You now have:

✔ AKS cluster running Node.js
✔ Application Insights telemetry
✔ All data stored in Log Analytics
✔ Grafana SLO dashboard with KQL queries
