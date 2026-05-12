#!/usr/bin/env python3
import json, uuid, urllib.request

API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZTQ1NGEyZC0zNzk0LTQ1NzgtOGIzOC1kYWE4OTg0ODBhYTciLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiNjVmZDdkOWItNjBlOS00ZTI0LWIzODAtZjg5NDI2ZjlkMDEyIiwiaWF0IjoxNzcxOTIwMTU3fQ.PbRTWBW-I7byrmQWlwWPWre9H6N16ayN1gFxrOoR7Eo"
WORKFLOW_ID = "EQ3scc5G9K0Eh8za"
N8N_URL = f"http://localhost:5678/api/v1/workflows/{WORKFLOW_ID}"

def api_call(method, url, body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("X-N8N-API-KEY", API_KEY)
    req.add_header("Accept", "application/json")
    if body:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
        req.data = data
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

# Fetch current workflow
print("Fetching workflow...")
wf = api_call("GET", N8N_URL)

# Remove 'Respond to Webhook' node from root nodes
callback_id = str(uuid.uuid4())
callback_node = {
    "parameters": {
        "method": "POST",
        "url": "http://host.docker.internal:3000/callback",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ {\"sessionId\": $('Webhook').first().json.query.sessionId, \"html\": $json.html, \"insights\": $json.insights} }}",
        "options": {}
    },
    "type": "n8n-nodes-base.httpRequest",
    "typeVersion": 4.2,
    "position": [2128, -656],
    "id": callback_id,
    "name": "Callback to Server"
}

# Replace Respond to Webhook with Callback node
for i, node in enumerate(wf.get("nodes", [])):
    if node.get("name") == "Respond to Webhook":
        wf["nodes"][i] = callback_node
        print(f"Replaced 'Respond to Webhook' with 'Callback to Server' at index {i}")
        break
else:
    wf["nodes"].append(callback_node)
    print("Added 'Callback to Server' node (Respond to Webhook not found in root nodes)")

# Update connections in root: Shape Output -> Callback to Server (instead of Respond to Webhook)
connections = wf.get("connections", {})
if "Shape Output" in connections:
    for conn_list in connections["Shape Output"].get("main", []):
        for conn in conn_list:
            if conn.get("node") == "Respond to Webhook":
                conn["node"] = "Callback to Server"
                print("Updated root connection: Shape Output -> Callback to Server")

# Remove any connections TO Respond to Webhook (none expected, but clean up)
for src, types in list(connections.items()):
    for conn_type, conn_lists in list(types.items()):
        for conn_list in conn_lists:
            for conn in conn_list:
                if conn.get("node") == "Respond to Webhook":
                    conn["node"] = "Callback to Server"

# Also update activeVersion
av = wf.get("activeVersion")
if av and av.get("nodes"):
    for i, node in enumerate(av["nodes"]):
        if node.get("name") == "Respond to Webhook":
            av["nodes"][i] = callback_node
            print(f"Updated activeVersion node at index {i}")
            break
    
    av_connections = av.get("connections", {})
    if "Shape Output" in av_connections:
        for conn_list in av_connections["Shape Output"].get("main", []):
            for conn in conn_list:
                if conn.get("node") == "Respond to Webhook":
                    conn["node"] = "Callback to Server"
                    print("Updated activeVersion connection: Shape Output -> Callback to Server")
    
    for src, types in list(av_connections.items()):
        for conn_type, conn_lists in list(types.items()):
            for conn_list in conn_lists:
                for conn in conn_list:
                    if conn.get("node") == "Respond to Webhook":
                        conn["node"] = "Callback to Server"

# Build minimal update payload
payload = {
    "name": wf["name"],
    "nodes": wf["nodes"],
    "connections": wf["connections"],
    "settings": wf.get("settings", {}),
}
if wf.get("tags"):
    payload["tags"] = wf["tags"]

print("\nUpdating workflow via API...")
try:
    result = api_call("PUT", N8N_URL, payload)
    print("Update successful!")
    # Verify callback node exists
    for node in result.get("nodes", []):
        if node.get("name") == "Callback to Server":
            print(f"Verified: Callback to Server node exists (type={node.get('type')})")
            break
    else:
        print("Warning: Callback to Server node not found in response")
except Exception as e:
    print(f"Error: {e}")
