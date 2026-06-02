import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { usePluginData, useHostContext, usePluginAction } from "@paperclipai/plugin-sdk/ui";

// ── Tensions Board ────────────────────────────────────────────────────────────

interface TensionRow {
  id: string;
  circle_id: string;
  circle_name: string;
  title: string;
  description: string | null;
  tension_type: "governance" | "operational";
  status: "open" | "processing" | "resolved" | "rejected";
  source_agent_name: string | null;
  created_at: string;
}

interface CircleOption { id: string; name: string; }

const COLUMN_STATUSES: Array<{ key: TensionRow["status"]; label: string }> = [
  { key: "open", label: "Open" },
  { key: "processing", label: "Processing" },
  { key: "resolved", label: "Resolved" },
];

function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function ageColor(days: number): string {
  if (days < 7) return "#4ade80";
  if (days < 14) return "#fbbf24";
  return "#f87171";
}

function TypeBadge({ type }: { type: string }) {
  const isGov = type === "governance";
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 9999,
      background: isGov ? "color-mix(in oklch, #a855f7 18%, transparent)" : "color-mix(in oklch, #3b82f6 18%, transparent)",
      color: isGov ? "#c084fc" : "#60a5fa",
      textTransform: "uppercase" as const, letterSpacing: "0.04em",
    }}>{type}</span>
  );
}

function TensionCard({ tension }: { tension: TensionRow }) {
  const days = ageDays(tension.created_at);
  return (
    <div style={{
      background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8,
      padding: "10px 12px", marginBottom: 8, cursor: "default",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", lineHeight: 1.4, flex: 1 }}>
          {tension.title}
        </span>
        <TypeBadge type={tension.tension_type} />
      </div>
      {tension.description && (
        <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4, lineHeight: 1.5,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden" }}>
          {tension.description}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
          {tension.circle_name}
          {tension.source_agent_name ? ` · ${tension.source_agent_name}` : ""}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: ageColor(days) }}>
          {days === 0 ? "today" : `${days}d`}
        </span>
      </div>
    </div>
  );
}

export function TensionsBoard() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;
  const [typeFilter, setTypeFilter] = useState<"all" | "governance" | "operational">("all");
  const [circleFilter, setCircleFilter] = useState<string>("all");

  const { data, loading, error } = usePluginData<{ tensions: TensionRow[]; circles: CircleOption[] }>(
    "tensions-board", { companyId: companyId ?? "" },
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.tensions.filter(t => {
      if (typeFilter !== "all" && t.tension_type !== typeFilter) return false;
      if (circleFilter !== "all" && t.circle_id !== circleFilter) return false;
      return true;
    });
  }, [data, typeFilter, circleFilter]);

  const byStatus = useMemo(() => {
    const map: Record<string, TensionRow[]> = { open: [], processing: [], resolved: [] };
    for (const t of filtered) {
      const key = t.status === "rejected" ? "resolved" : t.status;
      if (key in map) map[key].push(t);
    }
    return map;
  }, [filtered]);

  if (!companyId) return <div style={{ padding: 32, color: "var(--muted-foreground)" }}>Select a company.</div>;
  if (loading) return <div style={{ padding: 32, color: "var(--muted-foreground)" }}>Loading tensions...</div>;
  if (error) return <div style={{ padding: 32, color: "#f87171" }}>Failed to load tensions: {String(error)}</div>;
  if (!data) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)" }}>Tensions Board</span>
        <div style={{ display: "flex", gap: 8 }}>
          {/* Type filter */}
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value as any)}
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", cursor: "pointer" }}
          >
            <option value="all">All types</option>
            <option value="governance">Governance</option>
            <option value="operational">Operational</option>
          </select>
          {/* Circle filter */}
          <select
            value={circleFilter}
            onChange={e => setCircleFilter(e.target.value)}
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", cursor: "pointer" }}
          >
            <option value="all">All circles</option>
            {data.circles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
      {/* Kanban columns */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, padding: 16, flex: 1, minHeight: 0, overflowY: "auto" }}>
        {COLUMN_STATUSES.map(col => (
          <div key={col.key} style={{ display: "flex", flexDirection: "column" as const, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{col.label}</span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 9999, background: "var(--muted)", color: "var(--muted-foreground)" }}>
                {byStatus[col.key]?.length ?? 0}
              </span>
            </div>
            <div style={{ flex: 1 }}>
              {(byStatus[col.key] ?? []).length === 0
                ? <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontStyle: "italic", padding: "8px 0" }}>No tensions</div>
                : (byStatus[col.key] ?? []).map(t => <TensionCard key={t.id} tension={t} />)
              }
            </div>
          </div>
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 16, padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--muted-foreground)", flexShrink: 0 }}>
        <span style={{ color: "#4ade80" }}>● &lt;7d</span>
        <span style={{ color: "#fbbf24" }}>● 7–14d</span>
        <span style={{ color: "#f87171" }}>● &gt;14d</span>
        <span style={{ marginLeft: "auto" }}>{filtered.length} tensions total</span>
      </div>
    </div>
  );
}

export function TensionsBoardSidebar() {
  const { companyPrefix } = useHostContext();
  const path = `/${companyPrefix ?? "unknown"}/tensions`;
  return (
    <a href={path} onClick={(e) => { e.preventDefault(); window.history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
      fontSize: 13, fontWeight: 500, color: "var(--foreground)", opacity: 0.8,
      textDecoration: "none", borderRadius: 4,
    }}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/><rect x="14" y="17" width="7" height="4" rx="1"/>
      </svg>
      <span>Tensions</span>
    </a>
  );
}

interface CircleWithRoles {
  id: string;
  name: string;
  purpose: string | null;
  parent_circle_id: string | null;
  project_id: string | null;
  color: string | null;
  roles: Array<{
    id: string;
    name: string;
    purpose: string | null;
    role_type: string;
    agent_name?: string;
  }>;
}

interface TreeNode {
  circle: CircleWithRoles;
  children: TreeNode[];
}

const CIRCLE_FILL = "rgba(96, 175, 220, 0.18)";
const CIRCLE_STROKE = "rgba(96, 175, 220, 0.45)";
const ROLE_GREEN = "#5faa46";
const ROLE_GREEN_DARK = "#4a9038";
const TEXT_DARK = "var(--foreground)";
const LINK_BLUE = "#60afd8";
const GAP = 12;

function buildTree(circles: CircleWithRoles[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const c of circles) map.set(c.id, { circle: c, children: [] });
  const roots: TreeNode[] = [];
  for (const c of circles) {
    const node = map.get(c.id)!;
    if (c.parent_circle_id && map.has(c.parent_circle_id)) {
      map.get(c.parent_circle_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function findNode(nodes: TreeNode[], id: string | null): TreeNode | null {
  if (!id) return null;
  for (const n of nodes) {
    if (n.circle.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

function buildBreadcrumb(nodes: TreeNode[], targetId: string | null): TreeNode[] {
  if (!targetId) return [];
  function search(node: TreeNode, path: TreeNode[]): TreeNode[] | null {
    const cur = [...path, node];
    if (node.circle.id === targetId) return cur;
    for (const child of node.children) {
      const result = search(child, cur);
      if (result) return result;
    }
    return null;
  }
  for (const root of nodes) {
    const result = search(root, []);
    if (result) return result;
  }
  return [];
}

function countContent(node: TreeNode): number {
  let count = node.circle.roles.length + 1;
  for (const child of node.children) count += countContent(child);
  return count;
}

function roleTypeLabel(type: string): string {
  switch (type) {
    case "circle_lead": return "Circle Lead";
    case "facilitator": return "Facilitator";
    case "secretary": return "Secretary";
    case "circle_rep": return "Circle Rep";
    default: return "Role";
  }
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

interface LCircle { cx: number; cy: number; r: number; node: TreeNode; depth: number }
interface LRole { cx: number; cy: number; r: number; role: CircleWithRoles["roles"][0]; filled: boolean }
interface LLabel { cx: number; cy: number; maxWidth: number; fontSize: number; text: string; circleId: string }

function packCircles(parentR: number, radii: number[]): Array<{ x: number; y: number }> {
  const n = radii.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: 0, y: -parentR * 0.05 }];

  const pos = radii.map((_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return { x: Math.cos(angle) * parentR * 0.2, y: Math.sin(angle) * parentR * 0.2 };
  });

  for (let iter = 0; iter < 200; iter++) {
    let maxPush = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const minD = radii[i] + radii[j] + GAP;
        if (d < minD) {
          const push = (minD - d) / 2;
          maxPush = Math.max(maxPush, push);
          const nx = dx / d, ny = dy / d;
          pos[i].x -= nx * push;
          pos[i].y -= ny * push;
          pos[j].x += nx * push;
          pos[j].y += ny * push;
        }
      }
      const d = Math.sqrt(pos[i].x ** 2 + pos[i].y ** 2);
      const maxD = parentR - radii[i] - GAP;
      if (d > maxD && d > 0) {
        pos[i].x *= maxD / d;
        pos[i].y *= maxD / d;
      }
    }
    for (let i = 0; i < n; i++) {
      pos[i].x *= 0.995;
      pos[i].y *= 0.995;
    }
    if (maxPush < 0.3) break;
  }
  return pos;
}

function computeLayout(rootNode: TreeNode): { circles: LCircle[]; roles: LRole[]; labels: LLabel[] } {
  const circles: LCircle[] = [];
  const roles: LRole[] = [];
  const labels: LLabel[] = [];

  function lay(node: TreeNode, cx: number, cy: number, r: number, depth: number) {
    circles.push({ cx, cy, r, node, depth });
    const children = node.children;
    const nodeRoles = node.circle.roles;

    if (children.length === 0) {
      const roleR = Math.min(r * 0.17, 22);
      const spacing = roleR * 2.5;
      const cols = Math.ceil(Math.sqrt(nodeRoles.length));
      const rows = Math.ceil(nodeRoles.length / cols);
      const startX = cx - ((cols - 1) * spacing) / 2;
      const startY = cy - ((rows - 1) * spacing) / 2 - r * 0.12;

      nodeRoles.forEach((role, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const rx = startX + col * spacing;
        const ry = startY + row * spacing;
        if (dist(rx, ry, cx, cy) + roleR < r - 4) {
          roles.push({ cx: rx, cy: ry, r: roleR, role, filled: !!role.agent_name });
        }
      });

      labels.push({
        cx, cy: cy + r * 0.55,
        maxWidth: r * 1.6, fontSize: Math.max(Math.min(r * 0.13, 22), 10),
        text: node.circle.name, circleId: node.circle.id,
      });
      return;
    }

    const weighted = children.map(c => ({ node: c, weight: countContent(c) }));
    weighted.sort((a, b) => b.weight - a.weight);
    const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);

    const childRadii = weighted.map(w => {
      const fraction = w.weight / totalWeight;
      return Math.max(r * Math.sqrt(fraction) * 0.62, 28);
    });

    const positions = packCircles(r * 0.85, childRadii);
    const placedChildren: Array<{ cx: number; cy: number; r: number }> = [];

    weighted.forEach((w, i) => {
      const childCx = cx + positions[i].x;
      const childCy = cy + positions[i].y;
      placedChildren.push({ cx: childCx, cy: childCy, r: childRadii[i] });
      lay(w.node, childCx, childCy, childRadii[i], depth + 1);
    });

    const roleR = Math.min(r * 0.04, 16);
    const roleSpacing = roleR * 2.6;
    const roleSlots: Array<{ x: number; y: number }> = [];

    for (let ry = cy - r + roleR + GAP; ry <= cy + r - roleR - GAP; ry += roleSpacing) {
      for (let rx = cx - r + roleR + GAP; rx <= cx + r - roleR - GAP; rx += roleSpacing) {
        if (dist(rx, ry, cx, cy) + roleR > r - GAP) continue;
        if (placedChildren.some(p => dist(rx, ry, p.cx, p.cy) < p.r + roleR + GAP * 1.5)) continue;
        if (roleSlots.some(s => dist(rx, ry, s.x, s.y) < roleR * 2 + 3)) continue;
        roleSlots.push({ x: rx, y: ry });
        if (roleSlots.length >= nodeRoles.length) break;
      }
      if (roleSlots.length >= nodeRoles.length) break;
    }

    nodeRoles.forEach((role, i) => {
      if (i < roleSlots.length) {
        roles.push({ cx: roleSlots[i].x, cy: roleSlots[i].y, r: roleR, role, filled: !!role.agent_name });
      }
    });

    const fontSize = Math.max(Math.min(r * 0.075, 36), 12);
    const labelCandidates = [
      { x: cx + r * 0.35, y: cy + r * 0.72 },
      { x: cx - r * 0.35, y: cy + r * 0.72 },
      { x: cx, y: cy + r * 0.78 },
      { x: cx + r * 0.55, y: cy - r * 0.65 },
    ];
    let best = labelCandidates[0];
    for (const cand of labelCandidates) {
      if (placedChildren.every(p => dist(cand.x, cand.y, p.cx, p.cy) > p.r + fontSize * 2)) {
        best = cand;
        break;
      }
    }
    labels.push({ cx: best.x, cy: best.y, maxWidth: r * 0.6, fontSize, text: node.circle.name, circleId: node.circle.id });
  }

  lay(rootNode, 500, 500, 480, 0);
  return { circles, roles, labels };
}

export function CircleNavigator() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;
  const companyPrefix = hostCtx?.companyPrefix ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ role: CircleWithRoles["roles"][0]; x: number; y: number } | null>(null);
  const [hoveredCircle, setHoveredCircle] = useState<string | null>(null);
  const [detailCircleId, setDetailCircleId] = useState<string | null>("__pending__");

  const { data, loading, error } = usePluginData<CircleWithRoles[]>("circles-tree", {
    companyId: companyId ?? "",
  });

  const tree = useMemo(() => (data ? buildTree(data) : []), [data]);

  const rootNode = useMemo(() => {
    if (tree.length === 0) return null;
    if (focusedId) {
      const found = findNode(tree, focusedId);
      if (found) return found;
    }
    return tree[0];
  }, [tree, focusedId]);

  if (detailCircleId === "__pending__" && tree.length > 0) {
    setDetailCircleId(tree[0].circle.id);
  }

  const breadcrumb = useMemo(() => buildBreadcrumb(tree, focusedId), [tree, focusedId]);
  const layout = useMemo(() => (rootNode ? computeLayout(rootNode) : null), [rootNode]);

  const detailCircle = useMemo(() => {
    if (!detailCircleId || !data) return null;
    return data.find(c => c.id === detailCircleId) ?? null;
  }, [detailCircleId, data]);

  const { data: govDetail } = usePluginData<{
    strategies: Array<{ id: string; text: string; set_by_name: string | null }>;
    policies: Array<{ id: string; title: string; domain: string | null; description: string }>;
    checklists: Array<{ id: string; item_text: string; role_name: string | null; frequency: string }>;
    metrics: Array<{ id: string; name: string; unit: string | null; role_name: string | null; frequency: string }>;
  } | null>("circle-governance", { circleId: detailCircleId ?? "" });

  const { data: auditLog } = usePluginData<Array<{
    id: string; action_type: string; action_detail: any; agent_name: string | null; created_at: string;
  }>>("circle-audit-log", { circleId: detailCircleId ?? "" });

  const handleCircleClick = useCallback((e: React.MouseEvent, circleId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setTooltip(null);
    const node = findNode(tree, circleId);
    if (!node) return;
    if (node.children.length === 0) {
      setDetailCircleId(circleId);
    } else if (node.circle.id === rootNode?.circle.id) {
      setDetailCircleId(circleId);
    } else {
      setFocusedId(circleId);
    }
  }, [tree, rootNode]);

  const handleRoleClick = useCallback((e: React.MouseEvent, role: CircleWithRoles["roles"][0]) => {
    e.stopPropagation();
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setTooltip({ role, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  if (!companyId) return <div style={{ padding: 32, color: "var(--muted-foreground)" }}>Select a company to view circles.</div>;
  if (loading) return <div style={{ padding: 32, color: "var(--muted-foreground)" }}>Loading circles...</div>;
  if (error) return <div style={{ padding: 32, color: "#c00" }}>Failed to load circles: {String(error)}</div>;
  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: "center" }}>
        <p style={{ color: "var(--muted-foreground)", marginBottom: 8 }}>No circles configured yet.</p>
        <p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>Create circles via the API or agent tools.</p>
      </div>
    );
  }
  if (!layout) return null;

  if (detailCircle) {
    const domains = (detailCircle as any).domains as string[] | undefined;
    const strategies = govDetail?.strategies ?? [];
    const policies = govDetail?.policies ?? [];
    const checklists = govDetail?.checklists ?? [];
    const metrics = govDetail?.metrics ?? [];
    const subCircles = data ? data.filter(c => c.parent_circle_id === detailCircleId) : [];

    return (
      <div style={{ display: "flex", gap: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <div style={{
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  height: 48, width: 48, borderRadius: 8, background: "var(--accent)",
                }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2.5px solid " + CIRCLE_STROKE, background: CIRCLE_FILL }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>{detailCircle.name}</h2>
                  {detailCircle.purpose && <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "2px 0 0 0" }}>{detailCircle.purpose}</p>}
                </div>
              </div>

              {strategies.length > 0 && (
                <div style={{ padding: 16, background: "color-mix(in oklch, #22c55e 10%, var(--card))", borderRadius: 8, border: "1px solid color-mix(in oklch, #22c55e 30%, transparent)" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Strategy</div>
                  {strategies.map((s) => (
                    <div key={s.id} style={{ fontSize: 15, color: "var(--foreground)", fontWeight: 500, lineHeight: 1.5 }}>
                      {s.text}
                      {s.set_by_name && <span style={{ fontSize: 12, color: "var(--muted-foreground)", fontWeight: 400, marginLeft: 8 }}>-- {s.set_by_name}</span>}
                    </div>
                  ))}
                </div>
              )}

              {detailCircle.roles.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Roles</h3>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    {detailCircle.roles.map((role, i) => (
                      <div key={role.id} style={{
                        display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
                        borderBottom: i < detailCircle.roles.length - 1 ? "1px solid var(--border)" : "none",
                      }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                          background: role.agent_name ? ROLE_GREEN : "transparent",
                          border: role.agent_name ? "none" : `1.5px solid ${ROLE_GREEN}`,
                          boxSizing: "border-box" as const,
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 14, color: "var(--foreground)", fontWeight: 500 }}>{role.agent_name ?? role.name}</span>
                        </div>
                        <span style={{
                          display: "inline-flex", alignItems: "center", borderRadius: 9999,
                          padding: "2px 10px", fontSize: 12, fontWeight: 500,
                          background: role.agent_name ? "color-mix(in oklch, #4ade80 15%, transparent)" : "color-mix(in oklch, #f97316 15%, transparent)",
                          color: role.agent_name ? "#4ade80" : "#f97316",
                        }}>{roleTypeLabel(role.role_type)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {domains && domains.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Domains</h3>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {domains.map((d, i) => (
                      <span key={i} style={{
                        display: "inline-flex", alignItems: "center", borderRadius: 9999,
                        padding: "4px 12px", fontSize: 12, color: "var(--foreground)",
                        border: "1px solid var(--border)", background: "var(--accent)",
                      }}>{d}</span>
                    ))}
                  </div>
                </div>
              )}

              {policies.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Policies</h3>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    {policies.map((p, i) => (
                      <div key={p.id} style={{
                        padding: "12px 16px",
                        borderBottom: i < policies.length - 1 ? "1px solid var(--border)" : "none",
                      }}>
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>{p.title}</span>
                          {p.domain && <span style={{
                            fontSize: 11, color: "var(--muted-foreground)", background: "var(--muted)",
                            padding: "2px 8px", borderRadius: 4, whiteSpace: "nowrap",
                          }}>{p.domain}</span>}
                        </div>
                        <div style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 4, lineHeight: 1.5 }}>{p.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(checklists.length > 0 || metrics.length > 0) && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                  {checklists.length > 0 && (
                    <div>
                      <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Checklists</h3>
                      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid var(--border)", background: "color-mix(in oklch, var(--accent) 50%, transparent)" }}>
                              <th style={{ textAlign: "left" as const, padding: "6px 12px", fontWeight: 500, fontSize: 12, color: "var(--muted-foreground)" }}>Item</th>
                              <th style={{ textAlign: "left" as const, padding: "6px 12px", fontWeight: 500, fontSize: 12, color: "var(--muted-foreground)" }}>Role</th>
                              <th style={{ textAlign: "right" as const, padding: "6px 12px", fontWeight: 500, fontSize: 12, color: "var(--muted-foreground)" }}>Frequency</th>
                            </tr>
                          </thead>
                          <tbody>
                            {checklists.map((cl, i) => (
                              <tr key={cl.id} style={{ borderBottom: i < checklists.length - 1 ? "1px solid var(--border)" : "none" }}>
                                <td style={{ padding: "8px 12px", color: "var(--foreground)" }}>{cl.item_text}</td>
                                <td style={{ padding: "8px 12px", color: "var(--muted-foreground)", fontSize: 12 }}>{cl.role_name ?? ""}</td>
                                <td style={{ padding: "8px 12px", textAlign: "right" as const }}>
                                  <span style={{
                                    fontSize: 11, padding: "2px 8px", borderRadius: 9999, fontWeight: 500,
                                    background: cl.frequency === "daily" ? "color-mix(in oklch, #10b981 15%, transparent)" : "var(--muted)",
                                    color: cl.frequency === "daily" ? "#34d399" : "var(--muted-foreground)",
                                  }}>{cl.frequency}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {metrics.length > 0 && (
                    <div>
                      <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Metrics</h3>
                      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid var(--border)", background: "color-mix(in oklch, var(--accent) 50%, transparent)" }}>
                              <th style={{ textAlign: "left" as const, padding: "6px 12px", fontWeight: 500, fontSize: 12, color: "var(--muted-foreground)" }}>Name</th>
                              <th style={{ textAlign: "left" as const, padding: "6px 12px", fontWeight: 500, fontSize: 12, color: "var(--muted-foreground)" }}>Role</th>
                              <th style={{ textAlign: "left" as const, padding: "6px 12px", fontWeight: 500, fontSize: 12, color: "var(--muted-foreground)" }}>Unit</th>
                              <th style={{ textAlign: "right" as const, padding: "6px 12px", fontWeight: 500, fontSize: 12, color: "var(--muted-foreground)" }}>Frequency</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metrics.map((m, i) => (
                              <tr key={m.id} style={{ borderBottom: i < metrics.length - 1 ? "1px solid var(--border)" : "none" }}>
                                <td style={{ padding: "8px 12px", color: "var(--foreground)" }}>{m.name}</td>
                                <td style={{ padding: "8px 12px", color: "var(--muted-foreground)", fontSize: 12 }}>{m.role_name ?? ""}</td>
                                <td style={{ padding: "8px 12px", color: "var(--muted-foreground)", fontSize: 12 }}>{m.unit ?? ""}</td>
                                <td style={{ padding: "8px 12px", textAlign: "right" as const }}>
                                  <span style={{
                                    fontSize: 11, padding: "2px 8px", borderRadius: 9999, fontWeight: 500,
                                    background: "var(--muted)", color: "var(--muted-foreground)",
                                  }}>{m.frequency}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {auditLog && auditLog.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Activity</h3>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    {auditLog.map((log: any, i: number) => (
                      <div key={log.id} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", fontSize: 13,
                        borderBottom: i < auditLog.length - 1 ? "1px solid var(--border)" : "none",
                      }}>
                        <div>
                          <span style={{ color: "var(--foreground)", fontWeight: 500 }}>{log.action_type.replace(/-/g, " ")}</span>
                          {log.agent_name && <span style={{ color: "var(--muted-foreground)", marginLeft: 6, fontSize: 12 }}>by {log.agent_name}</span>}
                        </div>
                        <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                          {new Date(log.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Phase 1.15h-d — Team conversations (Messages) inside the circle detail view. */}
              <CircleMessagesSection circleId={detailCircleId} />
            </div>
          </div>

          <div style={{ width: 280, flexShrink: 0, padding: 16 }}>
            {layout && (
              <div style={{ marginBottom: 16 }}>
                <svg viewBox="0 -15 1000 1030" style={{ width: "100%", height: 200, display: "block" }}>
                  {layout.circles.slice().sort((a, b) => a.depth - b.depth).map((lc) => (
                    <circle
                      key={`mc-${lc.node.circle.id}`}
                      cx={lc.cx} cy={lc.cy} r={lc.r}
                      fill={lc.node.circle.id === detailCircleId ? "rgba(96, 175, 220, 0.3)" : CIRCLE_FILL}
                      stroke={lc.node.circle.id === detailCircleId ? "#60afd8" : CIRCLE_STROKE}
                      strokeWidth={lc.node.circle.id === detailCircleId ? 2.5 : 1.5}
                      style={{ cursor: "pointer" }}
                      onClick={() => setDetailCircleId(lc.node.circle.id)}
                    />
                  ))}
                  {layout.labels.map((ll, li) => (
                    <foreignObject
                      key={`ml-${li}-${ll.circleId}`}
                      x={ll.cx - ll.maxWidth / 2} y={ll.cy - ll.fontSize * 0.6}
                      width={ll.maxWidth} height={ll.fontSize * 2.5}
                      style={{ pointerEvents: "none" }}
                    >
                      <div style={{
                        color: TEXT_DARK, fontSize: ll.fontSize, fontWeight: 600,
                        textAlign: "center", fontFamily: "system-ui, -apple-system, sans-serif",
                        lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {ll.text}
                      </div>
                    </foreignObject>
                  ))}
                </svg>
              </div>
            )}

            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)", marginBottom: 8 }}>{detailCircle.name}</div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
              {detailCircle.roles.map((role, i) => (
                <div key={role.id} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                  borderBottom: i < detailCircle.roles.length - 1 ? "1px solid var(--border)" : "none",
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                    background: role.agent_name ? ROLE_GREEN : "transparent",
                    border: role.agent_name ? "none" : `1.5px solid ${ROLE_GREEN}`,
                    boxSizing: "border-box" as const,
                  }} />
                  <div style={{ minWidth: 0 }}>
                    {role.agent_name ? (
                      <a
                        href={`/${companyPrefix ?? "unknown"}/agents/${role.agent_name.toLowerCase().replace(/&/g, "").replace(/\s+/g, "-")}`}
                        style={{ fontSize: 13, color: LINK_BLUE, fontWeight: 500, textDecoration: "none" }}
                      >{role.agent_name}</a>
                    ) : (
                      <div style={{ fontSize: 13, color: "var(--muted-foreground)", fontStyle: "italic" }}>{role.name}</div>
                    )}
                    <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{role.agent_name ? role.name : "Unassigned"}</div>
                  </div>
                </div>
              ))}
            </div>
            {subCircles.length > 0 && (
              <>
                <div style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)", marginTop: 16, marginBottom: 8 }}>Sub-Circles</div>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {subCircles.map((sub, i) => (
                    <div
                      key={sub.id}
                      onClick={() => setDetailCircleId(sub.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                        borderBottom: i < subCircles.length - 1 ? "1px solid var(--border)" : "none",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: sub.color || "var(--muted-foreground)", flexShrink: 0 }} />
                      <span style={{ fontSize: 13, color: "var(--foreground)", fontWeight: 500 }}>{sub.name}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
    );
  }

  return (
    <div style={{ background: "var(--card)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 16px", borderBottom: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
          {breadcrumb.length > 0 ? (
            <>
              <span
                style={{ color: LINK_BLUE, cursor: "pointer", fontWeight: 500 }}
                onClick={() => setFocusedId(null)}
              >
                {tree[0]?.circle.name ?? "Circles"}
              </span>
              {breadcrumb.slice(1).map((bc) => (
                <React.Fragment key={bc.circle.id}>
                  <span style={{ color: "var(--muted-foreground)", margin: "0 2px" }}>/</span>
                  <span
                    style={{
                      color: bc.circle.id === focusedId ? TEXT_DARK : LINK_BLUE,
                      cursor: bc.circle.id === focusedId ? "default" : "pointer",
                      fontWeight: bc.circle.id === focusedId ? 600 : 500,
                    }}
                    onClick={() => { if (bc.circle.id !== focusedId) setFocusedId(bc.circle.id); }}
                  >
                    {bc.circle.name}
                  </span>
                </React.Fragment>
              ))}
            </>
          ) : (
            <span style={{ color: TEXT_DARK, fontWeight: 600 }}>{rootNode?.circle.name ?? "Circles"}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--muted-foreground)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: ROLE_GREEN, display: "inline-block" }} />
            Assigned
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{
              width: 10, height: 10, borderRadius: "50%", background: "var(--card)",
              border: `1.5px solid ${ROLE_GREEN}`, display: "inline-block", boxSizing: "border-box",
            }} />
            Vacant
          </span>
          <span>{data.length} circles</span>
        </div>
      </div>

      <div ref={containerRef} style={{ position: "relative" }} onClick={() => setTooltip(null)}>
        <svg
          viewBox="0 -15 1000 1030"
          style={{ width: "100%", height: "calc(100vh - 200px)", minHeight: 500, display: "block" }}
        >
          {layout.circles
            .slice()
            .sort((a, b) => a.depth - b.depth)
            .map((lc) => (
              <circle
                key={`c-${lc.node.circle.id}`}
                cx={lc.cx} cy={lc.cy} r={lc.r}
                fill={CIRCLE_FILL}
                stroke={CIRCLE_STROKE}
                strokeWidth={1.5}
                style={{
                  cursor: "pointer",
                  opacity: hoveredCircle === lc.node.circle.id ? 0.85 : 1,
                  transition: "opacity 0.15s",
                }}
                onClick={(e) => handleCircleClick(e, lc.node.circle.id)}
                onMouseEnter={() => setHoveredCircle(lc.node.circle.id)}
                onMouseLeave={() => setHoveredCircle(null)}
              />
            ))}

          {layout.roles.map((lr, ri) => (
            <g key={`r-${ri}-${lr.role.id}`} style={{ cursor: "pointer" }} onClick={(e) => handleRoleClick(e, lr.role)}>
              <circle
                cx={lr.cx} cy={lr.cy} r={lr.r}
                fill={lr.filled ? ROLE_GREEN : "var(--card)"}
                stroke={lr.filled ? ROLE_GREEN_DARK : ROLE_GREEN}
                strokeWidth={lr.filled ? 0 : 1.5}
              />
              <foreignObject
                x={lr.cx - lr.r + 2} y={lr.cy - lr.r + 2}
                width={(lr.r - 2) * 2} height={(lr.r - 2) * 2}
                style={{ pointerEvents: "none" }}
              >
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: "100%", height: "100%", textAlign: "center",
                  color: lr.filled ? "#fff" : TEXT_DARK,
                  fontSize: Math.max(Math.min(lr.r * 0.35, 10), 6),
                  fontWeight: 500, lineHeight: 1.15, overflow: "hidden",
                }}>
                  {lr.role.name}
                </div>
              </foreignObject>
            </g>
          ))}

          {layout.labels.map((ll, li) => (
            <foreignObject
              key={`l-${li}-${ll.circleId}`}
              x={ll.cx - ll.maxWidth / 2} y={ll.cy - ll.fontSize * 0.6}
              width={ll.maxWidth} height={ll.fontSize * 2.5}
              style={{ pointerEvents: "none" }}
            >
              <div style={{
                color: TEXT_DARK, fontSize: ll.fontSize, fontWeight: 600,
                textAlign: "center", fontFamily: "system-ui, -apple-system, sans-serif",
                lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {ll.text}
              </div>
            </foreignObject>
          ))}
        </svg>

        {tooltip && (
          <div
            style={{
              position: "absolute", left: tooltip.x, top: tooltip.y - 8,
              transform: "translate(-50%, -100%)",
              background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8,
              padding: "12px 16px", boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
              zIndex: 10, maxWidth: 260, minWidth: 160,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, color: TEXT_DARK, marginBottom: 4, fontSize: 14 }}>
              {tooltip.role.name}
            </div>
            {tooltip.role.purpose && (
              <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 6, lineHeight: 1.4 }}>
                {tooltip.role.purpose}
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--muted-foreground)", display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{
                background: tooltip.role.agent_name ? "color-mix(in oklch, #4ade80 15%, transparent)" : "color-mix(in oklch, #f97316 15%, transparent)",
                color: tooltip.role.agent_name ? "#4ade80" : "#f97316",
                padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 500,
              }}>
                {roleTypeLabel(tooltip.role.role_type)}
              </span>
              {tooltip.role.agent_name
                ? <span style={{ color: "var(--muted-foreground)" }}>{tooltip.role.agent_name}</span>
                : <span style={{ color: "#f97316", fontStyle: "italic" }}>Unassigned</span>
              }
            </div>
            <button
              onClick={() => setTooltip(null)}
              style={{
                position: "absolute", top: 6, right: 8, background: "none", border: "none",
                cursor: "pointer", fontSize: 14, color: "var(--muted-foreground)", lineHeight: 1,
              }}
            >
              x
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function HolacracySidebar() {
  const { companyPrefix } = useHostContext();
  const path = `/${companyPrefix ?? "unknown"}/circles`;
  return (
    <a href={path} onClick={(e) => { e.preventDefault(); window.history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
      fontSize: 13, fontWeight: 500, color: "var(--foreground)", opacity: 0.8,
      textDecoration: "none", borderRadius: 4,
    }}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>
      </svg>
      <span>Circles</span>
    </a>
  );
}
export function AgentRoleTab() {
  const hostCtx = useHostContext();
  const agentId = hostCtx?.entityId ?? null;

  const { data: roleData, loading } = usePluginData<{
    role_name: string; role_purpose: string; role_type: string;
    accountabilities: string[]; domains: string[];
    circle_id: string; circle_name: string; circle_purpose: string;
    checklists: Array<{ id: string; item_text: string; frequency: string }>;
    metrics: Array<{ id: string; name: string; unit: string | null; frequency: string }>;
    tensions: Array<{ id: string; title: string; tension_type: string; status: string }>;
  } | null>("agent-role", { agentId: agentId ?? "" });

  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading role data...</div>;
  if (!roleData) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>This agent has no Holacracy role assigned.</div>;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column" as const, gap: 20 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 18, fontWeight: 600, color: "var(--foreground)" }}>{roleData.role_name}</span>
          <span style={{
            fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 9999,
            background: "color-mix(in oklch, #60afd8 15%, transparent)", color: "#60afd8",
          }}>{roleData.circle_name}</span>
        </div>
        {roleData.role_purpose && <div style={{ fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.5 }}>{roleData.role_purpose}</div>}
      </div>

      {roleData.accountabilities && roleData.accountabilities.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Accountabilities</h3>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {roleData.accountabilities.map((a: string, i: number) => (
              <div key={i} style={{
                padding: "8px 12px", fontSize: 13, color: "var(--foreground)",
                borderBottom: i < roleData.accountabilities.length - 1 ? "1px solid var(--border)" : "none",
              }}>{a}</div>
            ))}
          </div>
        </div>
      )}

      {roleData.domains && roleData.domains.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Domains</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {roleData.domains.map((d: string, i: number) => (
              <span key={i} style={{
                fontSize: 12, padding: "4px 12px", borderRadius: 9999,
                border: "1px solid var(--border)", background: "var(--accent)", color: "var(--foreground)",
              }}>{d}</span>
            ))}
          </div>
        </div>
      )}

      {roleData.checklists && roleData.checklists.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Checklists</h3>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {roleData.checklists.map((cl: any, i: number) => (
              <div key={cl.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", fontSize: 13,
                borderBottom: i < roleData.checklists.length - 1 ? "1px solid var(--border)" : "none",
              }}>
                <span style={{ color: "var(--foreground)" }}>{cl.item_text}</span>
                <span style={{
                  fontSize: 11, padding: "2px 8px", borderRadius: 9999,
                  background: cl.frequency === "daily" ? "color-mix(in oklch, #10b981 15%, transparent)" : "var(--muted)",
                  color: cl.frequency === "daily" ? "#34d399" : "var(--muted-foreground)",
                }}>{cl.frequency}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {roleData.metrics && roleData.metrics.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Metrics</h3>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {roleData.metrics.map((m: any, i: number) => (
              <div key={m.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", fontSize: 13,
                borderBottom: i < roleData.metrics.length - 1 ? "1px solid var(--border)" : "none",
              }}>
                <span style={{ color: "var(--foreground)" }}>{m.name}</span>
                <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{m.unit ?? ""} {m.frequency}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {roleData.tensions && roleData.tensions.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 8px 0", color: "var(--foreground)" }}>Open Tensions</h3>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {roleData.tensions.map((t: any, i: number) => (
              <div key={t.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", fontSize: 13,
                borderBottom: i < roleData.tensions.length - 1 ? "1px solid var(--border)" : "none",
              }}>
                <span style={{ color: "var(--foreground)" }}>{t.title}</span>
                <span style={{
                  fontSize: 11, padding: "2px 8px", borderRadius: 9999,
                  background: t.tension_type === "governance" ? "color-mix(in oklch, #f59e0b 15%, transparent)" : "color-mix(in oklch, #3b82f6 15%, transparent)",
                  color: t.tension_type === "governance" ? "#fbbf24" : "#60a5fa",
                }}>{t.tension_type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function CircleDetailTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;

  const { data: governance, loading } = usePluginData<{
    strategies: Array<{ id: string; text: string; set_by_name: string | null; created_at: string }>;
    policies: Array<{ id: string; title: string; domain: string | null; description: string }>;
    checklists: Array<{ id: string; item_text: string; role_name: string | null; frequency: string }>;
    metrics: Array<{ id: string; name: string; unit: string | null; role_name: string | null; frequency: string }>;
  } | null>("circle-governance", { circleId: entityId ?? "" });

  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading governance data...</div>;
  if (!governance) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No governance data found for this circle.</div>;

  const isEmpty =
    governance.strategies.length === 0 &&
    governance.policies.length === 0 &&
    governance.checklists.length === 0 &&
    governance.metrics.length === 0;
  if (isEmpty) {
    return (
      <div style={{ padding: 16, color: "var(--muted-foreground)", lineHeight: 1.5 }}>
        No governance defined for this circle yet. Add strategies, policies, checklists, or metrics to populate this view.
      </div>
    );
  }

  const sectionHeader: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
    letterSpacing: "0.05em", marginBottom: 8, marginTop: 20,
  };
  const card: React.CSSProperties = {
    padding: "10px 14px", background: "var(--accent)", borderRadius: 6,
    border: "1px solid var(--border)", marginBottom: 6,
  };

  return (
    <div style={{ padding: 16 }}>
      {governance.strategies.length > 0 && (
        <>
          <div style={{ ...sectionHeader, marginTop: 0 }}>Strategies</div>
          {governance.strategies.map((s) => (
            <div key={s.id} style={card}>
              <div style={{ fontSize: 14, color: "var(--foreground)", fontWeight: 500, lineHeight: 1.5 }}>{s.text}</div>
              {s.set_by_name && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 4 }}>Set by {s.set_by_name}</div>}
            </div>
          ))}
        </>
      )}

      {governance.policies.length > 0 && (
        <>
          <div style={sectionHeader}>Policies</div>
          {governance.policies.map((p) => (
            <div key={p.id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 14, color: "var(--foreground)", fontWeight: 500 }}>{p.title}</div>
                {p.domain && <span style={{ fontSize: 10, color: "var(--muted-foreground)", background: "var(--muted)", padding: "1px 6px", borderRadius: 3 }}>{p.domain}</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4, lineHeight: 1.5 }}>{p.description}</div>
            </div>
          ))}
        </>
      )}

      {governance.checklists.length > 0 && (
        <>
          <div style={sectionHeader}>Checklists</div>
          {governance.checklists.map((cl) => (
            <div key={cl.id} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, color: "var(--foreground)" }}>{cl.item_text}</div>
                {cl.role_name && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>{cl.role_name}</div>}
              </div>
              <span style={{
                fontSize: 10, color: cl.frequency === "daily" ? "#34d399" : "var(--muted-foreground)",
                background: cl.frequency === "daily" ? "color-mix(in oklch, #10b981 15%, transparent)" : "var(--muted)",
                padding: "2px 6px", borderRadius: 3, fontWeight: 500,
              }}>{cl.frequency}</span>
            </div>
          ))}
        </>
      )}

      {governance.metrics.length > 0 && (
        <>
          <div style={sectionHeader}>Metrics</div>
          {governance.metrics.map((m) => (
            <div key={m.id} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, color: "var(--foreground)" }}>{m.name}</div>
                {m.role_name && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>{m.role_name}</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                {m.unit && <span style={{ fontSize: 11, color: "var(--muted-foreground)", marginRight: 6 }}>{m.unit}</span>}
                <span style={{
                  fontSize: 10, color: "var(--muted-foreground)", background: "var(--muted)",
                  padding: "2px 6px", borderRadius: 3,
                }}>{m.frequency}</span>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function CircleHealthWidget() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;

  const { data: summary } = usePluginData<Array<{
    id: string; name: string; color: string | null;
    strategiesCount: number; policiesCount: number;
    checklistsCount: number; metricsCount: number; openTensionsCount: number;
  }>>("governance-summary", { companyId: companyId ?? "" });

  if (!summary || summary.length === 0) {
    return <div style={{ padding: 16 }}><h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "var(--foreground)" }}>Circle Health</h3><p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>No circles configured yet.</p></div>;
  }

  const totalTensions = summary.reduce((s, c) => s + c.openTensionsCount, 0);

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--foreground)" }}>Circle Health</h3>
      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--foreground)" }}>{summary.length}</div>
          <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>circles</div>
        </div>
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: totalTensions > 0 ? "#f97316" : "var(--foreground)" }}>{totalTensions}</div>
          <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>open tensions</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
        {summary.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.color || "var(--muted-foreground)", display: "inline-block" }} />
              <span style={{ color: "var(--foreground)" }}>{c.name}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {c.openTensionsCount > 0 && <span style={{ fontSize: 11, color: "#f97316" }}>{c.openTensionsCount} tensions</span>}
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{c.policiesCount}p {c.checklistsCount}cl {c.metricsCount}m</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HolacracySettings() {
  return <div style={{ padding: 24 }}><h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Holacracy Settings</h2><p style={{ color: "var(--muted-foreground)" }}>Configure circle structure and governance rules.</p></div>;
}

// ── Workflows Tab ────────────────────────────────────────────────────────────

interface WorkflowStep {
  id: string;
  workflow_id: string;
  step_number: number;
  role_name: string;
  title: string;
  inputs: string[];
  outputs: string[];
  sla_days: number;
  blocks_next_step: boolean;
}

interface Workflow {
  id: string;
  circle_id: string;
  name: string;
  description: string | null;
  trigger: string | null;
  created_at: string;
  updated_at: string;
  steps: WorkflowStep[];
}

export function WorkflowsTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;

  const { data: workflows, loading, error, refresh } = usePluginData<Workflow[]>(
    "circle-workflows",
    { circleId: entityId ?? "" },
  );

  const createWorkflow = usePluginAction("workflow.create");
  const updateWorkflow = usePluginAction("workflow.update");
  const deleteWorkflow = usePluginAction("workflow.delete");
  const upsertStep = usePluginAction("workflow.step.upsert");
  const deleteStep = usePluginAction("workflow.step.delete");

  const [selectedWf, setSelectedWf] = useState<Workflow | null>(null);
  const [creating, setCreating] = useState(false);
  const [newWfName, setNewWfName] = useState("");
  const [newWfDesc, setNewWfDesc] = useState("");
  const [newWfTrigger, setNewWfTrigger] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Step form state
  const [editingStep, setEditingStep] = useState<WorkflowStep | null>(null);
  const [stepForm, setStepForm] = useState({ roleName: "", title: "", inputs: "", outputs: "", slaDays: 3, blocksNextStep: true });

  const card: React.CSSProperties = {
    padding: "10px 14px", background: "var(--accent)", borderRadius: 6,
    border: "1px solid var(--border)", marginBottom: 6, cursor: "pointer",
  };
  const sectionHeader: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
    letterSpacing: "0.05em", marginBottom: 8, marginTop: 16,
  };
  const input: React.CSSProperties = {
    width: "100%", background: "var(--background)", border: "1px solid var(--border)",
    borderRadius: 5, padding: "5px 10px", fontSize: 13, color: "var(--foreground)",
    marginBottom: 6, boxSizing: "border-box",
  };
  const btn = (color?: string): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 5, border: "1px solid var(--border)",
    background: color ?? "var(--accent)", color: color ? "#fff" : "var(--foreground)",
    fontSize: 12, cursor: "pointer", fontWeight: 600,
  });

  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading workflows...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;

  const handleCreateWorkflow = async () => {
    if (!newWfName.trim()) return;
    setBusy(true); setErr(null);
    try {
      await createWorkflow({ circleId: entityId, name: newWfName.trim(), description: newWfDesc.trim() || undefined, trigger: newWfTrigger.trim() || undefined });
      setCreating(false); setNewWfName(""); setNewWfDesc(""); setNewWfTrigger("");
      refresh();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const handleDeleteWorkflow = async (wf: Workflow) => {
    if (!window.confirm(`Delete workflow "${wf.name}"?`)) return;
    setBusy(true); setErr(null);
    try {
      await deleteWorkflow({ workflowId: wf.id });
      if (selectedWf?.id === wf.id) setSelectedWf(null);
      refresh();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const openStepEdit = (step?: WorkflowStep) => {
    if (step) {
      setEditingStep(step);
      setStepForm({ roleName: step.role_name, title: step.title, inputs: step.inputs.join(", "), outputs: step.outputs.join(", "), slaDays: step.sla_days, blocksNextStep: step.blocks_next_step });
    } else {
      setEditingStep(null);
      setStepForm({ roleName: "", title: "", inputs: "", outputs: "", slaDays: 3, blocksNextStep: true });
    }
  };

  const handleSaveStep = async () => {
    if (!selectedWf || !stepForm.title.trim() || !stepForm.roleName.trim()) return;
    setBusy(true); setErr(null);
    try {
      const nextStep = editingStep?.step_number ?? ((selectedWf.steps.length > 0 ? Math.max(...selectedWf.steps.map(s => s.step_number)) : 0) + 1);
      await upsertStep({
        workflowId: selectedWf.id,
        stepNumber: nextStep,
        roleName: stepForm.roleName.trim(),
        title: stepForm.title.trim(),
        inputs: stepForm.inputs.split(",").map(s => s.trim()).filter(Boolean),
        outputs: stepForm.outputs.split(",").map(s => s.trim()).filter(Boolean),
        slaDays: Number(stepForm.slaDays) || 3,
        blocksNextStep: stepForm.blocksNextStep,
      });
      setEditingStep(null);
      refresh();
      // Re-select workflow with updated data
      setTimeout(() => {
        const updated = (workflows ?? []).find(w => w.id === selectedWf.id);
        if (updated) setSelectedWf(updated);
      }, 300);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const handleDeleteStep = async (step: WorkflowStep) => {
    setBusy(true); setErr(null);
    try {
      await deleteStep({ stepId: step.id });
      refresh();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const wfList = workflows ?? [];

  return (
    <div style={{ padding: 16 }}>
      {err && <div style={{ padding: "8px 12px", background: "color-mix(in oklch, #f87171 12%, transparent)", border: "1px solid #f87171", borderRadius: 5, fontSize: 12, color: "#f87171", marginBottom: 10 }}>{err}</div>}

      {/* Workflow list */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>Workflow Templates</div>
        <button style={btn("#3b82f6")} onClick={() => setCreating(v => !v)} disabled={busy}>
          {creating ? "Cancel" : "+ New"}
        </button>
      </div>

      {creating && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <input style={input} placeholder="Workflow name *" value={newWfName} onChange={e => setNewWfName(e.target.value)} />
          <input style={input} placeholder="Description (optional)" value={newWfDesc} onChange={e => setNewWfDesc(e.target.value)} />
          <input style={input} placeholder="Trigger condition (optional)" value={newWfTrigger} onChange={e => setNewWfTrigger(e.target.value)} />
          <div style={{ display: "flex", gap: 6 }}>
            <button style={btn("#22c55e")} onClick={handleCreateWorkflow} disabled={busy || !newWfName.trim()}>Create</button>
            <button style={btn()} onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {wfList.length === 0 && !creating && (
        <div style={{ color: "var(--muted-foreground)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
          No workflows yet. Create one or restart the server to seed defaults.
        </div>
      )}

      {wfList.map(wf => (
        <div key={wf.id} style={{ ...card, background: selectedWf?.id === wf.id ? "var(--card)" : "var(--accent)", borderColor: selectedWf?.id === wf.id ? "#3b82f6" : "var(--border)" }}
          onClick={() => setSelectedWf(selectedWf?.id === wf.id ? null : wf)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{wf.name}</div>
              {wf.description && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>{wf.description}</div>}
              {wf.trigger && <div style={{ fontSize: 11, color: "#60a5fa", marginTop: 2 }}>Trigger: {wf.trigger}</div>}
            </div>
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: "var(--muted-foreground)", background: "var(--muted)", padding: "2px 6px", borderRadius: 3 }}>{wf.steps.length} steps</span>
              <button style={{ ...btn("#f87171"), padding: "2px 8px", fontSize: 11 }} onClick={e => { e.stopPropagation(); handleDeleteWorkflow(wf); }} disabled={busy}>✕</button>
            </div>
          </div>
        </div>
      ))}

      {/* Selected workflow detail */}
      {selectedWf && (
        <div style={{ marginTop: 16 }}>
          <div style={sectionHeader}>Steps — {selectedWf.name}</div>

          {/* Visual flow diagram — left to right, role boxes, arrows */}
          {selectedWf.steps.length > 0 && (
            <div style={{ overflowX: "auto", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 0, padding: "10px 4px" }}>
                {selectedWf.steps.map((step, i) => (
                  <React.Fragment key={step.id}>
                    <div style={{
                      minWidth: 120, maxWidth: 160,
                      background: "var(--card)",
                      border: "1.5px solid #a855f7",
                      borderRadius: 8,
                      padding: "8px 10px",
                      flexShrink: 0,
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", marginBottom: 2 }}>Step {step.step_number}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--foreground)", marginBottom: 2 }}>{step.title}</div>
                      <div style={{ fontSize: 10, color: "var(--muted-foreground)" }}>{step.role_name}</div>
                      {step.sla_days > 0 && <div style={{ fontSize: 9, color: "var(--muted-foreground)", marginTop: 2 }}>{step.sla_days}d SLA</div>}
                    </div>
                    {i < selectedWf.steps.length - 1 && (
                      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }}>
                        <div style={{ width: 18, height: 1.5, background: step.blocks_next_step ? "#a855f7" : "var(--muted-foreground)" }} />
                        <div style={{ width: 0, height: 0, borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: `6px solid ${step.blocks_next_step ? "#a855f7" : "var(--muted-foreground)"}` }} />
                      </div>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}

          {selectedWf.steps.map((step, i) => (
            <div key={step.id} style={{ ...card, cursor: "default" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#a855f7", background: "color-mix(in oklch, #a855f7 15%, transparent)", padding: "1px 6px", borderRadius: 3 }}>Step {step.step_number}</span>
                    <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{step.role_name}</span>
                    {step.sla_days > 0 && <span style={{ fontSize: 10, color: "var(--muted-foreground)", background: "var(--muted)", padding: "1px 5px", borderRadius: 3 }}>{step.sla_days}d SLA</span>}
                    {step.blocks_next_step && <span style={{ fontSize: 10, color: "#f97316", background: "color-mix(in oklch, #f97316 12%, transparent)", padding: "1px 5px", borderRadius: 3 }}>blocks next</span>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{step.title}</div>
                  {step.inputs.length > 0 && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>In: {step.inputs.join(", ")}</div>}
                  {step.outputs.length > 0 && <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>Out: {step.outputs.join(", ")}</div>}
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button style={{ ...btn(), padding: "2px 8px", fontSize: 11 }} onClick={() => openStepEdit(step)} disabled={busy}>Edit</button>
                  <button style={{ ...btn("#f87171"), padding: "2px 8px", fontSize: 11 }} onClick={() => handleDeleteStep(step)} disabled={busy}>✕</button>
                </div>
              </div>
            </div>
          ))}

          {/* Step editor */}
          {editingStep !== null || (
            <button style={{ ...btn("#3b82f6"), marginTop: 6 }} onClick={() => openStepEdit()} disabled={busy}>+ Add Step</button>
          )}
          {(editingStep !== null || stepForm.title) && (
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>{editingStep ? `Edit Step ${editingStep.step_number}` : "New Step"}</div>
              <input style={input} placeholder="Role name *" value={stepForm.roleName} onChange={e => setStepForm(f => ({ ...f, roleName: e.target.value }))} />
              <input style={input} placeholder="Step title *" value={stepForm.title} onChange={e => setStepForm(f => ({ ...f, title: e.target.value }))} />
              <input style={input} placeholder="Inputs (comma-separated)" value={stepForm.inputs} onChange={e => setStepForm(f => ({ ...f, inputs: e.target.value }))} />
              <input style={input} placeholder="Outputs (comma-separated)" value={stepForm.outputs} onChange={e => setStepForm(f => ({ ...f, outputs: e.target.value }))} />
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>SLA days:</label>
                <input style={{ ...input, width: 60, marginBottom: 0 }} type="number" min={1} value={stepForm.slaDays} onChange={e => setStepForm(f => ({ ...f, slaDays: Number(e.target.value) }))} />
                <label style={{ fontSize: 12, color: "var(--muted-foreground)", display: "flex", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" checked={stepForm.blocksNextStep} onChange={e => setStepForm(f => ({ ...f, blocksNextStep: e.target.checked }))} />
                  Blocks next step
                </label>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={btn("#22c55e")} onClick={handleSaveStep} disabled={busy || !stepForm.title.trim() || !stepForm.roleName.trim()}>Save</button>
                <button style={btn()} onClick={() => { setEditingStep(null); setStepForm({ roleName: "", title: "", inputs: "", outputs: "", slaDays: 3, blocksNextStep: true }); }} disabled={busy}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Issue Workflow Tab ────────────────────────────────────────────────────────
// Shows apply-workflow picker + progress of any active workflow on this issue.

interface WorkflowProgressStep {
  stepNumber: number;
  issueId: string;
  title: string;
  status: string;
}

interface WorkflowProgress {
  workflowId: string;
  workflowName: string;
  steps: WorkflowProgressStep[];
}

interface WorkflowOption {
  id: string;
  name: string;
  description: string | null;
  trigger: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  done: "#22c55e",
  in_progress: "#3b82f6",
  blocked: "#f97316",
  cancelled: "#6b7280",
  todo: "#a855f7",
  backlog: "#6b7280",
};

function stepStatusBadge(status: string) {
  const color = STATUS_COLOR[status] ?? "#6b7280";
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 3,
      background: `color-mix(in oklch, ${color} 18%, transparent)`,
      color,
    }}>{status.replace("_", " ")}</span>
  );
}

export function IssueWorkflowTab() {
  const hostCtx = useHostContext();
  const issueId = hostCtx?.entityId ?? null;
  const companyId = hostCtx?.companyId ?? null;

  const { data: progress, loading: progressLoading, refresh: refreshProgress } = usePluginData<WorkflowProgress | null>(
    "issue-workflow-progress",
    { issueId: issueId ?? "" },
  );

  const [selectedCircleId, setSelectedCircleId] = React.useState<string>("");
  const [selectedWorkflowId, setSelectedWorkflowId] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const { data: circles } = usePluginData<Array<{ id: string; name: string }>>(
    "circles-tree",
    { companyId: companyId ?? "" },
  );

  const { data: workflows } = usePluginData<WorkflowOption[]>(
    "circle-workflows",
    { circleId: selectedCircleId },
  );

  const handleApply = async () => {
    if (!issueId || !selectedWorkflowId || !companyId) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await fetch(`/api/plugin/paperclipai.plugin-holacracy/issues/${issueId}/apply-workflow?companyId=${companyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: selectedWorkflowId, companyId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      const result = await resp.json() as { stepsCreated: number };
      setSuccess(`Workflow applied — ${result.stepsCreated} sub-issues created.`);
      refreshProgress();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!issueId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No issue context.</div>;

  const card: React.CSSProperties = {
    padding: "8px 12px", background: "var(--accent)", borderRadius: 6,
    border: "1px solid var(--border)", marginBottom: 6,
  };
  const sectionHeader: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
    letterSpacing: "0.05em", marginBottom: 8,
  };
  const select: React.CSSProperties = {
    width: "100%", marginBottom: 6, padding: "6px 8px", fontSize: 13,
    background: "var(--input)", border: "1px solid var(--border)", borderRadius: 4,
    color: "var(--foreground)", outline: "none",
  };

  return (
    <div style={{ padding: 16 }}>
      {/* Progress section */}
      {progressLoading && <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>Loading...</div>}

      {!progressLoading && progress && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ ...sectionHeader, marginTop: 0 }}>Workflow Progress — {progress.workflowName}</div>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, alignItems: "center" }}>
            {progress.steps.map((step, idx) => (
              <React.Fragment key={step.issueId}>
                <div style={card}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#a855f7", background: "color-mix(in oklch, #a855f7 15%, transparent)", padding: "1px 6px", borderRadius: 3 }}>
                      Step {step.stepNumber}
                    </span>
                    {stepStatusBadge(step.status)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--foreground)", marginTop: 3, lineHeight: 1.4 }}>{step.title}</div>
                </div>
                {idx < progress.steps.length - 1 && (
                  <span style={{ fontSize: 16, color: "var(--muted-foreground)" }}>→</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {!progressLoading && !progress && (
        <div style={{ color: "var(--muted-foreground)", fontSize: 13, marginBottom: 16 }}>No workflow applied yet.</div>
      )}

      {/* Apply workflow section */}
      <div style={{ ...sectionHeader, marginTop: progress ? 0 : 0 }}>Apply Workflow Template</div>
      <div style={{ marginBottom: 4, fontSize: 12, color: "var(--muted-foreground)" }}>Circle</div>
      <select style={select} value={selectedCircleId} onChange={e => { setSelectedCircleId(e.target.value); setSelectedWorkflowId(""); }}>
        <option value="">— select circle —</option>
        {(circles ?? []).map((c: { id: string; name: string }) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      {selectedCircleId && (
        <>
          <div style={{ marginBottom: 4, fontSize: 12, color: "var(--muted-foreground)" }}>Workflow</div>
          <select style={select} value={selectedWorkflowId} onChange={e => setSelectedWorkflowId(e.target.value)}>
            <option value="">— select workflow —</option>
            {(workflows ?? []).map((w: WorkflowOption) => (
              <option key={w.id} value={w.id}>{w.name}{w.trigger ? ` (${w.trigger})` : ""}</option>
            ))}
          </select>
        </>
      )}

      {error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 6 }}>Error: {error}</div>}
      {success && <div style={{ color: "#22c55e", fontSize: 12, marginBottom: 6 }}>{success}</div>}

      <button
        style={{
          padding: "6px 14px", fontSize: 13, fontWeight: 600, borderRadius: 4, border: "none",
          background: selectedWorkflowId && !busy ? "#3b82f6" : "var(--muted)",
          color: selectedWorkflowId && !busy ? "#fff" : "var(--muted-foreground)",
          cursor: selectedWorkflowId && !busy ? "pointer" : "not-allowed",
        }}
        onClick={handleApply}
        disabled={!selectedWorkflowId || busy}
      >
        {busy ? "Applying..." : "Apply Workflow"}
      </button>
    </div>
  );
}

// ── Agreements (afspraken) — read-only list for the current circle ─────────

interface AgreementParty { roleId: string; circleId: string; }
interface AgreementRow {
  id: string;
  scope: "intra_circle" | "cross_circle";
  primary_circle_id: string | null;
  parties: AgreementParty[] | string;
  title: string;
  condition: string | null;
  commitment: string;
  status: "proposed" | "active" | "expired" | "revoked";
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

function agreementStatusColor(status: string): string {
  if (status === "active") return "#22c55e";
  if (status === "proposed") return "#fbbf24";
  if (status === "revoked") return "#f87171";
  return "var(--muted-foreground)";
}

export function AgreementsTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;
  const { data, loading, error } = usePluginData<AgreementRow[]>(
    "circle-agreements",
    { circleId: entityId ?? "" },
  );

  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading agreements...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;

  const agreements = data ?? [];

  const sectionHeader: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
    letterSpacing: "0.05em", marginBottom: 8, marginTop: 16,
  };
  const card: React.CSSProperties = {
    padding: "12px 14px", background: "var(--accent)", borderRadius: 6,
    border: "1px solid var(--border)", marginBottom: 8,
  };

  if (agreements.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ ...sectionHeader, marginTop: 0 }}>Agreements</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No agreements yet. Propose one via the <code>holacracy-propose-agreement</code> tool or POST <code>/agreements</code>.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...sectionHeader, marginTop: 0 }}>Agreements ({agreements.length})</div>
      {agreements.map((a) => {
        const parties: AgreementParty[] = Array.isArray(a.parties)
          ? a.parties
          : (typeof a.parties === "string" ? JSON.parse(a.parties) : []);
        return (
          <div key={a.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)", lineHeight: 1.4 }}>{a.title}</div>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 9999,
                color: agreementStatusColor(a.status),
                background: `color-mix(in oklch, ${agreementStatusColor(a.status)} 18%, transparent)`,
                textTransform: "uppercase", letterSpacing: "0.04em",
              }}>{a.status}</span>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted-foreground)" }}>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
                background: "var(--muted)", marginRight: 6,
              }}>{a.scope === "cross_circle" ? "CROSS-CIRCLE" : "INTRA-CIRCLE"}</span>
              <span>{parties.length} {parties.length === 1 ? "party" : "parties"}</span>
            </div>
            {a.condition && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--foreground)", lineHeight: 1.5 }}>
                <span style={{ color: "var(--muted-foreground)" }}>If:</span> {a.condition}
              </div>
            )}
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--foreground)", lineHeight: 1.5 }}>
              <span style={{ color: "var(--muted-foreground)" }}>Then:</span> {a.commitment}
            </div>
            {a.status === "revoked" && a.revoked_reason && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#f87171" }}>
                Revoked: {a.revoked_reason}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── IDM (Integrative Decision-Making) — read-only list + detail ────────────

interface IdmApprovalUiRow {
  id: string;
  company_id: string;
  approval_id: string;
  circle_id: string;
  proposer_agent_id: string | null;
  tension_id: string | null;
  phase: string;
  phase_entered_at: string;
  phase_deadline_at: string;
  proposal: unknown;
  amendments: unknown;
  created_at: string;
}

interface IdmPhaseInputUiRow {
  id: string;
  idm_id: string;
  phase: string;
  agent_id: string;
  role_id: string | null;
  kind: string;
  payload: unknown;
  created_at: string;
}

interface IdmObjectionUiRow {
  id: string;
  idm_id: string;
  raised_by_agent_id: string;
  raised_by_role_id: string | null;
  body: string;
  test_unworkable: { result: boolean; rationale: string } | null;
  test_follows_from_proposal: { result: boolean; rationale: string } | null;
  test_current_not_speculation: { result: boolean; rationale: string } | null;
  is_valid: boolean | null;
  validated_at: string | null;
  integrated_at: string | null;
  integration_amendment_id: string | null;
  created_at: string;
}

function idmPhaseColor(phase: string): string {
  if (phase === "adopted") return "#22c55e";
  if (phase === "dropped") return "#f87171";
  if (phase === "objections" || phase === "integration") return "#fbbf24";
  return "#3b82f6";
}

function formatCountdown(deadlineIso: string): string {
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / (60 * 60 * 1000));
  const minutes = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
  const sign = ms < 0 ? "-" : "";
  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  return `${sign}${minutes}m`;
}

export function IDMTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;
  const { data: list, loading, error } = usePluginData<IdmApprovalUiRow[]>(
    "idm-list-by-circle",
    { circleId: entityId ?? "" },
  );

  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading IDM processes...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;

  const idms = list ?? [];

  const sectionHeader: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
    letterSpacing: "0.05em", marginBottom: 8, marginTop: 16,
  };

  if (idms.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ ...sectionHeader, marginTop: 0 }}>IDM Processes</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No IDM processes yet. Open one via the <code>holacracy-idm-propose</code> tool or POST <code>/idm</code>.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...sectionHeader, marginTop: 0 }}>IDM Processes ({idms.length})</div>
      {idms.map((idm) => (
        <IDMCard key={idm.id} idm={idm} />
      ))}
    </div>
  );
}

function IDMCard({ idm }: { idm: IdmApprovalUiRow }) {
  const { data: detail } = usePluginData<{
    idm: IdmApprovalUiRow;
    inputs: IdmPhaseInputUiRow[];
    objections: IdmObjectionUiRow[];
  } | null>("idm-detail", { idmId: idm.id });

  const card: React.CSSProperties = {
    padding: "12px 14px", background: "var(--accent)", borderRadius: 6,
    border: "1px solid var(--border)", marginBottom: 12,
  };

  const proposal = (idm.proposal as { kind?: string; content?: unknown } | null) ?? null;
  const inputs = detail?.inputs ?? [];
  const objections = detail?.objections ?? [];

  const inputsByPhase = inputs.reduce<Record<string, IdmPhaseInputUiRow[]>>((acc, row) => {
    (acc[row.phase] ??= []).push(row);
    return acc;
  }, {});

  const subHeader: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)",
    textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 10, marginBottom: 4,
  };

  const inputLine: React.CSSProperties = {
    fontSize: 12, color: "var(--foreground)", padding: "4px 0",
    borderBottom: "1px solid var(--border)",
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>
          {proposal?.kind ? `[${String(proposal.kind).toUpperCase()}] ` : ""}IDM {idm.id.slice(0, 8)}
        </div>
        <span style={{
          fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 9999,
          color: idmPhaseColor(idm.phase),
          background: `color-mix(in oklch, ${idmPhaseColor(idm.phase)} 18%, transparent)`,
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>{idm.phase}</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
        Deadline in {formatCountdown(idm.phase_deadline_at)} (at {new Date(idm.phase_deadline_at).toLocaleString()})
      </div>

      <div style={subHeader}>Proposal</div>
      <pre style={{
        fontSize: 11, color: "var(--foreground)", background: "var(--muted)",
        padding: 8, borderRadius: 4, overflow: "auto", margin: 0, maxHeight: 160,
      }}>{JSON.stringify(proposal?.content ?? null, null, 2)}</pre>

      {Object.keys(inputsByPhase).length > 0 && (
        <>
          <div style={subHeader}>Inputs Timeline</div>
          {Object.entries(inputsByPhase).map(([phase, rows]) => (
            <div key={phase} style={{ marginTop: 4 }}>
              <div style={{ fontSize: 10, color: "var(--muted-foreground)", textTransform: "uppercase" }}>{phase}</div>
              {rows.map((row) => {
                const p = row.payload as { body?: string } | null;
                return (
                  <div key={row.id} style={inputLine}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
                      background: "var(--muted)", marginRight: 6,
                    }}>{row.kind}</span>
                    {p?.body ?? JSON.stringify(row.payload)}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}

      {objections.length > 0 && (
        <>
          <div style={subHeader}>Objections ({objections.length})</div>
          {objections.map((obj) => (
            <div key={obj.id} style={{
              padding: 8, marginTop: 4, borderRadius: 4,
              background: "var(--muted)", border: "1px solid var(--border)",
            }}>
              <div style={{ fontSize: 12, color: "var(--foreground)" }}>{obj.body}</div>
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--muted-foreground)" }}>
                Validity: {obj.is_valid === null
                  ? "untested"
                  : obj.is_valid ? "VALID" : "invalid"}
                {obj.integrated_at && " — integrated"}
              </div>
              {(obj.test_unworkable || obj.test_follows_from_proposal || obj.test_current_not_speculation) && (
                <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: 11, color: "var(--muted-foreground)" }}>
                  {obj.test_unworkable && (
                    <li>unworkable: {obj.test_unworkable.result ? "yes" : "no"} — {obj.test_unworkable.rationale}</li>
                  )}
                  {obj.test_follows_from_proposal && (
                    <li>follows-from-proposal: {obj.test_follows_from_proposal.result ? "yes" : "no"} — {obj.test_follows_from_proposal.rationale}</li>
                  )}
                  {obj.test_current_not_speculation && (
                    <li>current-not-speculation: {obj.test_current_not_speculation.result ? "yes" : "no"} — {obj.test_current_not_speculation.rationale}</li>
                  )}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── Phase 2 shared styles ──────────────────────────────────────────────────

const phase2SectionHeader: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
  letterSpacing: "0.05em", marginBottom: 8, marginTop: 16,
};
const phase2Card: React.CSSProperties = {
  padding: "12px 14px", background: "var(--accent)", borderRadius: 6,
  border: "1px solid var(--border)", marginBottom: 8,
};

function phase2StatusBadge(status: string, color: string): React.ReactElement {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 9999,
      color,
      background: `color-mix(in oklch, ${color} 18%, transparent)`,
      textTransform: "uppercase", letterSpacing: "0.04em",
    }}>{status}</span>
  );
}

// ── CrossLinksTab (Concept 1) ──────────────────────────────────────────────

interface CrossLinkUiRow {
  id: string;
  circle_a_id: string;
  circle_b_id: string;
  rep_role_a_id: string;
  rep_role_b_id: string;
  // Names joined in by the data source for display. May be null when a referenced
  // row was deleted; fall back to a shortened UUID in that case.
  circle_a_name: string | null;
  circle_b_name: string | null;
  rep_role_a_name: string | null;
  rep_role_b_name: string | null;
  purpose: string;
  status: "active" | "dissolved";
  dissolved_at: string | null;
  dissolved_reason: string | null;
  created_at: string;
}

export function CrossLinksTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;
  const { data, loading, error } = usePluginData<CrossLinkUiRow[]>(
    "circle-cross-links",
    { circleId: entityId ?? "" },
  );
  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading cross-links...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Cross-Links</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No cross-links yet. Open one via <code>holacracy-create-cross-link</code> or POST <code>/cross-links</code>.
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Cross-Links ({rows.length})</div>
      {rows.map((cl) => {
        const color = cl.status === "active" ? "#22c55e" : "var(--muted-foreground)";
        return (
          <div key={cl.id} style={phase2Card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontSize: 13, color: "var(--foreground)" }}>
                <strong>{cl.circle_a_name ?? cl.circle_a_id.slice(0, 8)}</strong>
                <span style={{ color: "var(--muted-foreground)" }}> ⇆ </span>
                <strong>{cl.circle_b_name ?? cl.circle_b_id.slice(0, 8)}</strong>
              </div>
              {phase2StatusBadge(cl.status, color)}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
              Reps: {cl.rep_role_a_name ?? cl.rep_role_a_id.slice(0, 8)}
              {" ⇆ "}
              {cl.rep_role_b_name ?? cl.rep_role_b_id.slice(0, 8)}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--foreground)", lineHeight: 1.5 }}>
              {cl.purpose}
            </div>
            {cl.status === "dissolved" && cl.dissolved_reason && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#f87171" }}>
                Dissolved: {cl.dissolved_reason}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── ReleasesTab (Concept 3) ────────────────────────────────────────────────

interface RoleReleaseUiRow {
  id: string;
  role_assignment_id: string;
  released_by_agent_id: string;
  handoff_to_agent_id: string | null;
  // Names joined in by the data source for display. May be null when the
  // referenced row was deleted; fall back to a shortened UUID in that case.
  role_name: string | null;
  released_by_agent_name: string | null;
  handoff_to_agent_name: string | null;
  accepted_by_lead_link_agent_name: string | null;
  reason: string | null;
  status: "requested" | "pending_handoff" | "completed" | "cancelled";
  requested_at: string;
  completed_at: string | null;
}

export function ReleasesTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;
  const { data, loading, error } = usePluginData<RoleReleaseUiRow[]>(
    "role-releases",
    { circleId: entityId ?? "" },
  );
  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading role releases...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Role Releases</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No role-release requests for this circle.
        </div>
      </div>
    );
  }
  function color(status: string): string {
    if (status === "completed") return "#22c55e";
    if (status === "requested") return "#fbbf24";
    if (status === "pending_handoff") return "#3b82f6";
    return "var(--muted-foreground)";
  }
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Role Releases ({rows.length})</div>
      {rows.map((r) => (
        <div key={r.id} style={phase2Card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--foreground)" }}>
              Role <strong>{r.role_name ?? r.role_assignment_id.slice(0, 8)}</strong>
              {" released by "}
              <strong>{r.released_by_agent_name ?? r.released_by_agent_id.slice(0, 8)}</strong>
            </div>
            {phase2StatusBadge(r.status, color(r.status))}
          </div>
          {r.reason && (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--foreground)" }}>Reason: {r.reason}</div>
          )}
          {r.handoff_to_agent_id && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
              Handoff to {r.handoff_to_agent_name ?? r.handoff_to_agent_id.slice(0, 8)}
            </div>
          )}
          {r.accepted_by_lead_link_agent_name && (
            <div style={{ marginTop: 2, fontSize: 11, color: "var(--muted-foreground)" }}>
              Accepted by {r.accepted_by_lead_link_agent_name}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── TacticalPulseTab (Concept 6) ───────────────────────────────────────────

interface TacticalRecordUiRow {
  id: string;
  cadence: string;
  summary: { openTensions?: number; activeAssignments?: number; cadence?: string; recordedAt?: string } | unknown;
  recorded_at: string;
}

export function TacticalPulseTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;
  const { data, loading, error } = usePluginData<TacticalRecordUiRow[]>(
    "tactical-records",
    { circleId: entityId ?? "" },
  );
  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading tactical records...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Tactical Pulse</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No tactical pulses recorded yet. Run one via <code>holacracy-run-tactical-pulse</code>.
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Tactical Pulse ({rows.length})</div>
      {rows.map((r) => {
        const summary = (typeof r.summary === "object" && r.summary !== null
          ? (r.summary as { openTensions?: number; activeAssignments?: number })
          : {});
        return (
          <div key={r.id} style={phase2Card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--foreground)" }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
                  background: "var(--muted)", marginRight: 6,
                }}>{r.cadence.toUpperCase()}</span>
                {new Date(r.recorded_at).toLocaleString()}
              </div>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--foreground)" }}>
              Open tensions: <strong>{summary.openTensions ?? "—"}</strong>
              {" · "}
              Active assignments: <strong>{summary.activeAssignments ?? "—"}</strong>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── CrossRoleRequestsTab (Concept 6) ──────────────────────────────────────

interface CrossRoleRequestUiRow {
  id: string;
  requesting_role_id: string;
  requesting_role_name: string | null;
  target_role_id: string;
  target_role_name: string | null;
  kind: "next_action" | "project" | "info";
  body: string;
  status: "pending" | "accepted" | "declined";
  issue_id: string | null;
  decline_reason: string | null;
  created_at: string;
}

export function CrossRoleRequestsTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;
  const { data, loading, error } = usePluginData<CrossRoleRequestUiRow[]>(
    "cross-role-requests",
    { circleId: entityId ?? "" },
  );
  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading cross-role requests...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Cross-Role Requests</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No cross-role requests touching this circle.
        </div>
      </div>
    );
  }
  function color(status: string): string {
    if (status === "accepted") return "#22c55e";
    if (status === "pending") return "#fbbf24";
    if (status === "declined") return "#f87171";
    return "var(--muted-foreground)";
  }
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Cross-Role Requests ({rows.length})</div>
      {rows.map((r) => (
        <div key={r.id} style={phase2Card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--foreground)" }}>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
                background: "var(--muted)", marginRight: 6,
              }}>{r.kind.replace("_", " ").toUpperCase()}</span>
              <strong>{r.requesting_role_name ?? r.requesting_role_id.slice(0, 8)}</strong>
              <span style={{ color: "var(--muted-foreground)" }}> → </span>
              <strong>{r.target_role_name ?? r.target_role_id.slice(0, 8)}</strong>
            </div>
            {phase2StatusBadge(r.status, color(r.status))}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: "var(--foreground)", lineHeight: 1.5 }}>{r.body}</div>
          {r.status === "declined" && r.decline_reason && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#f87171" }}>Declined: {r.decline_reason}</div>
          )}
          {r.issue_id && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
              Issue: <code>{r.issue_id.slice(0, 8)}</code>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── ElectionsTab (Concept 8) ───────────────────────────────────────────────

interface ElectionUiRow {
  id: string;
  circle_id: string;
  target_role_id: string;
  target_role_name: string | null;
  status: "open" | "scoring" | "scored" | "decided" | "cancelled";
  decision_agent_id: string | null;
  decision_agent_name: string | null;
  created_at: string;
}

export function ElectionsTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;
  const { data, loading, error } = usePluginData<ElectionUiRow[]>(
    "elections-by-circle",
    { circleId: entityId ?? "" },
  );
  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading elections...</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Role Elections</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No elections opened for this circle.
        </div>
      </div>
    );
  }
  function color(status: string): string {
    if (status === "decided") return "#22c55e";
    if (status === "scored") return "#3b82f6";
    if (status === "open" || status === "scoring") return "#fbbf24";
    if (status === "cancelled") return "#f87171";
    return "var(--muted-foreground)";
  }
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...phase2SectionHeader, marginTop: 0 }}>Role Elections ({rows.length})</div>
      {rows.map((e) => (
        <div key={e.id} style={phase2Card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--foreground)" }}>
              Target role <strong>{e.target_role_name ?? e.target_role_id.slice(0, 8)}</strong>
            </div>
            {phase2StatusBadge(e.status, color(e.status))}
          </div>
          {e.decision_agent_id && (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--foreground)" }}>
              Decided: <strong>{e.decision_agent_name ?? e.decision_agent_id.slice(0, 8)}</strong>
            </div>
          )}
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
            Opened {new Date(e.created_at).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Phase 1.8 — SystemPulseTab ───────────────────────────────────────────
// Read-only view of the host's heartbeat snapshot. Subscribes to the
// `system-pulse` data source, which returns the latest payload published by
// the heartbeat-bridge.

interface SystemPulsePayload {
  tickId: number;
  timestamp: string;
  dbHealthy: boolean;
  brokerHealthy: boolean;
  activeAgentCount: number;
  openEscalations: number;
  silentRunsDetected: number;
  recoveredRuns: number;
  degradedMode: "green" | "yellow" | "red";
  lastIdmPhaseAdvance: string | null;
  lastTacticalPulseByCircle: Record<string, string>;
  lastGovernancePulseByCircle: Record<string, string>;
}

const _degradedColor: Record<SystemPulsePayload["degradedMode"], string> = {
  green: "#22c55e",
  yellow: "#fbbf24",
  red: "#f87171",
};

export function SystemPulseTab() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;
  const { data, loading, error } = usePluginData<SystemPulsePayload | null>("system-pulse", { companyId: companyId ?? "" });
  if (loading) {
    return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading heartbeat...</div>;
  }
  if (error) {
    return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  }
  if (!data) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
          No heartbeat received yet. The host publishes a snapshot every ~30s on
          <code style={{ marginLeft: 4 }}>paperclip/v1/heartbeat/{`{companyId}`}</code>.
        </div>
      </div>
    );
  }
  const tacticalEntries = Object.entries(data.lastTacticalPulseByCircle);
  const govEntries = Object.entries(data.lastGovernancePulseByCircle);
  return (
    <div style={{ padding: 16 }}>
      {/* Live tick beat + degraded-mode banner */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: 12, marginBottom: 16,
        borderRadius: 8, border: "1px solid var(--border)",
        background: `color-mix(in oklch, ${_degradedColor[data.degradedMode]} 12%, transparent)`,
      }}>
        <span style={{
          display: "inline-block", width: 10, height: 10, borderRadius: "50%",
          background: _degradedColor[data.degradedMode],
          boxShadow: `0 0 8px ${_degradedColor[data.degradedMode]}`,
          animation: "pulse 2s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
          {data.degradedMode.toUpperCase()}
        </span>
        <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          Tick #{data.tickId} · {new Date(data.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Counters */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--muted-foreground)" }}>Active agents</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: "var(--foreground)" }}>{data.activeAgentCount}</div>
        </div>
        <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--muted-foreground)" }}>Open escalations</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: "var(--foreground)" }}>{data.openEscalations}</div>
        </div>
        <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--muted-foreground)" }}>Silent runs</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: "var(--foreground)" }}>{data.silentRunsDetected}</div>
        </div>
        <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--muted-foreground)" }}>Broker / DB</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
            {data.brokerHealthy ? "Broker OK" : "Broker DOWN"} · {data.dbHealthy ? "DB OK" : "DB DOWN"}
          </div>
        </div>
      </div>

      {/* Polyrhythm timeline */}
      <div style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", color: "var(--muted-foreground)", marginBottom: 8 }}>
        Polyrhythm
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 6, alignItems: "center", fontSize: 12 }}>
          <div style={{ color: "var(--muted-foreground)" }}>Host tick (30s)</div>
          <div style={{ color: "var(--foreground)" }}>{new Date(data.timestamp).toLocaleTimeString()}</div>

          <div style={{ color: "var(--muted-foreground)" }}>IDM phase advance</div>
          <div style={{ color: "var(--foreground)" }}>
            {data.lastIdmPhaseAdvance ? new Date(data.lastIdmPhaseAdvance).toLocaleString() : "—"}
          </div>

          <div style={{ color: "var(--muted-foreground)" }}>Tactical pulses</div>
          <div style={{ color: "var(--foreground)" }}>
            {tacticalEntries.length === 0
              ? "—"
              : tacticalEntries.map(([cid, ts]) => `${cid.slice(0, 8)}: ${new Date(ts).toLocaleString()}`).join(" · ")}
          </div>

          <div style={{ color: "var(--muted-foreground)" }}>Governance pulses</div>
          <div style={{ color: "var(--foreground)" }}>
            {govEntries.length === 0
              ? "—"
              : govEntries.map(([cid, ts]) => `${cid.slice(0, 8)}: ${new Date(ts).toLocaleString()}`).join(" · ")}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Phase 1.9 — DNATab ───────────────────────────────────────────────────
// Read-only display of the current Company DNA envelope. Subscribes to the
// `company-dna` data source which returns the latest projected envelope.

interface DnaEnvelopeUi {
  dna_version: "1";
  company_id: string;
  generation: number;
  mutated_at: string | null;
  mutated_reason: string | null;
  identity: { name: string; mission_statement: string | null; values: string[] };
  constitution: { governance: string; transport: string; text: string | null; doctrine_ref: string };
  policies: Array<{ id: string; title: string; scope: string; text: string | null }>;
  active_agreements: Array<{ id: string; condition: string | null; commitment: string | null }>;
  heuristic_weights_version: number | null;
  anchor_circle_id: string | null;
}

const _dnaSectionHeader: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, textTransform: "uppercase",
  color: "var(--muted-foreground)", marginTop: 16, marginBottom: 6,
  letterSpacing: "0.04em",
};

export function DNATab() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;
  const { data, loading, error } = usePluginData<DnaEnvelopeUi | null>("company-dna", { companyId: companyId ?? "" });
  const proposeMutation = usePluginAction("propose-dna-mutation");
  if (loading) {
    return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading DNA envelope...</div>;
  }
  if (error) {
    return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  }
  if (!data) {
    return (
      <div style={{ padding: 16, color: "var(--muted-foreground)" }}>
        No DNA envelope yet. Set the company's mission_statement / values / constitution to seed one.
      </div>
    );
  }
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--foreground)" }}>
          {data.identity.name}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
          Generation {data.generation} · v{data.dna_version}
          {data.mutated_at ? ` · last mutated ${new Date(data.mutated_at).toLocaleString()}` : ""}
        </div>
      </div>

      <div style={_dnaSectionHeader}>Mission</div>
      <div style={{ fontSize: 13, color: "var(--foreground)", whiteSpace: "pre-wrap" }}>
        {data.identity.mission_statement ?? "(not set)"}
      </div>

      <div style={_dnaSectionHeader}>Values</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {data.identity.values.length === 0
          ? <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>(none)</span>
          : data.identity.values.map((v, i) => (
            <span key={i} style={{
              fontSize: 12, padding: "3px 9px", borderRadius: 9999,
              background: "color-mix(in oklch, #3b82f6 14%, transparent)",
              color: "var(--foreground)",
            }}>{v}</span>
          ))}
      </div>

      <div style={_dnaSectionHeader}>Constitution</div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 6 }}>
        {data.constitution.governance} · {data.constitution.transport} · <code>{data.constitution.doctrine_ref}</code>
      </div>
      <div style={{ fontSize: 13, color: "var(--foreground)", whiteSpace: "pre-wrap" }}>
        {data.constitution.text ?? "(no constitution text set)"}
      </div>

      <div style={_dnaSectionHeader}>Top-level policies ({data.policies.length})</div>
      {data.policies.length === 0
        ? <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>None.</div>
        : data.policies.map((p) => (
          <div key={p.id} style={{ marginBottom: 8, padding: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{p.title}</div>
            {p.text && <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>{p.text}</div>}
          </div>
        ))}

      <div style={_dnaSectionHeader}>Active agreements ({data.active_agreements.length})</div>
      {data.active_agreements.length === 0
        ? <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>None.</div>
        : data.active_agreements.map((a) => (
          <div key={a.id} style={{ marginBottom: 8, padding: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
            {a.condition && <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>If: {a.condition}</div>}
            {a.commitment && <div style={{ fontSize: 13, color: "var(--foreground)", marginTop: 2 }}>Then: {a.commitment}</div>}
          </div>
        ))}

      <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => proposeMutation({})}
          style={{
            padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)",
            background: "var(--muted)", color: "var(--foreground)", cursor: "pointer",
            fontSize: 13,
          }}
        >
          Propose DNA mutation
        </button>
      </div>
    </div>
  );
}

// ─── Phase 1.14 — DiscussionsTab ───────────────────────────────────────────
interface DiscussionRow {
  id: string;
  topic: string;
  status: string;
  phase: string;
  speaker_mode: string;
  rounds_planned: number;
  rounds_completed: number;
  current_speaker_idx: number;
  participant_agent_ids: string[];
  speaker_order: string[];
  conclusion: string | null;
  conclusion_kind: string | null;
  started_at: string;
  concluded_at: string | null;
}
interface DiscussionTurn {
  issueId: string;
  agentId: string | null;
  agentName: string | null;
  roundNumber: number;
  isSummary: boolean;
  status: string;
  content: string | null;
  completedAt: string | null;
  createdAt: string;
}

export function DiscussionsTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;

  const { data, loading, error, refresh } = usePluginData<{
    open: DiscussionRow[];
    concluded: DiscussionRow[];
    turns: Record<string, DiscussionTurn[]>;
  }>("circle-discussions", { circleId: entityId ?? "" });

  const createDiscussion = usePluginAction("discussion.create");
  const concludeDiscussionAction = usePluginAction("discussion.conclude");

  const [topic, setTopic] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rounds, setRounds] = useState(1);
  const [speakerMode, setSpeakerMode] = useState<"reverse-priority" | "roundtable" | "parallel">("reverse-priority");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const input: React.CSSProperties = {
    width: "100%", background: "var(--background)", border: "1px solid var(--border)",
    borderRadius: 5, padding: "5px 10px", fontSize: 13, color: "var(--foreground)",
    marginBottom: 6, boxSizing: "border-box",
  };
  const btn = (color?: string): React.CSSProperties => ({
    padding: "6px 14px", borderRadius: 5, border: "1px solid var(--border)",
    background: color ?? "var(--accent)", color: color ? "#fff" : "var(--foreground)",
    fontSize: 12, cursor: "pointer", fontWeight: 600,
  });
  const sectionHeader: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
    letterSpacing: "0.05em", marginBottom: 8, marginTop: 16,
  };

  if (loading) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading discussions…</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;
  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;

  const handleStart = async () => {
    if (!topic.trim()) return;
    setBusy(true);
    setErrMsg(null);
    try {
      await createDiscussion({
        circleId: entityId,
        topic: topic.trim(),
        prompt: prompt.trim() || undefined,
        rounds,
        speakerMode,
      });
      setTopic(""); setPrompt(""); setRounds(1);
      refresh();
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleConclude = async (id: string) => {
    if (!window.confirm("Force-conclude this discussion?")) return;
    setBusy(true);
    try {
      await concludeDiscussionAction({ discussionId: id, conclusion: "(operator concluded)", conclusionKind: "note" });
      refresh();
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = data?.open ?? [];
  const concluded = data?.concluded ?? [];
  const turns = data?.turns ?? {};

  return (
    <div style={{ padding: 16 }}>
      {errMsg && (
        <div style={{
          padding: "8px 12px", background: "color-mix(in oklch, #f87171 12%, transparent)",
          border: "1px solid #f87171", borderRadius: 5, fontSize: 12, color: "#f87171", marginBottom: 10,
        }}>{errMsg}</div>
      )}

      <div style={sectionHeader}>Start a new discussion</div>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Topic — what does this circle need to discuss?"
          style={{ ...input, minHeight: 48, fontFamily: "inherit" }}
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Prompt for agents (optional — default: 'Share your view in 1-2 paragraphs')"
          style={{ ...input, minHeight: 36, fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Rounds:</label>
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} style={{ ...input, width: 70, marginBottom: 0 }}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Mode:</label>
          <select value={speakerMode} onChange={(e) => setSpeakerMode(e.target.value as typeof speakerMode)} style={{ ...input, width: 180, marginBottom: 0 }}>
            <option value="reverse-priority">reverse-priority (Lead Link last)</option>
            <option value="roundtable">roundtable (alpha)</option>
            <option value="parallel">parallel (all at once)</option>
          </select>
          <button style={btn("#22c55e")} onClick={handleStart} disabled={busy || !topic.trim()}>Start</button>
        </div>
      </div>

      <div style={sectionHeader}>Open discussions ({open.length})</div>
      {open.length === 0 && <div style={{ color: "var(--muted-foreground)", fontSize: 13, marginBottom: 12 }}>None.</div>}
      {open.map((d) => (
        <div key={d.id} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", marginBottom: 4 }}>{d.topic}</div>
              <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                phase={d.phase} · mode={d.speaker_mode} · round {d.rounds_completed}/{d.rounds_planned}
                {d.speaker_mode !== "parallel" && d.phase === "open" && (
                  <> · current speaker idx={d.current_speaker_idx}/{(d.speaker_order ?? d.participant_agent_ids).length}</>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button style={btn()} onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                {expanded === d.id ? "Collapse" : "Transcript"}
              </button>
              <button style={btn("#f87171")} onClick={() => handleConclude(d.id)} disabled={busy}>Force-Conclude</button>
            </div>
          </div>
          {expanded === d.id && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              {(turns[d.id] ?? []).map((t) => (
                <div key={t.issueId} style={{ marginBottom: 8, fontSize: 12 }}>
                  <div style={{ color: "var(--muted-foreground)" }}>
                    {t.isSummary ? "Summary" : `Round ${t.roundNumber}`} · {t.agentName ?? t.agentId?.slice(0, 8) ?? "unknown"} · {t.status}
                  </div>
                  <div style={{ color: "var(--foreground)", whiteSpace: "pre-wrap" }}>{t.content ?? "(empty)"}</div>
                </div>
              ))}
              {(turns[d.id] ?? []).length === 0 && (
                <div style={{ color: "var(--muted-foreground)", fontSize: 12 }}>No turns yet.</div>
              )}
            </div>
          )}
        </div>
      ))}

      <div style={sectionHeader}>Concluded ({concluded.length})</div>
      {concluded.length === 0 && <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>None.</div>}
      {concluded.map((d) => (
        <div key={d.id} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{d.topic}</div>
              <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>
                {d.conclusion_kind ?? "note"} · {d.rounds_planned} round(s)
              </div>
              {d.conclusion && (
                <div style={{ fontSize: 12, color: "var(--foreground)", marginTop: 6, whiteSpace: "pre-wrap" }}>
                  {d.conclusion.slice(0, 500)}{d.conclusion.length > 500 ? "…" : ""}
                </div>
              )}
            </div>
            <button style={btn()} onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
              {expanded === d.id ? "Collapse" : "Transcript"}
            </button>
          </div>
          {expanded === d.id && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              {(turns[d.id] ?? []).map((t) => (
                <div key={t.issueId} style={{ marginBottom: 8, fontSize: 12 }}>
                  <div style={{ color: "var(--muted-foreground)" }}>
                    {t.isSummary ? "Summary" : `Round ${t.roundNumber}`} · {t.agentName ?? t.agentId?.slice(0, 8) ?? "unknown"}
                  </div>
                  <div style={{ color: "var(--foreground)", whiteSpace: "pre-wrap" }}>{t.content ?? "(empty)"}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Phase 1.15h-c — MessagesTab (replaces DiscussionsTab at the circle level) ─
type FeedKindFilter = "all" | "turn" | "commitment" | "comment" | "lifecycle";

interface FeedItemTurn {
  kind: "turn";
  id: string;
  at: string;
  discussionId: string;
  agentId: string | null;
  agentName: string | null;
  roundNumber: number;
  isSummary: boolean;
  status: string;
  content: string | null;
  topic: string | null;
}
interface FeedItemLifecycle {
  kind: "lifecycle";
  id: string;
  at: string;
  discussionId: string;
  event: "opened" | "concluded";
  topic: string;
  conclusion: string | null;
  conclusionKind: string | null;
}
interface FeedItemCommitment {
  kind: "commitment";
  id: string;
  at: string;
  discussionId: string;
  agentId: string;
  agentName: string | null;
  signal: string;
  reason: string | null;
}
interface FeedItemComment {
  kind: "comment";
  id: string;
  at: string;
  issueId: string;
  issueTitle: string | null;
  authorAgentId: string | null;
  authorAgentName: string | null;
  authorUserId: string | null;
  body: string;
}
type FeedItem = FeedItemTurn | FeedItemLifecycle | FeedItemCommitment | FeedItemComment;

export function MessagesTab() {
  const hostCtx = useHostContext();
  const entityId = hostCtx?.entityId ?? null;

  const { data, loading, error, refresh } = usePluginData<{
    items: FeedItem[];
    circleId: string | null;
  }>("circle-messages", { circleId: entityId ?? "" });

  const createDiscussion = usePluginAction("discussion.create");

  // Poll every 5s for live updates while the tab is mounted.
  useEffect(() => {
    if (!entityId) return;
    const handle = setInterval(() => refresh(), 5000);
    return () => clearInterval(handle);
  }, [entityId, refresh]);

  const [filter, setFilter] = useState<FeedKindFilter>("all");
  const [topic, setTopic] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rounds, setRounds] = useState(1);
  const [speakerMode, setSpeakerMode] = useState<"reverse-priority" | "roundtable" | "parallel">("reverse-priority");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const input: React.CSSProperties = {
    width: "100%", background: "var(--background)", border: "1px solid var(--border)",
    borderRadius: 5, padding: "5px 10px", fontSize: 13, color: "var(--foreground)",
    marginBottom: 6, boxSizing: "border-box",
  };
  const btn = (color?: string, active?: boolean): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 5,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: color ?? (active ? "var(--accent)" : "transparent"),
    color: color ? "#fff" : "var(--foreground)",
    fontSize: 12, cursor: "pointer", fontWeight: active ? 600 : 500,
  });
  const sectionHeader: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase",
    letterSpacing: "0.05em", marginBottom: 8, marginTop: 16,
  };

  if (!entityId) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No circle selected.</div>;
  if (loading && !data) return <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading messages…</div>;
  if (error) return <div style={{ padding: 16, color: "#f87171" }}>Error: {error.message}</div>;

  const handleStart = async () => {
    if (!topic.trim()) return;
    setBusy(true);
    setErrMsg(null);
    try {
      await createDiscussion({
        circleId: entityId,
        topic: topic.trim(),
        prompt: prompt.trim() || undefined,
        rounds,
        speakerMode,
      });
      setTopic(""); setPrompt(""); setRounds(1);
      refresh();
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const items = data?.items ?? [];
  const filtered = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const counts: Record<FeedKindFilter, number> = {
    all: items.length,
    turn: items.filter((i) => i.kind === "turn").length,
    commitment: items.filter((i) => i.kind === "commitment").length,
    comment: items.filter((i) => i.kind === "comment").length,
    lifecycle: items.filter((i) => i.kind === "lifecycle").length,
  };

  const fmtTime = (s: string) => {
    try {
      const d = new Date(s);
      const now = Date.now();
      const ageMs = now - d.getTime();
      if (ageMs < 60_000) return `${Math.max(0, Math.floor(ageMs / 1000))}s ago`;
      if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
      if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
      return d.toLocaleDateString();
    } catch {
      return s;
    }
  };

  return (
    <div style={{ padding: 16 }}>
      {errMsg && (
        <div style={{
          padding: "8px 12px", background: "color-mix(in oklch, #f87171 12%, transparent)",
          border: "1px solid #f87171", borderRadius: 5, fontSize: 12, color: "#f87171", marginBottom: 10,
        }}>{errMsg}</div>
      )}

      <div style={sectionHeader}>Start a new discussion</div>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Topic — what does this circle need to discuss?"
          style={{ ...input, minHeight: 48, fontFamily: "inherit" }}
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Prompt for agents (optional — default: 'Share your view in 1-2 paragraphs')"
          style={{ ...input, minHeight: 36, fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Rounds:</label>
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} style={{ ...input, width: 70, marginBottom: 0 }}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Mode:</label>
          <select value={speakerMode} onChange={(e) => setSpeakerMode(e.target.value as typeof speakerMode)} style={{ ...input, width: 180, marginBottom: 0 }}>
            <option value="reverse-priority">reverse-priority (Lead Link last)</option>
            <option value="roundtable">roundtable (alpha)</option>
            <option value="parallel">parallel (all at once)</option>
          </select>
          <button style={btn("#22c55e")} onClick={handleStart} disabled={busy || !topic.trim()}>Start</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {(["all", "turn", "commitment", "comment", "lifecycle"] as FeedKindFilter[]).map((k) => (
          <button
            key={k}
            style={btn(undefined, filter === k)}
            onClick={() => setFilter(k)}
          >
            {k === "all" ? "All" : k.charAt(0).toUpperCase() + k.slice(1) + "s"} ({counts[k]})
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted-foreground)" }}>
          live · refreshes every 5s
        </span>
      </div>

      {filtered.length === 0 && (
        <div style={{ color: "var(--muted-foreground)", fontSize: 13, padding: 24, textAlign: "center" }}>
          No messages yet. Start a discussion above.
        </div>
      )}

      {filtered.map((item) => (
        <FeedItemTile key={item.id} item={item} fmtTime={fmtTime} />
      ))}
    </div>
  );
}

// Phase 1.15h-d — A circle-scoped Messages section embedded inside the
// CircleNavigator detail view. Reuses the `circle-messages` data source and
// the `FeedItemTile` renderer. Includes the "start a new discussion" form.
// Polls every 5s for live updates while mounted.
export function CircleMessagesSection({ circleId }: { circleId: string | null }) {
  const { data, loading, error, refresh } = usePluginData<{
    items: FeedItem[];
    circleId: string | null;
  }>("circle-messages", { circleId: circleId ?? "" });

  const createDiscussion = usePluginAction("discussion.create");

  useEffect(() => {
    if (!circleId) return;
    const handle = setInterval(() => refresh(), 5000);
    return () => clearInterval(handle);
  }, [circleId, refresh]);

  const [filter, setFilter] = useState<FeedKindFilter>("all");
  const [topic, setTopic] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rounds, setRounds] = useState(1);
  const [speakerMode, setSpeakerMode] = useState<"reverse-priority" | "roundtable" | "parallel">("reverse-priority");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [showStart, setShowStart] = useState(false);

  const fmtTime = (s: string) => {
    try {
      const d = new Date(s);
      const ageMs = Date.now() - d.getTime();
      if (ageMs < 60_000) return `${Math.max(0, Math.floor(ageMs / 1000))}s ago`;
      if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
      if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
      return d.toLocaleDateString();
    } catch { return s; }
  };

  if (!circleId) return null;

  const items = data?.items ?? [];
  const filtered = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const counts: Record<FeedKindFilter, number> = {
    all: items.length,
    turn: items.filter((i) => i.kind === "turn").length,
    commitment: items.filter((i) => i.kind === "commitment").length,
    comment: items.filter((i) => i.kind === "comment").length,
    lifecycle: items.filter((i) => i.kind === "lifecycle").length,
  };

  const input: React.CSSProperties = {
    width: "100%", background: "var(--background)", border: "1px solid var(--border)",
    borderRadius: 5, padding: "5px 10px", fontSize: 13, color: "var(--foreground)",
    marginBottom: 6, boxSizing: "border-box",
  };
  const btn = (color?: string, active?: boolean): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 5,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: color ?? (active ? "var(--accent)" : "transparent"),
    color: color ? "#fff" : "var(--foreground)",
    fontSize: 12, cursor: "pointer", fontWeight: active ? 600 : 500,
  });

  const handleStart = async () => {
    if (!topic.trim()) return;
    setBusy(true);
    setErrMsg(null);
    try {
      await createDiscussion({
        circleId,
        topic: topic.trim(),
        prompt: prompt.trim() || undefined,
        rounds,
        speakerMode,
      });
      setTopic(""); setPrompt(""); setRounds(1); setShowStart(false);
      refresh();
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 500, margin: 0, color: "var(--foreground)" }}>
          Team conversations
        </h3>
        <button style={btn(showStart ? undefined : "#22c55e")} onClick={() => setShowStart(!showStart)}>
          {showStart ? "Cancel" : "+ New discussion"}
        </button>
      </div>

      {errMsg && (
        <div style={{
          padding: "8px 12px", background: "color-mix(in oklch, #f87171 12%, transparent)",
          border: "1px solid #f87171", borderRadius: 5, fontSize: 12, color: "#f87171", marginBottom: 10,
        }}>{errMsg}</div>
      )}

      {showStart && (
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic — what does this circle need to discuss?"
            style={{ ...input, minHeight: 48, fontFamily: "inherit" }}
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Prompt for agents (optional — default: 'Share your view in 1-2 paragraphs')"
            style={{ ...input, minHeight: 36, fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Rounds:</label>
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} style={{ ...input, width: 70, marginBottom: 0 }}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>Mode:</label>
            <select value={speakerMode} onChange={(e) => setSpeakerMode(e.target.value as typeof speakerMode)} style={{ ...input, width: 180, marginBottom: 0 }}>
              <option value="reverse-priority">reverse-priority (Lead Link last)</option>
              <option value="roundtable">roundtable (alpha)</option>
              <option value="parallel">parallel (all at once)</option>
            </select>
            <button style={btn("#22c55e")} onClick={handleStart} disabled={busy || !topic.trim()}>Start</button>
          </div>
        </div>
      )}

      {loading && !data && (
        <div style={{ padding: 12, color: "var(--muted-foreground)", fontSize: 13 }}>Loading…</div>
      )}
      {error && (
        <div style={{ padding: 12, color: "#f87171", fontSize: 13 }}>Error: {error.message}</div>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {(["all", "turn", "commitment", "comment", "lifecycle"] as FeedKindFilter[]).map((k) => (
          <button key={k} style={btn(undefined, filter === k)} onClick={() => setFilter(k)}>
            {k === "all" ? "All" : k.charAt(0).toUpperCase() + k.slice(1) + "s"} ({counts[k]})
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted-foreground)" }}>
          live · refreshes every 5s
        </span>
      </div>

      {filtered.length === 0 && !loading && (
        <div style={{ color: "var(--muted-foreground)", fontSize: 13, padding: 24, textAlign: "center" }}>
          No messages yet. Start a discussion above.
        </div>
      )}

      {filtered.map((item) => (
        <FeedItemTile key={item.id} item={item} fmtTime={fmtTime} />
      ))}
    </div>
  );
}

function FeedItemTile({ item, fmtTime }: { item: FeedItem; fmtTime: (s: string) => string }) {
  const card: React.CSSProperties = {
    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8,
    padding: 12, marginBottom: 8,
  };
  const meta: React.CSSProperties = {
    fontSize: 11, color: "var(--muted-foreground)", marginBottom: 4,
  };
  const body: React.CSSProperties = {
    fontSize: 13, color: "var(--foreground)", whiteSpace: "pre-wrap", lineHeight: 1.4,
  };
  const badge = (color: string, label: string): React.CSSProperties => ({
    display: "inline-block", padding: "1px 7px", borderRadius: 9,
    background: `color-mix(in oklch, ${color} 18%, transparent)`,
    border: `1px solid ${color}`, color, fontSize: 10, fontWeight: 600,
    marginRight: 6, textTransform: "uppercase", letterSpacing: "0.04em",
  });

  if (item.kind === "turn") {
    const who = item.agentName ?? (item.agentId ? item.agentId.slice(0, 8) : "unknown");
    return (
      <div style={card}>
        <div style={meta}>
          <span style={badge("#22c55e", item.isSummary ? "summary" : `turn r${item.roundNumber}`)}/>
          <strong style={{ color: "var(--foreground)" }}>{who}</strong>
          {item.topic && <> · on "{item.topic.slice(0, 60)}{item.topic.length > 60 ? "…" : ""}"</>}
          {" · "}{fmtTime(item.at)}
          {" · "}{item.status}
        </div>
        <div style={body}>{item.content ?? "(no content yet)"}</div>
      </div>
    );
  }

  if (item.kind === "lifecycle") {
    const color = item.event === "opened" ? "#3b82f6" : "#a855f7";
    return (
      <div style={card}>
        <div style={meta}>
          <span style={badge(color, `discussion ${item.event}`)}/>
          <strong style={{ color: "var(--foreground)" }}>{item.topic}</strong>
          {" · "}{fmtTime(item.at)}
        </div>
        {item.event === "concluded" && item.conclusion && (
          <div style={body}>
            <em style={{ color: "var(--muted-foreground)" }}>
              Conclusion ({item.conclusionKind ?? "note"}):
            </em>{" "}
            {item.conclusion.slice(0, 500)}{item.conclusion.length > 500 ? "…" : ""}
          </div>
        )}
      </div>
    );
  }

  if (item.kind === "commitment") {
    const color =
      item.signal === "support" ? "#22c55e" :
      item.signal === "support-with-objection" ? "#f59e0b" :
      "#ef4444";
    return (
      <div style={card}>
        <div style={meta}>
          <span style={badge(color, item.signal)}/>
          <strong style={{ color: "var(--foreground)" }}>{item.agentName ?? item.agentId.slice(0, 8)}</strong>
          {" · "}{fmtTime(item.at)}
        </div>
        {item.reason && <div style={body}>{item.reason}</div>}
      </div>
    );
  }

  // comment
  const author = item.authorAgentName ?? item.authorAgentId?.slice(0, 8) ?? item.authorUserId ?? "unknown";
  return (
    <div style={card}>
      <div style={meta}>
        <span style={badge("#64748b", "comment")}/>
        <strong style={{ color: "var(--foreground)" }}>{author}</strong>
        {item.issueTitle && <> · on "{item.issueTitle.slice(0, 60)}{item.issueTitle.length > 60 ? "…" : ""}"</>}
        {" · "}{fmtTime(item.at)}
      </div>
      <div style={body}>{item.body}</div>
    </div>
  );
}
