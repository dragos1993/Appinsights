What we built

An AKS cluster (2 nodes) running a Node.js app that sends Application Insights telemetry, stored in a Log Analytics workspace and visualized in Azure Managed Grafana via KQL queries.

Step-by-step (chronological)
1) Resource prep

Picked subscription

az account show --query id -o tsv
az account set --subscription <SUBSCRIPTION_ID>


Resource group (your RG already existed in eastus)

az group create -n aks-rg1 -l eastus

2) Log Analytics Workspace (for Application Insights data)
az monitor log-analytics workspace create -g aks-rg1 -n log-aks-demo -l eastus
LAW_ID=$(az monitor log-analytics workspace show -g aks-rg1 -n log-aks-demo --query id -o tsv)

3) AKS cluster (AAD + RBAC + monitoring)

AAD admin group: used your Entra ID group objectId.

AKS create (2 nodes, RBAC, AAD, monitoring wired to LAW):

az aks create \
  --resource-group aks-rg1 \
  --name aks-demo \
  --location eastus \
  --node-count 2 \
  --node-vm-size Standard_A2_v2 \
  --generate-ssh-keys \
  --enable-aad \
  --aad-admin-group-object-ids "<YOUR_GROUP_OBJECTID>" \
  --enable-azure-rbac \
  --disable-local-accounts \
  --enable-addons monitoring \
  --workspace-resource-id "$LAW_ID"


Get kubeconfig

az aks get-credentials -g aks-rg1 -n aks-demo

4) Container registry & image

ACR already created: aksdemoacr4895.azurecr.io.

MSYS path rewrite fix (Git Bash on Windows):
Avoided /subscriptions/... being mangled:

export MSYS2_ARG_CONV_EXCL="--scope"


Service principal for CI push to ACR (role AcrPush):

ACR_ID=$(az acr show -n aksdemoacr4895 --query id -o tsv)
az ad sp create-for-rbac --name gh-acr-pusher --role AcrPush --scopes "$ACR_ID" --skip-assignment
# Then assign role (if needed):
az role assignment create --assignee-object-id <SP_OBJECT_ID> --role AcrPush --scope "$ACR_ID"


GitHub Actions workflow built & pushed the image (fixed YAML errors & env quoting) to:

aksdemoacr4895.azurecr.io/node-aks-app:<tag>

5) Kubernetes deploy

App Insights connection string → K8s Secret

kubectl -n demo create secret generic appinsights-conn \
  --from-literal=APPLICATIONINSIGHTS_CONNECTION_STRING='InstrumentationKey=...;IngestionEndpoint=...'


ACR pull secret (because ACR is private):

az acr update -n aksdemoacr4895 --admin-enabled true
ACR_USER=$(az acr credential show -n aksdemoacr4895 --query username -o tsv)
ACR_PASS=$(az acr credential show -n aksdemoacr4895 --query passwords[0].value -o tsv)

kubectl -n demo create secret docker-registry acr-pull \
  --docker-server=aksdemoacr4895.azurecr.io \
  --docker-username="$ACR_USER" \
  --docker-password="$ACR_PASS"
kubectl -n demo patch deploy node-aks-app \
  --type merge -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"acr-pull"}]}}}}'


Deploy/rollout

kubectl -n demo set image deploy/node-aks-app web=aksdemoacr4895.azurecr.io/node-aks-app:1.0.4
kubectl -n demo rollout status deploy/node-aks-app

6) Node app + Application Insights SDK

server.js instrumented with applicationinsights v3.x:

enabled request/dependency/exception/console auto-collection

setAutoCollect... + start()

Generated traffic to produce telemetry:

LB=$(kubectl -n demo get svc node-aks-svc -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
for i in {1..12}; do curl -s "http://$LB/"; done
for i in {1..8};  do curl -s "http://$LB/slow"; done
for i in {1..12}; do curl -s "http://$LB/external"; done

7) Verify in Azure Portal (Application Insights)

Live Metrics: confirmed real-time requests.

Logs (KQL): initially used requests/dependencies (classic).
Fixed by using workspace-based App* tables:

AppRequests (TimeGenerated, DurationMs, ResultCode, Success, OperationName)

AppDependencies (Type, Target, DurationMs, Success, OperationId)

8) Azure Managed Grafana

Role assignments for the Grafana managed identity on the LAW:

az role assignment create \
  --assignee-object-id <Grafana_MI_objectId> \
  --assignee-principal-type ServicePrincipal \
  --role "Monitoring Reader" \
  --scope "$LAW_ID"

az role assignment create \
  --assignee-object-id <Grafana_MI_objectId> \
  --assignee-principal-type ServicePrincipal \
  --role "Log Analytics Reader" \
  --scope "$LAW_ID"


Datasource selection per panel:
Azure Monitor → Service: Logs → Resource: your LAW
(Grafana queries the LAW; App Insights feeds that LAW.)

KQL fixes in panels: used AppRequests / AppDependencies + TimeGenerated.

The KQL you ended up using (copy-ready)

In every Grafana panel:
Data source: Azure Monitor → Service: Logs → Resource: DefaultWorkspace-…-EUS
Time column: TimeGenerated (default)

Uptime

AppRequests
| where $__timeFilter(TimeGenerated)
| summarize uptime = 100.0 * avg(toint(Success)) by bin(TimeGenerated, 1m)
| order by TimeGenerated asc


Error Rate (4xx/5xx)

AppRequests
| where $__timeFilter(TimeGenerated)
| extend Code = toint(ResultCode)
| summarize total=count(),
            c4xx=countif(Code between (400 .. 499)),
            c5xx=countif(Code between (500 .. 599))
          by bin(TimeGenerated,1m)
| extend rate4xx = 100.0 * todouble(c4xx)/todouble(total),
         rate5xx = 100.0 * todouble(c5xx)/todouble(total)
| project TimeGenerated, rate4xx, rate5xx
| order by TimeGenerated asc


Incidents (err_rate > 5%)

let S = AppRequests
| where $__timeFilter(TimeGenerated)
| summarize total=count(), errors=countif(Success == false) by ts = bin(TimeGenerated, 1m)
| extend er = 100.0 * todouble(errors)/todouble(total)
| order by ts asc;
S
| serialize
| extend bad = er > 5.0
| extend prev_bad = prev(bad)
| summarize incidents = countif(bad == true and (prev_bad == false or isnull(prev_bad)))


Severity (per minute)

AppRequests
| where $__timeFilter(TimeGenerated)
| summarize total=count(), errors=countif(Success == false) by bin(TimeGenerated, 1m)
| extend error_rate = 100.0 * todouble(errors)/todouble(total)
| extend Severity = case(error_rate >= 50, "Sev1",
                         error_rate >= 20, "Sev2",
                         error_rate >= 5,  "Sev3",
                         "OK")
| project TimeGenerated, error_rate, Severity
| order by TimeGenerated desc
| take 50


MTTR (approx, minutes)

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


Latency Percentiles over time

AppRequests
| where $__timeFilter(TimeGenerated)
| summarize P75=percentile(DurationMs,75),
            P90=percentile(DurationMs,90),
            P95=percentile(DurationMs,95),
            P99=percentile(DurationMs,99)
          by bin(TimeGenerated,5m)
| order by TimeGenerated asc


RPS

AppRequests
| where $__timeFilter(TimeGenerated)
| summarize rps = count() / 60.0 by bin(TimeGenerated, 1m)
| order by TimeGenerated asc


Latency by operation

AppRequests
| where $__timeFilter(TimeGenerated)
| summarize P75=percentile(DurationMs,75),
            P90=percentile(DurationMs,90),
            P95=percentile(DurationMs,95),
            P99=percentile(DurationMs,99)
          by OperationName
| top 20 by P95 desc


DB queries per request (safe zero fallback)

let DB =
    AppDependencies
    | where $__timeFilter(TimeGenerated)
    | where tolower(Type) in ('sql','azuresql','cosmosdb','mongodb','mysql','postgresql');
let per_req =
    DB | summarize db_calls = count() by OperationId, win = bin(TimeGenerated, 5m);
let pct =
    per_req
    | summarize P75=percentile(db_calls,75),
                P90=percentile(db_calls,90),
                P95=percentile(db_calls,95),
                P99=percentile(db_calls,99)
      by win
    | project TimeGenerated=win, P75, P90, P95, P99;
union pct,
(
    pct | summarize dummy=count() | where dummy==0
    | project TimeGenerated=now(), P75=0, P90=0, P95=0, P99=0
)
| order by TimeGenerated asc


Top slowest requests

AppRequests
| where $__timeFilter(TimeGenerated)
| top 20 by DurationMs desc
| project TimeGenerated, OperationName, DurationMs, ResultCode, Success


Unauthorized rate (401)

AppRequests
| where $__timeFilter(TimeGenerated)
| summarize total=count(), unauthorized=countif(tostring(ResultCode)=="401") by bin(TimeGenerated,1m)
| extend rate = 100.0 * todouble(unauthorized)/todouble(total)
| project TimeGenerated, rate
| order by TimeGenerated asc

Why we need Application Insights if Grafana uses Log Analytics?

Application Insights (AI) is the telemetry SDK & ingestion service for your app.
Your Node.js code sends requests/dependencies/exceptions → AI ingests them.

In workspace-based AI, that telemetry is stored in your Log Analytics Workspace (LAW) in App-schema tables (AppRequests, AppDependencies, …).

Grafana cannot query the AI component directly. Grafana queries LAW (Service: Logs).
So the flow is: App → AI ingestion → LAW storage → Grafana (KQL).

You also used AI Live Metrics (real-time stream). Live Metrics comes from AI, not LAW.

Without AI SDK, you’d miss application-level telemetry (request names, dependency calls, custom events), even if cluster metrics exist.

Summary:

AI = producer + live stream + SDK features (auto-collection, correlation, sampling, live metrics)

LAW = storage + query (KQL)

Grafana = visualization (queries LAW)

Gotchas we hit (and fixes)

KQL table names: used AppRequests/AppDependencies (not requests/dependencies).

Grafana panel config: each panel must explicitly set Service: Logs and select the LAW resource.

Git Bash path rewriting: use MSYS2_ARG_CONV_EXCL to stop mangling --scope /subscriptions/....

ACR auth: needed pull secret in K8s; enabled ACR admin user for quick setup.

ImagePullBackOff / InvalidImageName: fixed tags, ensured lowercase repo, created imagePullSecrets.

No DB: DB panel showed “no data” → replaced with safe zero fallback (or switch to HTTP dependencies).

If you want, I can package the above into a Markdown file with headings you can commit to your repo.
