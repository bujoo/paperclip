import React, { useState, useEffect, useCallback } from "react";
import { usePluginData, usePluginAction, useHostContext } from "@paperclipai/plugin-sdk/ui";

interface McpServer {
  id: string;
  company_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  transport_type: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  transport_url: string | null;
  source: "manual" | "discovered";
  scope: "company" | "agent";
  agent_id: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface DiscoveredServer {
  name: string;
  transportType: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  transportUrl: string | null;
  configPath: string;
}

interface McpAssignment {
  id: string;
  agent_id: string;
  mcp_server_id: string;
  enabled: boolean;
  name: string;
  display_name: string | null;
  transport_type: string;
  command: string | null;
  args: string[];
  transport_url: string | null;
  server_description: string | null;
}

interface FormState {
  name: string;
  displayName: string;
  description: string;
  command: string;
  args: string;
  transportType: "stdio" | "http" | "sse";
  transportUrl: string;
  envText: string;
}

const emptyForm: FormState = {
  name: "",
  displayName: "",
  description: "",
  command: "",
  args: "",
  transportType: "stdio",
  transportUrl: "",
  envText: "",
};

const transportBadgeStyle: Record<string, React.CSSProperties> = {
  stdio: { background: "rgba(59,130,246,0.15)", color: "rgb(96,165,250)" },
  http: { background: "rgba(34,197,94,0.15)", color: "rgb(74,222,128)" },
  sse: { background: "rgba(168,85,247,0.15)", color: "rgb(192,132,252)" },
};

const badge: React.CSSProperties = {
  fontSize: 10, padding: "1px 6px", borderRadius: 3, fontWeight: 600, textTransform: "uppercase" as const,
};

// ─── Main Page ───

export function McpManagerPage() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleteConfirm, setDeleteConfirm] = useState<McpServer | null>(null);
  const [saving, setSaving] = useState(false);

  const [syncing, setSyncing] = useState(false);

  const { data: servers, loading, refresh } = usePluginData<McpServer[]>("mcp-servers-list", {
    companyId: companyId ?? "",
  });

  const { data: discovered, refresh: refreshDiscovered } = usePluginData<DiscoveredServer[]>("discovered-servers", {});

  const pluginBase = `/api/plugins/paperclipai.plugin-mcp-manager/api`;

  const apiCall = useCallback(async (method: string, path: string, body?: unknown) => {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${pluginBase}${path}`, opts);
    return res.json();
  }, [pluginBase]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(server: McpServer) {
    setEditingId(server.id);
    const envObj = typeof server.env === "string" ? JSON.parse(server.env) : (server.env || {});
    setForm({
      name: server.name,
      displayName: server.display_name || "",
      description: server.description || "",
      command: server.command || "",
      args: Array.isArray(server.args) ? server.args.join(" ") : "",
      transportType: server.transport_type,
      transportUrl: server.transport_url || "",
      envText: Object.entries(envObj).map(([k, v]) => `${k}=${v}`).join("\n"),
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!companyId) return;
    setSaving(true);

    const envMap: Record<string, string> = {};
    form.envText.split("\n").filter(Boolean).forEach(line => {
      const idx = line.indexOf("=");
      if (idx > 0) envMap[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    const payload = {
      companyId,
      name: form.name,
      displayName: form.displayName || null,
      description: form.description || null,
      command: form.command || null,
      args: form.args.split(/\s+/).filter(Boolean),
      env: envMap,
      transportType: form.transportType,
      transportUrl: form.transportUrl || null,
    };

    if (editingId) {
      await apiCall("PATCH", `/servers/${editingId}?companyId=${companyId}`, payload);
    } else {
      await apiCall("POST", `/servers?companyId=${companyId}`, payload);
    }
    setSaving(false);
    setDialogOpen(false);
    refresh();
  }

  async function handleDelete(server: McpServer) {
    await apiCall("DELETE", `/servers/${server.id}?companyId=${companyId}`);
    setDeleteConfirm(null);
    refresh();
  }

  async function handleToggle(server: McpServer) {
    await apiCall("PATCH", `/servers/${server.id}?companyId=${companyId}`, {
      companyId,
      enabled: !server.enabled,
    });
    refresh();
  }

  async function handleSync() {
    if (!companyId) return;
    setSyncing(true);
    await apiCall("POST", `/servers/sync?companyId=${companyId}`, { companyId });
    setSyncing(false);
    refresh();
    refreshDiscovered();
  }

  async function handleImport(server: DiscoveredServer) {
    if (!companyId) return;
    await apiCall("POST", `/servers?companyId=${companyId}`, {
      companyId,
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      transportType: server.transportType,
      transportUrl: server.transportUrl,
      source: "discovered",
    });
    refresh();
    refreshDiscovered();
  }

  const existingNames = new Set((servers || []).map(s => s.name));
  const newDiscovered = (discovered || []).filter(d => !existingNames.has(d.name));

  if (!companyId) {
    return <div style={{ padding: 32, color: "var(--muted-foreground)" }}>Select a company.</div>;
  }

  return (
    <div style={{ padding: "0 0 32px 0", height: "100%", overflow: "auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px 16px", borderBottom: "1px solid var(--border)" }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--foreground)" }}>MCP Servers</h1>
          <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "2px 0 0" }}>
            Manage Model Context Protocol servers for your agents.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSync} disabled={syncing} style={btnOutline}>
            {syncing ? "Syncing..." : "Sync from Claude Code"}
          </button>
          <button onClick={openCreate} style={btnPrimary}>
            + Add Server
          </button>
        </div>
      </div>

      {/* Server list */}
      <div style={{ padding: "16px 24px" }}>
        {loading && <div style={{ color: "var(--muted-foreground)", padding: 16 }}>Loading...</div>}

        {servers && servers.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--muted-foreground)" }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ opacity: 0.3, margin: "0 auto 12px" }}>
              <rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>
              <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
            </svg>
            <p style={{ fontSize: 14, marginBottom: 4 }}>No MCP servers configured yet.</p>
            <p style={{ fontSize: 12, opacity: 0.6 }}>Add a server manually to get started.</p>
          </div>
        )}

        {servers && servers.map(server => (
          <div key={server.id} style={{
            border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px", marginBottom: 8,
            background: "var(--card, var(--background))",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>
                    <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
                  </svg>
                  <span style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>
                    {server.display_name || server.name}
                  </span>
                  <span style={{ ...badge, ...transportBadgeStyle[server.transport_type] }}>
                    {server.transport_type}
                  </span>
                  {server.source === "discovered" && (
                    <span style={{ ...badge, background: "rgba(107,114,128,0.15)", color: "var(--muted-foreground)" }}>
                      auto-discovered
                    </span>
                  )}
                  {!server.enabled && (
                    <span style={{ ...badge, background: "rgba(239,68,68,0.15)", color: "rgb(248,113,113)" }}>
                      disabled
                    </span>
                  )}
                </div>
                {server.description && (
                  <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "0 0 2px 22px" }}>{server.description}</p>
                )}
                <p style={{ fontSize: 11, color: "var(--muted-foreground)", opacity: 0.6, fontFamily: "monospace", margin: "0 0 0 22px" }}>
                  {server.transport_url || `${server.command || ""} ${(Array.isArray(server.args) ? server.args : []).join(" ")}`.trim()}
                </p>
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button onClick={() => handleToggle(server)} style={btnIcon} title={server.enabled ? "Disable" : "Enable"}>
                  {server.enabled ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="rgb(74,222,128)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" x2="12" y1="2" y2="12"/>
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" x2="12" y1="2" y2="12"/>
                    </svg>
                  )}
                </button>
                <button onClick={() => openEdit(server)} style={btnIcon}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                  </svg>
                </button>
                <button onClick={() => setDeleteConfirm(server)} style={{ ...btnIcon, color: "rgb(248,113,113)" }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Discovered from Claude Code */}
      {newDiscovered.length > 0 && (
        <div style={{ padding: "0 24px 16px" }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 12px", color: "var(--muted-foreground)" }}>
            Discovered from Claude Code
            <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>
              (~/.claude/mcp.json)
            </span>
          </h3>
          {newDiscovered.map(server => (
            <div key={server.name} style={{
              border: "1px dashed var(--border)", borderRadius: 8, padding: "10px 16px", marginBottom: 6,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              opacity: 0.8, background: "var(--card, var(--background))",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>
                  <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
                </svg>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--foreground)" }}>{server.name}</span>
                <span style={{ ...badge, ...transportBadgeStyle[server.transportType] }}>
                  {server.transportType}
                </span>
                <span style={{ fontSize: 11, color: "var(--muted-foreground)", opacity: 0.6, fontFamily: "monospace" }}>
                  {server.transportUrl || `${server.command || ""} ${server.args.join(" ")}`.trim()}
                </span>
              </div>
              <button onClick={() => handleImport(server)} style={btnOutline}>
                Import
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      {dialogOpen && (
        <div style={overlay} onClick={() => setDialogOpen(false)}>
          <div style={dialog} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 16px", color: "var(--foreground)" }}>
              {editingId ? "Edit MCP Server" : "Add MCP Server"}
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={labelStyle}>
                <span>Name (identifier)</span>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. ocxp, playwright" style={inputStyle} />
              </label>

              <label style={labelStyle}>
                <span>Display Name</span>
                <input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })}
                  placeholder="e.g. OCXP Code Intelligence" style={inputStyle} />
              </label>

              <label style={labelStyle}>
                <span>Description</span>
                <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                  placeholder="What does this MCP server provide?" rows={2} style={{ ...inputStyle, resize: "vertical" as const }} />
              </label>

              <div style={{ display: "flex", gap: 12 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  <span>Transport Type</span>
                  <select value={form.transportType}
                    onChange={e => setForm({ ...form, transportType: e.target.value as "stdio" | "http" | "sse" })}
                    style={inputStyle}>
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                    <option value="sse">sse</option>
                  </select>
                </label>
              </div>

              {form.transportType === "stdio" ? (
                <>
                  <label style={labelStyle}>
                    <span>Command</span>
                    <input value={form.command} onChange={e => setForm({ ...form, command: e.target.value })}
                      placeholder="e.g. npx, node, python" style={{ ...inputStyle, fontFamily: "monospace" }} />
                  </label>
                  <label style={labelStyle}>
                    <span>Arguments (space-separated)</span>
                    <input value={form.args} onChange={e => setForm({ ...form, args: e.target.value })}
                      placeholder="e.g. -y @modelcontextprotocol/server-filesystem" style={{ ...inputStyle, fontFamily: "monospace" }} />
                  </label>
                </>
              ) : (
                <label style={labelStyle}>
                  <span>Transport URL</span>
                  <input value={form.transportUrl} onChange={e => setForm({ ...form, transportUrl: e.target.value })}
                    placeholder="https://..." style={{ ...inputStyle, fontFamily: "monospace" }} />
                </label>
              )}

              <label style={labelStyle}>
                <span>Environment Variables (KEY=VALUE per line)</span>
                <textarea value={form.envText} onChange={e => setForm({ ...form, envText: e.target.value })}
                  placeholder={"API_KEY=xxx\nPROJECT_ID=yyy"} rows={3}
                  style={{ ...inputStyle, fontFamily: "monospace", resize: "vertical" as const }} />
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button onClick={() => setDialogOpen(false)} style={btnGhost}>Cancel</button>
              <button onClick={handleSave} disabled={!form.name.trim() || saving} style={{
                ...btnPrimary, opacity: (!form.name.trim() || saving) ? 0.5 : 1,
              }}>
                {saving ? "Saving..." : editingId ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div style={overlay} onClick={() => setDeleteConfirm(null)}>
          <div style={{ ...dialog, maxWidth: 380 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 8px", color: "var(--foreground)" }}>Delete MCP Server</h3>
            <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: "0 0 20px" }}>
              Are you sure you want to delete "{deleteConfirm.display_name || deleteConfirm.name}"? This will also remove all agent assignments.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setDeleteConfirm(null)} style={btnGhost}>Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} style={btnDanger}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sidebar Link ───

export function McpSidebar() {
  const path = "/CH/plugins/paperclipai.plugin-mcp-manager";
  return (
    <a href={path} onClick={(e) => {
      e.preventDefault();
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
      fontSize: 13, fontWeight: 500, color: "var(--foreground)", opacity: 0.8,
      textDecoration: "none", borderRadius: 4,
    }}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <rect width="20" height="8" x="2" y="2" rx="2" ry="2"/>
        <rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>
        <line x1="6" x2="6.01" y1="6" y2="6"/>
        <line x1="6" x2="6.01" y1="18" y2="18"/>
      </svg>
      <span>MCP Servers</span>
    </a>
  );
}

// ─── Agent Detail Tab ───

export function AgentMcpTab() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;
  const agentId = hostCtx?.entityId ?? null;

  const pluginBase = `/api/plugins/paperclipai.plugin-mcp-manager/api`;

  const { data: assignments, loading: loadingAssignments, refresh: refreshAssignments } = usePluginData<McpAssignment[]>(
    "agent-mcp-assignments", { agentId: agentId ?? "" },
  );

  const { data: allServers, loading: loadingServers } = usePluginData<McpServer[]>(
    "mcp-servers-list", { companyId: companyId ?? "" },
  );

  const assignedIds = new Set((assignments || []).map(a => a.mcp_server_id));
  const catalog = (allServers || []).filter(s => s.scope === "company" && s.enabled && !assignedIds.has(s.id));

  async function addMcp(serverId: string) {
    await fetch(`${pluginBase}/agents/${agentId}/mcps?companyId=${companyId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, mcpServerId: serverId }),
    });
    refreshAssignments();
  }

  async function removeMcp(assignmentId: string) {
    await fetch(`${pluginBase}/agents/${agentId}/mcps/${assignmentId}?companyId=${companyId}`, {
      method: "DELETE",
    });
    refreshAssignments();
  }

  if (!agentId || !companyId) return null;
  if (loadingAssignments || loadingServers) {
    return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading...</div>;
  }

  return (
    <div style={{ padding: "16px 0" }}>
      {/* Active MCPs */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--foreground)" }}>
            Active MCPs
            {assignments && assignments.length > 0 && (
              <span style={{ fontWeight: 400, fontSize: 11, color: "var(--muted-foreground)", marginLeft: 8 }}>
                {assignments.length} enabled
              </span>
            )}
          </h3>
        </div>

        {(!assignments || assignments.length === 0) ? (
          <div style={{
            border: "1px dashed var(--border)", borderRadius: 8, padding: "24px 16px",
            textAlign: "center", color: "var(--muted-foreground)",
          }}>
            <p style={{ fontSize: 13, margin: "0 0 4px" }}>No MCPs active for this agent.</p>
            <p style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>Add from the catalog below.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {assignments.map(a => (
              <div key={a.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                border: "1px solid var(--border)", borderRadius: 6, padding: "8px 12px",
                background: "var(--card, var(--background))",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>
                    <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
                  </svg>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--foreground)" }}>
                    {a.display_name || a.name}
                  </span>
                  <span style={{ ...badge, ...transportBadgeStyle[a.transport_type] || {} }}>
                    {a.transport_type}
                  </span>
                </div>
                <button onClick={() => removeMcp(a.id)} style={{ ...btnIcon, color: "rgb(248,113,113)" }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Catalog */}
      {catalog.length > 0 && (
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 500, margin: "0 0 12px", color: "var(--muted-foreground)" }}>
            Available to add
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {catalog.map(server => (
              <div key={server.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                border: "1px solid var(--border)", borderRadius: 6, padding: "8px 12px",
                opacity: 0.7, background: "var(--card, var(--background))",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>
                    <line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>
                  </svg>
                  <span style={{ fontSize: 13 }}>{server.display_name || server.name}</span>
                  <span style={{ ...badge, ...transportBadgeStyle[server.transport_type] }}>
                    {server.transport_type}
                  </span>
                </div>
                <button onClick={() => addMcp(server.id)} style={btnOutline}>
                  + Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {catalog.length === 0 && (!assignments || assignments.length === 0) && (
        <div style={{ textAlign: "center", padding: 32, color: "var(--muted-foreground)" }}>
          <p style={{ fontSize: 13 }}>No MCP servers in the company catalog.</p>
          <a href="/CH/plugins/paperclipai.plugin-mcp-manager" onClick={(e) => {
            e.preventDefault();
            window.history.pushState({}, "", "/CH/plugins/paperclipai.plugin-mcp-manager");
            window.dispatchEvent(new PopStateEvent("popstate"));
          }} style={{ fontSize: 12, color: "rgb(96,165,250)", textDecoration: "none" }}>
            Set up MCP servers
          </a>
        </div>
      )}
    </div>
  );
}

// ─── Shared styles ───

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 50,
};

const dialog: React.CSSProperties = {
  background: "var(--background)", border: "1px solid var(--border)", borderRadius: 12,
  padding: 24, maxWidth: 480, width: "calc(100% - 32px)", maxHeight: "90vh",
  overflow: "auto", boxShadow: "0 25px 50px rgba(0,0,0,0.25)",
};

const labelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4, fontSize: 12,
  fontWeight: 500, color: "var(--muted-foreground)",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 12px", fontSize: 13,
  border: "1px solid var(--border)", borderRadius: 6,
  background: "var(--background)", color: "var(--foreground)",
  outline: "none",
};

const btnPrimary: React.CSSProperties = {
  padding: "6px 14px", fontSize: 13, fontWeight: 500, borderRadius: 6,
  border: "none", background: "var(--primary, #2563eb)", color: "var(--primary-foreground, #fff)",
  cursor: "pointer",
};

const btnGhost: React.CSSProperties = {
  padding: "6px 14px", fontSize: 13, fontWeight: 500, borderRadius: 6,
  border: "none", background: "transparent", color: "var(--foreground)",
  cursor: "pointer",
};

const btnDanger: React.CSSProperties = {
  padding: "6px 14px", fontSize: 13, fontWeight: 500, borderRadius: 6,
  border: "none", background: "rgb(220,38,38)", color: "#fff", cursor: "pointer",
};

const btnIcon: React.CSSProperties = {
  padding: 4, border: "none", background: "transparent", cursor: "pointer",
  borderRadius: 4, display: "flex", alignItems: "center",
};

const btnOutline: React.CSSProperties = {
  padding: "4px 10px", fontSize: 12, fontWeight: 500, borderRadius: 4,
  border: "1px solid var(--border)", background: "transparent",
  color: "var(--foreground)", cursor: "pointer",
};
