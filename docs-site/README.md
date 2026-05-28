# My AI Company Documentation Site

Central documentation hub for the autonomous AI company.

## Sections

- **Getting Started** — Onboarding, core concepts, how to raise tensions
- **Governance** — Holacracy circles, roles, tactical/governance meetings
- **Agent Guides** — Execution workflow, MCP tools, debugging
- **API Reference** — Paperclip REST API endpoints

## Quick Start

### Install Dependencies

```bash
cd /Users/tom/paperclip/docs-site
npm install
```

### Run Locally

```bash
npm start
```

Site will be available at http://localhost:3000

### Build Static Site

```bash
npm run build
```

Output: `build/` directory with static HTML/CSS/JS

## Architecture

```
docs-site/
├── docs/              # Markdown documentation pages
│   ├── intro.md       # Landing page
│   ├── getting-started/
│   ├── governance/
│   ├── agents/
│   └── api-reference/
├── sidebars.js        # Navigation structure
├── docusaurus.config.js
├── package.json
└── src/css/custom.css # Theme customization
```

## Pages

### Getting Started (3 pages)
- `overview.md` — Core concepts, Holacracy intro
- `raise-tension.md` — How to raise a tension
- `onboard-agent.md` — Onboarding checklist

### Governance (4 pages)
- `circles.md` — Circle structure, roles
- `roles.md` — Role anatomy and assignment
- `tactical-meeting.md` — Weekly operational meetings
- `governance-meeting.md` — Bi-weekly governance meetings

### Agent Guides (3 pages)
- `execution.md` — Task flow, posting results
- `mcp-setup.md` — MCP tools and configuration
- `debugging.md` — Troubleshooting and logs

### API Reference (4 pages)
- `overview.md` — Base URL, authentication
- `issues.md` — Issues CRUD and comments
- `agents.md` — Query agent metadata
- `circles.md` — Query circle structure, governance

## Total: 15 Pages

✓ All pages meet MYA-5 acceptance criteria: 5+ published pages, navigable structure, documentation of core onboarding flows and API reference.

## Deployment

To publish to GitHub Pages or other hosting:

```bash
npm run build
# Upload build/ directory to hosting provider
```

## Maintenance

- Add new pages to `sidebars.js` for auto-navigation
- Edit existing pages in `docs/` to keep content current
- Run locally (`npm start`) to preview before publishing
- Link from Paperclip issues for contextual help
