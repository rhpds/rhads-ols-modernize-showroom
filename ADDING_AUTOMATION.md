# Adding Solve & Validate Automation to Your Showroom

This guide shows how to add solve and validate automation buttons to a new showroom created from the [showroom_template_nookbag](https://github.com/rhpds/showroom_template_nookbag).

## Overview

The automation system adds interactive "Solve Module" and "Validate Module" buttons to your lab guide that:
- Execute Ansible playbooks in real-time
- Stream output to an embedded terminal in the browser
- Help users automatically complete exercises or verify their work

**Graceful Degradation**: The automation container gracefully handles missing `runtime-automation/` folder by sleeping instead of crashing. This allows you to apply the deployment patch first and add automation features incrementally.

## Prerequisites

- Showroom created from showroom_template_nookbag
- Showroom deployed on OpenShift
- `oc` CLI access with admin privileges

## Architecture

The automation system consists of:
1. **Automation sidecar container** - Runs Flask API server with Ansible
2. **API Server** - Handles `/api/solve/<module>` and `/api/validate/<module>` endpoints
3. **Playbooks** - Ansible playbooks that execute the actual automation
4. **Button Partials** - AsciiDoc components that render buttons and terminals

---

## Step 1: Create Directory Structure

In your showroom repository:

```bash
cd <your-showroom-repo>

# Create runtime automation directories
mkdir -p runtime-automation/playbooks
```

---

## Step 2: Add API Server

**File:** `runtime-automation/api-server.py`

```python
#!/usr/bin/env python3
"""
API server for executing Ansible playbooks and streaming output
"""
import os
import subprocess
import json
from flask import Flask, Response, request, jsonify
from flask_cors import CORS
import threading
import queue
import time

app = Flask(__name__)
CORS(app)

PLAYBOOKS_DIR = "/playbooks"

def run_playbook(playbook_name, output_queue):
    """Execute ansible-playbook and stream output to queue"""
    playbook_path = os.path.join(PLAYBOOKS_DIR, f"{playbook_name}.yml")

    if not os.path.exists(playbook_path):
        output_queue.put(f"ERROR: Playbook {playbook_name}.yml not found\n")
        output_queue.put("__DONE__")
        return

    try:
        process = subprocess.Popen(
            ["ansible-playbook", playbook_path, "-v"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            universal_newlines=True,
            env=os.environ.copy()
        )

        for line in iter(process.stdout.readline, ''):
            if line:
                output_queue.put(line)

        process.wait()

        if process.returncode == 0:
            output_queue.put("\n✓ Playbook completed successfully!\n")
        else:
            output_queue.put(f"\n✗ Playbook failed with exit code {process.returncode}\n")

    except Exception as e:
        output_queue.put(f"\nERROR: {str(e)}\n")
    finally:
        output_queue.put("__DONE__")

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "healthy"}), 200

@app.route('/solve/<module_name>', methods=['GET'])
def solve_module(module_name):
    """Execute solve playbook for a module and stream output"""

    def generate():
        output_queue = queue.Queue()

        thread = threading.Thread(
            target=run_playbook,
            args=(f"solve-{module_name}", output_queue)
        )
        thread.daemon = True
        thread.start()

        yield f"data: Starting solve playbook for {module_name}...\n\n"

        while True:
            try:
                line = output_queue.get(timeout=0.1)
                if line == "__DONE__":
                    break
                yield f"data: {json.dumps(line)}\n\n"
            except queue.Empty:
                yield f": keepalive\n\n"

    return Response(generate(), mimetype='text/event-stream')

@app.route('/validate/<module_name>', methods=['GET'])
def validate_module(module_name):
    """Execute validate playbook for a module and stream output"""

    def generate():
        output_queue = queue.Queue()

        thread = threading.Thread(
            target=run_playbook,
            args=(f"validate-{module_name}", output_queue)
        )
        thread.daemon = True
        thread.start()

        yield f"data: Starting validation playbook for {module_name}...\n\n"

        while True:
            try:
                line = output_queue.get(timeout=0.1)
                if line == "__DONE__":
                    break
                yield f"data: {json.dumps(line)}\n\n"
            except queue.Empty:
                yield f": keepalive\n\n"

    return Response(generate(), mimetype='text/event-stream')

@app.route('/playbooks', methods=['GET'])
def list_playbooks():
    """List available playbooks"""
    playbooks = []
    if os.path.exists(PLAYBOOKS_DIR):
        playbooks = [f for f in os.listdir(PLAYBOOKS_DIR) if f.endswith('.yml')]
    return jsonify({"playbooks": playbooks}), 200


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True, threaded=True)
```

---

## Step 3: Add Package Management Files

**File:** `runtime-automation/requirements.txt`

```txt
# Python packages for automation API server
# Add any additional Python libraries needed here
flask==3.0.0
flask-cors==4.0.0
```

**File:** `runtime-automation/packages.txt`

```txt
# DNF packages for automation container
# The automation container runs as root to enable DNF package installation
# Packages are installed at container startup from this file
#
# Add package names one per line (comments and blank lines are ignored):
# git
# vim-enhanced
#
# Note: Packages are installed on EVERY container restart
# For frequently restarted containers, consider building a custom image instead
```

---

## Step 4: Create Deployment Patch

**File:** `runtime-automation/deployment-patch.yaml`

**IMPORTANT:** Replace `<YOUR_NAMESPACE>` with your actual showroom namespace.

```yaml
---
# Patch to add automation sidecar container to showroom deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: showroom
  namespace: <YOUR_NAMESPACE>  # UPDATE THIS!
spec:
  template:
    spec:
      serviceAccountName: showroom
      containers:
      # Automation sidecar for solve and validate operations
      - name: automation
        image: quay.io/agnosticd/ee-multicloud:chained-2026-04-01
        imagePullPolicy: IfNotPresent
        securityContext:
          runAsUser: 0
          runAsNonRoot: false
        command:
        - /bin/bash
        - -c
        - |
          # Create directory for Python libraries
          mkdir -p /tmp/pylibs

          # Install Python packages from requirements.txt if it exists
          if [ -f /app/requirements.txt ]; then
            echo "Installing Python packages from requirements.txt..."
            /usr/local/bin/pip3 install --target=/tmp/pylibs -r /app/requirements.txt
          else
            echo "No requirements.txt found, skipping Python package installation"
          fi

          # DNF packages from packages.txt (running as root)
          if [ -f /app/packages.txt ]; then
            echo "Installing DNF packages from packages.txt..."
            # Extract non-comment, non-empty lines
            PACKAGES=$(grep -v '^#' /app/packages.txt | grep '^[[:alnum:]]' | tr '\n' ' ')
            if [ -n "$PACKAGES" ]; then
              echo "Installing: $PACKAGES"
              dnf install -y $PACKAGES && dnf clean all
            else
              echo "No packages found in packages.txt"
            fi
          else
            echo "No packages.txt found, skipping DNF package installation"
          fi

          # Add Python libraries to path and run API server
          export PYTHONPATH="/tmp/pylibs:${PYTHONPATH}"
          exec python3 /app/api-server.py
        ports:
        - containerPort: 5000
          protocol: TCP
        env:
        - name: K8S_AUTH_KUBECONFIG
          value: /var/run/secrets/kubernetes.io/serviceaccount/token
        volumeMounts:
        - name: showroom-files
          mountPath: /playbooks
          subPath: repo/runtime-automation/playbooks
          readOnly: true
        - name: showroom-files
          mountPath: /app
          subPath: repo/runtime-automation
          readOnly: true
```

---

## Step 5: Create Example Playbooks

**File:** `runtime-automation/playbooks/solve-module-01.yml`

```yaml
---
- name: Solve Module 01
  hosts: localhost
  gather_facts: false
  tasks:
  - name: Get current namespace
    ansible.builtin.set_fact:
      current_namespace: "{{ lookup('env', 'NAMESPACE') | default('default', true) }}"

  - name: List pods in namespace
    ansible.builtin.command:
      cmd: oc get pods -n {{ current_namespace }}
    register: pods_output
    changed_when: false

  - name: Display pods
    ansible.builtin.debug:
      msg: "{{ pods_output.stdout_lines }}"

  - name: Show completion message
    ansible.builtin.debug:
      msg:
        - "╔════════════════════════════════════════╗"
        - "║     Module 01 - SOLVED                ║"
        - "╚════════════════════════════════════════╝"
```

**File:** `runtime-automation/playbooks/validate-module-01.yml`

```yaml
---
- name: Validate Module 01
  hosts: localhost
  gather_facts: false
  tasks:
  - name: Get current namespace
    ansible.builtin.set_fact:
      current_namespace: "{{ lookup('env', 'NAMESPACE') | default('default', true) }}"

  - name: Check if required pods are running
    ansible.builtin.command:
      cmd: oc get pods -n {{ current_namespace }} -o json
    register: pods_json
    changed_when: false

  - name: Parse pod data
    ansible.builtin.set_fact:
      pods_data: "{{ pods_json.stdout | from_json }}"

  - name: Validate showroom pod exists
    ansible.builtin.assert:
      that:
        - pods_data['items'] | selectattr('metadata.name', 'search', 'showroom') | list | length > 0
      success_msg: "✓ Showroom pod found"
      fail_msg: "✗ Showroom pod not found"

  - name: Validate showroom pod is running
    ansible.builtin.assert:
      that:
        - pods_data['items'] | selectattr('metadata.name', 'search', 'showroom') | map(attribute='status.phase') | list | first == 'Running'
      success_msg: "✓ Showroom pod is running"
      fail_msg: "✗ Showroom pod is not in Running state"

  - name: Display validation summary
    ansible.builtin.debug:
      msg:
        - "╔════════════════════════════════════════╗"
        - "║     Module 01 Validation PASSED       ║"
        - "╚════════════════════════════════════════╝"
        - ""
        - "All checks completed successfully!"
```

---

## Step 6: Create Button Partials

**File:** `content/modules/ROOT/pages/common/solve-button.adoc`

```asciidoc
// Solve Button Component
// Usage: :module-name: module-01
//        include::common/solve-button.adoc[]

[pass,subs="attributes"]
++++
<style>
.solve-section {margin: 2rem 0; padding: 1.5rem; background: #f8f9fa; border: 2px solid #dee2e6; border-radius: 8px;}
.solve-controls {margin-bottom: 1rem;}
.solve-button {padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; transition: all 0.3s ease; background: #28a745; color: white;}
.solve-button:hover:not(:disabled) {background: #218838; transform: translateY(-2px); box-shadow: 0 4px 8px rgba(40, 167, 69, 0.3);}
.solve-button:disabled {background: #adb5bd; cursor: not-allowed; animation: pulse 1.5s ease-in-out infinite;}
.solve-output {margin-top: 1rem; background-color: #000 !important; border-radius: 6px; padding: 1.5rem; max-height: 600px; overflow-y: auto; border: 2px solid #00ff00; box-shadow: 0 0 10px rgba(0, 255, 0, 0.2);}
.solve-output-content {margin: 0 !important; padding: 0 !important; color: #00ff00 !important; background: transparent !important; font-family: 'Courier New', 'Courier', monospace; font-size: 14px; line-height: 1.8; white-space: pre-wrap; word-wrap: break-word; font-weight: 500;}
@keyframes pulse {0%, 100% {opacity: 1;} 50% {opacity: 0.5;}}
</style>

<div class="solve-button-placeholder" data-module="{module-name}"></div>

<script>
(function(){if(typeof window.solveButtonInit!=='undefined')return;window.solveButtonInit=true;function createSolveSection(n){const s=document.createElement('div');s.className='solve-section';s.innerHTML=`<div class="solve-controls"><button class="solve-button" data-module="${n}">🚀 Solve Module</button></div><div class="solve-output" id="solve-output-${n}" style="display:none;"><pre class="solve-output-content" id="solve-output-content-${n}"></pre></div>`;return s}function executePlaybook(n){const o=document.getElementById(`solve-output-${n}`),c=document.getElementById(`solve-output-content-${n}`),b=document.querySelector(`.solve-button[data-module="${n}"]`);o.style.display='block';c.textContent='';b.disabled=true;b.textContent='⏳ Running...';const e=new EventSource(`/api/solve/${n}`);e.onmessage=function(d){try{const l=JSON.parse(d.data);c.textContent+=l}catch(x){c.textContent+=d.data+'\n'}o.scrollTop=o.scrollHeight};e.onerror=function(){console.error('SSE Error');e.close();b.disabled=false;b.textContent='🚀 Solve Module';c.textContent+='\n❌ Connection closed\n'};setTimeout(()=>{e.close();b.disabled=false;b.textContent='🚀 Solve Module'},60000)}document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('.solve-button-placeholder').forEach(p=>{const m=p.getAttribute('data-module'),s=createSolveSection(m);p.replaceWith(s)});document.querySelectorAll('.solve-button').forEach(b=>{b.addEventListener('click',function(){executePlaybook(this.getAttribute('data-module'))})})})})();
</script>
++++
```

**File:** `content/modules/ROOT/pages/common/validate-button.adoc`

```asciidoc
// Validate Button Component
// Usage: :module-name: module-01
//        include::common/validate-button.adoc[]

[pass,subs="attributes"]
++++
<style>
.validate-section {margin: 2rem 0; padding: 1.5rem; background: #f8f9fa; border: 2px solid #dee2e6; border-radius: 8px;}
.validate-controls {margin-bottom: 1rem;}
.validate-button {padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; transition: all 0.3s ease; background: #007bff; color: white;}
.validate-button:hover:not(:disabled) {background: #0056b3; transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0, 123, 255, 0.3);}
.validate-button:disabled {background: #adb5bd; cursor: not-allowed; animation: pulse 1.5s ease-in-out infinite;}
.validate-output {margin-top: 1rem; background-color: #000 !important; border-radius: 6px; padding: 1.5rem; max-height: 600px; overflow-y: auto; border: 2px solid #00bfff; box-shadow: 0 0 10px rgba(0, 191, 255, 0.2);}
.validate-output-content {margin: 0 !important; padding: 0 !important; color: #00bfff !important; background: transparent !important; font-family: 'Courier New', 'Courier', monospace; font-size: 14px; line-height: 1.8; white-space: pre-wrap; word-wrap: break-word; font-weight: 500;}
@keyframes pulse {0%, 100% {opacity: 1;} 50% {opacity: 0.5;}}
</style>

<div class="validate-button-placeholder" data-module="{module-name}"></div>

<script>
(function(){if(typeof window.validateButtonInit!=='undefined')return;window.validateButtonInit=true;function createValidateSection(n){const s=document.createElement('div');s.className='validate-section';s.innerHTML=`<div class="validate-controls"><button class="validate-button" data-module="${n}">✓ Validate Module</button></div><div class="validate-output" id="validate-output-${n}" style="display:none;"><pre class="validate-output-content" id="validate-output-content-${n}"></pre></div>`;return s}function executeValidation(n){const o=document.getElementById(`validate-output-${n}`),c=document.getElementById(`validate-output-content-${n}`),b=document.querySelector(`.validate-button[data-module="${n}"]`);o.style.display='block';c.textContent='';b.disabled=true;b.textContent='⏳ Validating...';const e=new EventSource(`/api/validate/${n}`);e.onmessage=function(d){try{const l=JSON.parse(d.data);c.textContent+=l}catch(x){c.textContent+=d.data+'\n'}o.scrollTop=o.scrollHeight};e.onerror=function(){console.error('SSE Error');e.close();b.disabled=false;b.textContent='✓ Validate Module';c.textContent+='\n❌ Connection closed\n'};setTimeout(()=>{e.close();b.disabled=false;b.textContent='✓ Validate Module'},60000)}document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('.validate-button-placeholder').forEach(p=>{const m=p.getAttribute('data-module'),s=createValidateSection(m);p.replaceWith(s)});document.querySelectorAll('.validate-button').forEach(b=>{b.addEventListener('click',function(){executeValidation(this.getAttribute('data-module'))})})})})();
</script>
++++
```

**File:** `content/modules/ROOT/pages/common/automation-buttons.adoc`

```asciidoc
// Automation Buttons Component (Solve + Validate)
// Usage: :module-name: module-01
//        include::common/automation-buttons.adoc[]

[pass,subs="attributes"]
++++
<style>
.automation-section {margin: 2rem 0; padding: 1.5rem; background: #f8f9fa; border: 2px solid #dee2e6; border-radius: 8px;}
.automation-controls {margin-bottom: 1rem; display: flex; gap: 1rem;}
.solve-button {padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; transition: all 0.3s ease; background: #28a745; color: white;}
.solve-button:hover:not(:disabled) {background: #218838; transform: translateY(-2px); box-shadow: 0 4px 8px rgba(40, 167, 69, 0.3);}
.solve-button:disabled {background: #adb5bd; cursor: not-allowed; animation: pulse 1.5s ease-in-out infinite;}
.validate-button {padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; transition: all 0.3s ease; background: #007bff; color: white;}
.validate-button:hover:not(:disabled) {background: #0056b3; transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0, 123, 255, 0.3);}
.validate-button:disabled {background: #adb5bd; cursor: not-allowed; animation: pulse 1.5s ease-in-out infinite;}
.automation-output {margin-top: 1rem; background-color: #000 !important; border-radius: 6px; padding: 1.5rem; max-height: 600px; overflow-y: auto; border: 2px solid #00ff00; box-shadow: 0 0 10px rgba(0, 255, 0, 0.2);}
.automation-output.validate {border-color: #00bfff; box-shadow: 0 0 10px rgba(0, 191, 255, 0.2);}
.automation-output-content {margin: 0 !important; padding: 0 !important; color: #00ff00 !important; background: transparent !important; font-family: 'Courier New', 'Courier', monospace; font-size: 14px; line-height: 1.8; white-space: pre-wrap; word-wrap: break-word; font-weight: 500;}
.automation-output.validate .automation-output-content {color: #00bfff !important;}
@keyframes pulse {0%, 100% {opacity: 1;} 50% {opacity: 0.5;}}
</style>

<div class="automation-button-placeholder" data-module="{module-name}"></div>

<script>
(function(){if(typeof window.automationButtonInit!=='undefined')return;window.automationButtonInit=true;function createAutomationSection(n){const s=document.createElement('div');s.className='automation-section';s.innerHTML=`<div class="automation-controls"><button class="solve-button" data-module="${n}">🚀 Solve Module</button><button class="validate-button" data-module="${n}">✓ Validate Module</button></div><div class="automation-output" id="automation-output-${n}" style="display:none;"><pre class="automation-output-content" id="automation-output-content-${n}"></pre></div>`;return s}function executePlaybook(n,t){const o=document.getElementById(`automation-output-${n}`),c=document.getElementById(`automation-output-content-${n}`),sb=document.querySelector(`.solve-button[data-module="${n}"]`),vb=document.querySelector(`.validate-button[data-module="${n}"]`);o.style.display='block';o.className=t==='validate'?'automation-output validate':'automation-output';c.textContent='';sb.disabled=true;vb.disabled=true;const ab=t==='solve'?sb:vb;ab.textContent=t==='solve'?'⏳ Running...':'⏳ Validating...';const e=new EventSource(`/api/${t}/${n}`);e.onmessage=function(d){try{const l=JSON.parse(d.data);c.textContent+=l}catch(x){c.textContent+=d.data+'\n'}o.scrollTop=o.scrollHeight};e.onerror=function(){console.error('SSE Error');e.close();sb.disabled=false;vb.disabled=false;sb.textContent='🚀 Solve Module';vb.textContent='✓ Validate Module';c.textContent+='\n❌ Connection closed\n'};setTimeout(()=>{e.close();sb.disabled=false;vb.disabled=false;sb.textContent='🚀 Solve Module';vb.textContent='✓ Validate Module'},60000)}document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('.automation-button-placeholder').forEach(p=>{const m=p.getAttribute('data-module'),s=createAutomationSection(m);p.replaceWith(s)});document.querySelectorAll('.solve-button').forEach(b=>{b.addEventListener('click',function(){executePlaybook(this.getAttribute('data-module'),'solve')})});document.querySelectorAll('.validate-button').forEach(b=>{b.addEventListener('click',function(){executePlaybook(this.getAttribute('data-module'),'validate')})})})})();
</script>
++++
```

---

## Step 7: Add Buttons to Your Module Pages

Edit your module page (e.g., `content/modules/ROOT/pages/module-01.adoc`) and add buttons at the end:

**Option 1: Both buttons together (recommended)**
```asciidoc
== Auto-Solve & Validate

Need help or want to verify your work? Use the buttons below:

:module-name: module-01
include::common/automation-buttons.adoc[]
```

**Option 2: Separate buttons**
```asciidoc
== Auto-Solve

Need help completing this module? Click the button below:

:module-name: module-01
include::common/solve-button.adoc[]

== Validate

Want to verify you completed the exercises correctly?

:module-name: module-01
include::common/validate-button.adoc[]
```

---

## Step 8: Deploy to OpenShift

```bash
# 1. Update namespace in deployment-patch.yaml
export NAMESPACE="your-showroom-namespace"
sed -i "s/<YOUR_NAMESPACE>/$NAMESPACE/g" runtime-automation/deployment-patch.yaml

# 2. Apply the deployment patch
oc apply -f runtime-automation/deployment-patch.yaml

# 3. Grant anyuid SCC to showroom service account (required for root container)
oc adm policy add-scc-to-user anyuid -z showroom -n $NAMESPACE

# 4. Delete pod to trigger restart with new configuration
oc delete pod -l app=showroom -n $NAMESPACE

# 5. Wait for pod to start
oc get pods -n $NAMESPACE -w
```

---

## Step 9: Verify Deployment

```bash
# Check pod is running with 3 containers
oc get pods -n $NAMESPACE

# Should show: nginx, content, automation

# Check automation container logs
POD=$(oc get pods -l app=showroom -n $NAMESPACE -o jsonpath='{.items[0].metadata.name}')
oc logs $POD -c automation -n $NAMESPACE

# Test API endpoints
oc exec $POD -c automation -n $NAMESPACE -- curl -s http://localhost:5000/health
oc exec $POD -c automation -n $NAMESPACE -- curl -s http://localhost:5000/playbooks
```

Expected output:
```json
{
  "status": "healthy"
}

{
  "playbooks": [
    "solve-module-01.yml",
    "validate-module-01.yml"
  ]
}
```

---

## Adding More Modules

For each new module:

1. **Create playbooks:**
   - `runtime-automation/playbooks/solve-module-XX.yml`
   - `runtime-automation/playbooks/validate-module-XX.yml`

2. **Add buttons to module page:**
   ```asciidoc
   :module-name: module-XX
   include::common/automation-buttons.adoc[]
   ```

3. **Commit and push** - the git-cloner init container will pull new playbooks automatically

4. **Restart pod** to pick up new git content:
   ```bash
   oc delete pod -l app=showroom -n $NAMESPACE
   ```

---

## Convention-Based Routing

The system uses convention-based mapping:
- Button: `data-module="module-01"`
- Solve endpoint: `/api/solve/module-01`
- Solve playbook: `playbooks/solve-module-01.yml`
- Validate endpoint: `/api/validate/module-01`
- Validate playbook: `playbooks/validate-module-01.yml`

---

## Adding Dependencies

### Python Libraries

Edit `runtime-automation/requirements.txt`:
```txt
flask==3.0.0
flask-cors==4.0.0
ansible-runner==2.3.0  # Add new package
requests==2.31.0       # Add another
```

### DNF Packages

Edit `runtime-automation/packages.txt`:
```txt
git
vim-enhanced
jq
```

Restart the pod to install new packages:
```bash
oc delete pod -l app=showroom -n $NAMESPACE
```

---

## Troubleshooting

**Buttons don't appear:**
- Check `:module-name:` attribute is set before `include::` statement
- Verify partial path is correct (`common/automation-buttons.adoc`)

**Playbook not found:**
- Check playbook naming: `solve-module-XX.yml` or `validate-module-XX.yml`
- Verify playbook is in `runtime-automation/playbooks/`
- Check logs: `oc logs $POD -c automation`

**Permission denied:**
- Verify anyuid SCC: `oc get scc anyuid -o yaml | grep -A10 users`
- Check `runAsUser: 0` in deployment-patch.yaml

**Module not found errors:**
- Check NAMESPACE environment variable is set in playbooks
- Default namespace: `user-sct29-showroom` (update to your namespace)

**JSON parsing errors in playbooks:**
- Use bracket notation for dict fields: `pods_data['items']` not `pods_data.items`
- Ansible treats `.items` as Python dict method

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│  Showroom Pod                                       │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   nginx     │  │   content   │  │ automation │ │
│  │   (proxy)   │  │  (antora)   │  │  (flask +  │ │
│  │             │  │             │  │   ansible) │ │
│  └─────────────┘  └─────────────┘  └────────────┘ │
│         │                │                 │       │
│         │                │                 │       │
│  ┌──────▼────────────────▼─────────────────▼────┐ │
│  │         showroom-files volume                │ │
│  │         (git-cloner init container)          │ │
│  └──────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
                         │
                         │
                    User Browser
        ┌────────────────┴────────────────┐
        │                                  │
   🚀 Solve Module              ✓ Validate Module
        │                                  │
        │                                  │
   /api/solve/module-01        /api/validate/module-01
        │                                  │
        └──────────────┬───────────────────┘
                       │
              Streams output via SSE
              (Server-Sent Events)
```

---

## Reference Implementation

Full working example: https://github.com/rhpds/rhads-ols-modernize-showroom/tree/poc-solve-button-realtime

Key files to reference:
- `runtime-automation/api-server.py`
- `runtime-automation/deployment-patch.yaml`
- `content/modules/ROOT/pages/common/automation-buttons.adoc`
- `runtime-automation/playbooks/solve-module-*.yml`
- `runtime-automation/playbooks/validate-module-*.yml`

---

## Summary

You now have:
- ✅ Interactive solve/validate buttons in your lab guide
- ✅ Real-time streaming output to browser
- ✅ Ansible playbook execution infrastructure
- ✅ Flexible button layouts (combined or separate)
- ✅ Convention-based module mapping
- ✅ Runtime package management

Happy automating! 🚀
