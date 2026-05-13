import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-docs",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Documents",
  description: "Browse all documents created by agents across issues and projects in one searchable library.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "database.namespace.read",
    "database.namespace.migrate",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "docs",
    migrationsDir: "migrations",
    coreReadTables: ["documents", "issue_documents", "issues", "agents", "projects"],
  },
  ui: {
    slots: [
      { type: "sidebar", id: "docs-sidebar", displayName: "Docs", exportName: "DocsSidebar" },
      { type: "page", id: "docs-page", displayName: "Documents", exportName: "DocsPage" },
    ],
  },
};

export default manifest;
