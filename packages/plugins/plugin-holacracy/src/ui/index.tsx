import React, { useMemo, useState, useCallback, useRef } from "react";
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";

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
