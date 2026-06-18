# n8n Workflow Explanation: `logistics` (`dsAmcpSQZgFTJClC`)
This document is a handoff/reference for AI agents that need to inspect, debug, or extend the logistics workflow currently running in n8n.
## Source of truth
- n8n API base: `http://localhost:5678/api/v1`
- Workflow ID: `dsAmcpSQZgFTJClC`
- Workflow name (current): `logistics`
- Active: `true` at lookup time
## Authentication pattern used in this repo
- Existing script `update_workflow_callback.py` uses header auth:
  - `X-N8N-API-KEY: <token>`
- For safe reuse, set an env var and avoid hardcoding secrets:
  - `N8N_API_KEY={{N8N_API_KEY}}`
## Entry points
- `Webhook` (`POST` path: `analyze-excel`)
- `Webhook1` (`POST` path: `logistics-python`)
These feed into the same processing pipeline (`Split Binary Files`).
## High-level flow
1. **Input & parsing**
   - `Webhook/Webhook1` → `Split Binary Files` (Code node)
   - `Split Binary Files` → `Extract from File` (reads each file)
   - `Extract from File` → `Aggregate Files` (builds structural summary)
2. **Prompt/model parameter injection**
   - `Call 'get params'1` (Execute Workflow) fetches prompt/model params for `Generate Analysis Code`
   - `Generate Analysis Code` (LangChain Agent + `OpenRouter Chat Model`) produces analysis code text
3. **Code execution & shaping**
   - `Run Analysis Code` executes generated JS in sandboxed `new Function(...)`
   - `Shape Response` normalizes result payload
4. **Human-in-the-loop approval branch**
   - `Code in JavaScript` builds approval payload (`requestId`, `resumeUrl`, summary)
   - `HTTP Request` sends approval request
   - `Wait` pauses until callback/resume
   - `If` routes:
     - approved → continue to report generation
     - rejected → `HIL-reject` → `Callback to Server`
5. **Final report generation**
   - `Call get params` + `Analysis Agent` (+ `OpenRouter Chat Model2`) generate HTML-style analysis
   - `Call 'get params'` + `Insights Agent` (+ `OpenRouter Chat Model1` + `Structured Output Parser1`) generate insights list
   - `Merge HTML & Insights` + `Shape Output`
   - `Callback to Server` posts final `{requestId, html, insights}` to backend callback URL
## Important node behaviors
## `Run Analysis Code` (Code node)
- Reads generated code from `Generate Analysis Code`
- Strips markdown fences (```javascript / ```js / ```)
- Executes in isolated function scope
- Returns one JSON result item, including error details if execution fails
## `Code in JavaScript` (approval payload)
- Builds:
  - `requestId` from webhook query
  - `$execution.resumeUrl` for approval callback
  - compact analysis summary text
- Sends payload used by external approval system
## `Shape Output`
- Pulls final outputs directly from agent nodes by name:
  - `Analysis Agent` → `html`
  - `Insights Agent` → `insights`
- Prevents merge-overlay ambiguity and returns canonical output structure
## Callback contract
- `Callback to Server` (`HTTP Request`, method `POST`)
- URL (current): `http://localhost:3000/callback`
- Body (JSON expression):
  - `requestId`: from webhook query
  - `html`: rendered report
  - `insights`: insights array/object
## External dependencies
- **Sub-workflow dependency** (`Execute Workflow` nodes):
  - Workflow ID: `IthSCBiROajs0L0L` (named `get params`)
  - Called with:
    - `workflow_id={{ $workflow.id }}`
    - `node_name` one of:
      - `Generate Analysis Code`
      - `Analysis Agent`
      - `Insights Agent`
- **Model providers**
  - `@n8n/n8n-nodes-langchain.lmChatOpenRouter` nodes
  - Default model fallbacks are embedded in node expressions
## Why this is named “python” although code nodes are JS
- Workflow path includes `logistics-python`, and approval text references “Python”.
- Current executable Code-node scripts are JavaScript (`jsCode`) in n8n.
- If true Python execution is required, check whether generated content targets Python syntax and whether downstream execution is expecting JS; currently `Run Analysis Code` executes JS.
## Quick API operations for future agents
Use placeholders and set secrets via env vars.
```bash
N8N_API_KEY={{N8N_API_KEY}}
curl -sS -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "http://localhost:5678/api/v1/workflows/dsAmcpSQZgFTJClC"
```
```bash
N8N_API_KEY={{N8N_API_KEY}}
curl -sS -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "http://localhost:5678/api/v1/workflows?limit=250"
```
## Agent checklist before editing this workflow
1. Fetch latest workflow JSON by ID.
2. Confirm callback URL and approval branch are still present.
3. Confirm sub-workflow `IthSCBiROajs0L0L` still resolves.
4. Validate node-name references used in expressions (`$('Node Name')...`) after any rename.
5. After update, run a full webhook test through approval and callback path.
