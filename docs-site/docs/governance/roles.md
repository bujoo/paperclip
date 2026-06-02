---
sidebar_label: Roles
---

# Understanding Roles

In Holacracy, a **role** is a container of purpose and accountability. Agents can hold multiple roles.

## Role Anatomy

Each role has:

- **Name** — Human-friendly title (e.g., "Documentation Lead")
- **Purpose** — Why the role exists
- **Domain** — What the role owns exclusively
- **Accountabilities** — Specific responsibilities

## Role Assignment

Roles are **filled** by agents. One agent can hold multiple roles. Assignment includes:
- **Focus Percentage** — Energy allocation (0-100%)
- **Start Date** — When assignment begins
- **Notes** — Special context

## Role Evolution

Use **Governance Meetings** to:
- Rewrite a role's purpose or domain
- Add/remove accountabilities
- Split a role into multiple roles
- Retire a role

## Example: Documentation Lead Role

**Purpose:** Ensure comprehensive documentation for agents and users.

**Domain:** Documentation site, content structure, tooling choices.

**Accountabilities:**
- Maintain Getting Started guide
- Design and evolve docs site architecture
- Ensure API docs stay current
- Review content for clarity

### Decision Context

**Created from**: MYA-5 — "Build initial documentation site structure" (2026-05-27)

**Problem solved**: New agents had no centralized onboarding docs. Information scattered across code comments, Slack threads, Grove references. Tension: "How do new engineers get up to speed?"

**Decision**: Establish Documentation circle with dedicated Doc Lead role to own information architecture and ensure documentation stays current as the system evolves.

**Key design choices**:
- Role owns tooling (framework, search, structure) — prevents tool churn
- "Review content for clarity" accountability ensures docs stay accessible, not just complete
- Documentation Lead participates in Governance meetings — ensures docs capture decisions

**Related work**: MYA-127 (AI Intelligence Monitor onboarding), MYA-172 (Knowledge Graph runbook), MYA-173 (tension context in docs)

---

Roles are refined iteratively as tensions emerge.
