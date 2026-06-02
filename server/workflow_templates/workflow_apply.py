#!/usr/bin/env python3
"""
workflow_apply.py — Apply a workflow template to an issue by creating sub-issues.

Usage:
    python3 workflow_apply.py <parent_issue_id> <template_id>

Examples:
    python3 workflow_apply.py MYA-200 feature-request-pipeline
    python3 workflow_apply.py MYA-201 research-request-pipeline

Requires: PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID env vars.
"""
import os, sys, json, requests, warnings
warnings.filterwarnings("ignore")

API_KEY = os.getenv("PAPERCLIP_API_KEY", "")
COMPANY = os.getenv("PAPERCLIP_COMPANY_ID", "46cad2c0-19f3-4a22-95d1-c5f3dcb0f096")
BASE = "http://100.84.164.59:3100/api"
TEMPLATES_FILE = os.path.join(os.path.dirname(__file__), "templates.json")

H = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

def get(path, params=None):
    r = requests.get(f"{BASE}{path}", headers=H, params=params)
    r.raise_for_status()
    return r.json()

def post(path, data):
    r = requests.post(f"{BASE}{path}", headers=H, json=data)
    r.raise_for_status()
    return r.json()

def load_template(template_id):
    with open(TEMPLATES_FILE) as f:
        lib = json.load(f)
    for t in lib["templates"]:
        if t["id"] == template_id:
            return t
    return None

def get_issue(issue_id):
    # Try by identifier first
    issues = get(f"/companies/{COMPANY}/issues", {"q": issue_id})
    if isinstance(issues, list):
        for i in issues:
            if i.get("identifier") == issue_id or i.get("id") == issue_id:
                return i
    # Try direct
    try:
        return get(f"/issues/{issue_id}")
    except Exception:
        return None

def role_to_agent(role_name):
    """Map role name to agent ID. Returns None if no match."""
    agents = get(f"/companies/{COMPANY}/agents")
    if not isinstance(agents, list):
        agents = agents.get("agents", [])
    role_lower = role_name.lower().replace(" ", "")
    for a in agents:
        name_lower = a.get("name","").lower().replace(" ","")
        if role_lower in name_lower or name_lower in role_lower:
            return a["id"]
    return None

def apply_workflow(parent_issue_id, template_id, dry_run=False):
    template = load_template(template_id)
    if not template:
        print(f"ERROR: template '{template_id}' not found")
        print("Available templates:")
        with open(TEMPLATES_FILE) as f:
            lib = json.load(f)
        for t in lib["templates"]:
            print(f"  {t['id']}: {t['name']}")
        sys.exit(1)

    parent = get_issue(parent_issue_id)
    if not parent:
        print(f"ERROR: issue '{parent_issue_id}' not found")
        sys.exit(1)

    parent_id = parent["id"]
    parent_identifier = parent.get("identifier", parent_issue_id)
    project_id = parent.get("projectId")

    print(f"Applying '{template['name']}' to {parent_identifier}")
    print(f"  Parent ID: {parent_id}")
    print(f"  Steps: {len(template['steps'])}")
    print()

    created = []
    for step in template["steps"]:
        agent_id = role_to_agent(step["role_name"])
        title = f"[{parent_identifier}] {step['role_name']} - {step['title']}"
        
        inputs_str = "\n".join(f"- {i}" for i in step.get("inputs", []))
        outputs_str = "\n".join(f"- {o}" for o in step.get("outputs", []))
        description = (
            f"Part of workflow: **{template['name']}** (step {step['step_number']}/{len(template['steps'])})\n\n"
            f"**Inputs required:**\n{inputs_str}\n\n"
            f"**Outputs expected:**\n{outputs_str}\n\n"
            f"SLA: {step.get('sla_days', 1)} day(s)"
        )

        issue_data = {
            "title": title,
            "description": description,
            "parentId": parent_id,
            "status": "backlog",
            "priority": parent.get("priority", "medium"),
        }
        if project_id:
            issue_data["projectId"] = project_id
        if agent_id:
            issue_data["assigneeAgentId"] = agent_id

        print(f"  Step {step['step_number']}: {title[:70]}")
        print(f"    Assign to: {step['role_name']} -> {agent_id or 'UNMATCHED'}")

        if not dry_run:
            result = post(f"/companies/{COMPANY}/issues", issue_data)
            issue_identifier = result.get("identifier", result.get("id","?"))
            print(f"    Created: {issue_identifier}")
            created.append(result)
        else:
            print(f"    [DRY RUN — not created]")
        print()

    return created

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    
    parent_issue_id = sys.argv[1]
    template_id = sys.argv[2]
    dry_run = "--dry-run" in sys.argv

    if dry_run:
        print("[DRY RUN MODE]\n")

    created = apply_workflow(parent_issue_id, template_id, dry_run=dry_run)
    
    if not dry_run and created:
        print(f"Done. Created {len(created)} sub-issues.")
