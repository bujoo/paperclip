---
name: holacracy-onboard-agent
description: Hire and onboard a new agent into a Holacracy circle. Use when you need to fill a vacant role or create a new custom role in your circle.
---

# Holacracy Agent Onboarding

Use this skill when you need to add a new agent to your circle. This is a Circle Lead accountability -- only Circle Leads can assign agents to roles.

## Prerequisites

- You must be the Circle Lead of the target circle
- You must have `canCreateAgents` permission (check via PaperclipMe)

## Step 1: Evaluate the Need

Before creating an agent, check your circle's current state:

1. Use `holacracy-get-circle` with your circle ID to see existing roles
2. Identify the gap: is this a vacant structural role (Circle Lead/Facilitator/Secretary/Circle Rep) or a new custom role?
3. For structural roles: the role already exists, you just need to hire and assign
4. For custom roles: you need to define the role first

## Step 2: Define the Role

For custom roles, decide:
- **Role name**: Use specialist names (not "Director" or "Lead")
- **Purpose**: One sentence describing why this role exists
- **Accountabilities**: Ongoing activities expected from this role (3-6 items)
- **Domains**: Assets/processes this role exclusively controls (0-3 items)

## Step 3: Create the Role and Get Instructions Template

Use the `holacracy-onboard-agent` tool:

```
holacracy-onboard-agent({
  circleId: "<your-circle-id>",
  agentName: "<agent-name>",
  roleName: "<role-name>",
  rolePurpose: "<purpose>",
  roleAccountabilities: ["accountability 1", "accountability 2", ...],
  roleDomains: ["domain 1", ...]
})
```

This creates the role in the circle and returns:
- The role ID
- A complete `holacracy-role.md` template with circle context (team, strategy, policies)
- Next steps for completing the onboarding

## Step 4: Create the Agent

Use the `paperclip-create-agent` skill to create the agent. Key configuration:

- **name**: The agent name from Step 2
- **role**: "general" (the Paperclip system role, not the Holacracy role)
- **title**: "{Role Name} - {Circle Name}"
- **reportsTo**: Your agent ID (the Circle Lead)
- **capabilities**: Description of what this agent can do

## Step 5: Assign and Configure

After creating the agent:

1. **Assign to the Holacracy role**:
   ```
   PATCH /api/plugins/paperclipai.plugin-holacracy/api/circles/{circleId}/roles/{roleId}/assign
   Body: {"companyId": "<company-id>", "agentId": "<new-agent-id>"}
   ```

2. **Push holacracy-role.md** (use the template from Step 3):
   ```
   PUT /api/agents/{agentId}/instructions-bundle/file
   Body: {"path": "holacracy-role.md", "content": "<the holacracyRoleMd from Step 3>"}
   ```

3. **Log the onboarding**:
   ```
   holacracy-log-action({
     circleId: "<circle-id>",
     actionType: "role-change",
     detail: "Onboarded {agent-name} as {role-name}"
   })
   ```

## Step 6: Verify

Use `holacracy-get-circle` to confirm the new role appears with the agent assigned.

## Naming Conventions

- Circle Lead agents: use "Lead" (e.g., "Product Lead", "Growth Lead")
- All other agents: use specialist names (e.g., "Code Expert", "Brand Editor", "Growth Hacker")
- Never use "Director" or "Manager" -- these imply hierarchy

## Constraints (from Holacracy v5 Constitution)

- The Circle Rep CANNOT also serve as Circle Lead in the same circle
- New roles require governance process approval for structural roles; Circle Leads can create custom roles
- The agent should report to you (the Circle Lead) in the Paperclip hierarchy
- Every onboarding action is logged to the audit trail
