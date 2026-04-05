# Runtime Automation - Solve Playbooks

This directory contains the playbooks that power the "Solve Module" buttons in the Showroom.

## How It Works

1. **Playbooks are stored in this repo** under `runtime-automation/playbooks/`
2. **The git-cloner init container** pulls the latest version of this repo when the pod starts
3. **The solver sidecar** mounts the playbooks directory from the cloned repo
4. **Solve buttons** trigger API calls to execute the playbooks
5. **Real-time output** is streamed back to the browser via Server-Sent Events (SSE)

## Creating Custom Solve Playbooks

### 1. Create a new playbook file

Create a new YAML file in the `playbooks/` directory:

```bash
cd runtime-automation/playbooks/
touch solve-my-module.yml
```

### 2. Write your Ansible playbook

```yaml
---
- name: Solve My Module
  hosts: localhost
  gather_facts: false
  tasks:
    - name: Display message
      ansible.builtin.debug:
        msg: "Solving my custom module!"

    - name: Get OpenShift namespaces
      kubernetes.core.k8s_info:
        kind: Namespace
      register: namespaces

    - name: Show namespace count
      ansible.builtin.debug:
        msg: "Found {{ namespaces.resources | length }} namespaces"
```

### 3. Add the solve button to your module page

In your AsciiDoc module file (e.g., `content/modules/ROOT/pages/my-module.adoc`):

```asciidoc
== Auto-Solve (POC)

Need help completing this module? Click the button below to automatically solve the exercises:

++++
<div class="solve-button-placeholder" data-module="my-module"></div>
++++
```

**Important:** The `data-module` attribute should match the playbook filename:
- `data-module="my-module"` → `solve-my-module.yml`

### 4. Commit and push

```bash
git add runtime-automation/playbooks/solve-my-module.yml
git commit -m "Add solve playbook for my-module"
git push origin your-branch
```

### 5. Reload the Showroom deployment

The git-cloner will automatically pull the latest code on pod restart:

```bash
oc rollout restart deployment/showroom -n user-sct29-showroom
```

Wait for the new pod to start, and your new solve playbook will be available!

## Playbook Requirements

### Authentication

Playbooks run with the `showroom` ServiceAccount credentials, which has cluster-admin permissions.

The Kubernetes API is automatically configured via the mounted ServiceAccount token.

### Available Ansible Collections

The solver container includes:
- `ansible==9.0.0`
- `kubernetes==28.1.0`
- `openshift==0.13.2`

You can use modules from:
- `kubernetes.core.*` - Kubernetes/OpenShift resources
- `ansible.builtin.*` - Standard Ansible modules

### Environment Variables

Available in playbooks:
- `K8S_AUTH_KUBECONFIG` - Path to kubeconfig (auto-configured)

## Testing Playbooks Locally

You can test playbooks locally if you have:
1. `ansible` installed
2. `oc` CLI logged into the cluster

```bash
cd runtime-automation/playbooks/
ansible-playbook solve-module-01.yml -v
```

## Troubleshooting

### Playbook not found
- Verify the filename matches the button's `data-module` attribute with `solve-` prefix
- Check that the file is committed and pushed to the branch
- Restart the showroom pod to pull latest changes

### Permission denied errors
- The ServiceAccount may need additional RBAC permissions
- Check the solver pod logs: `oc logs -n user-sct29-showroom deployment/showroom -c solver`

### Playbook execution timeout
- Default timeout is 60 seconds
- For longer-running playbooks, adjust the JavaScript timeout in `solve-button.js`

## API Endpoints

The solver sidecar exposes these endpoints:

- `GET /health` - Health check
- `POST /api/solve/<module-name>` - Execute solve playbook (SSE stream)
- `GET /api/playbooks` - List available playbooks

Access at: `http://localhost:5000` (within the pod)
