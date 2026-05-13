import React, { useMemo, useState, useCallback, useRef } from "react";
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";

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
const TEXT_DARK = "#2c3e50";
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ role: CircleWithRoles["roles"][0]; x: number; y: number } | null>(null);
  const [hoveredCircle, setHoveredCircle] = useState<string | null>(null);

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

  const breadcrumb = useMemo(() => buildBreadcrumb(tree, focusedId), [tree, focusedId]);
  const layout = useMemo(() => (rootNode ? computeLayout(rootNode) : null), [rootNode]);

  const handleCircleClick = useCallback((e: React.MouseEvent, circleId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setTooltip(null);
    if (rootNode && circleId === rootNode.circle.id) return;
    const node = findNode(tree, circleId);
    if (node && node.children.length > 0) {
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

  if (!companyId) return <div style={{ padding: 32, color: "#888" }}>Select a company to view circles.</div>;
  if (loading) return <div style={{ padding: 32, color: "#888" }}>Loading circles...</div>;
  if (error) return <div style={{ padding: 32, color: "#c00" }}>Failed to load circles: {String(error)}</div>;
  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: "center" }}>
        <p style={{ color: "#888", marginBottom: 8 }}>No circles configured yet.</p>
        <p style={{ color: "#aaa", fontSize: 13 }}>Create circles via the API or agent tools.</p>
      </div>
    );
  }
  if (!layout) return null;

  return (
    <div style={{ background: "#fff", borderRadius: 8, overflow: "hidden" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 16px", borderBottom: "1px solid #e5e7eb",
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
                  <span style={{ color: "#ccc", margin: "0 2px" }}>/</span>
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
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "#999" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: ROLE_GREEN, display: "inline-block" }} />
            Assigned
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{
              width: 10, height: 10, borderRadius: "50%", background: "#fff",
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
                  cursor: lc.node.children.length > 0 && lc.node.circle.id !== rootNode?.circle.id ? "pointer" : "default",
                  opacity: hoveredCircle === lc.node.circle.id ? 0.85 : 1,
                  transition: "opacity 0.15s",
                }}
                onClick={(e) => handleCircleClick(e, lc.node.circle.id)}
                onMouseEnter={() => lc.node.children.length > 0 && setHoveredCircle(lc.node.circle.id)}
                onMouseLeave={() => setHoveredCircle(null)}
              />
            ))}

          {layout.roles.map((lr, ri) => (
            <g key={`r-${ri}-${lr.role.id}`} style={{ cursor: "pointer" }} onClick={(e) => handleRoleClick(e, lr.role)}>
              <circle
                cx={lr.cx} cy={lr.cy} r={lr.r}
                fill={lr.filled ? ROLE_GREEN : "#ffffff"}
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
              background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
              padding: "12px 16px", boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              zIndex: 10, maxWidth: 260, minWidth: 160,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, color: TEXT_DARK, marginBottom: 4, fontSize: 14 }}>
              {tooltip.role.name}
            </div>
            {tooltip.role.purpose && (
              <div style={{ fontSize: 12, color: "#666", marginBottom: 6, lineHeight: 1.4 }}>
                {tooltip.role.purpose}
              </div>
            )}
            <div style={{ fontSize: 11, color: "#999", display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{
                background: tooltip.role.agent_name ? "#e8f5e9" : "#fff3e0",
                color: tooltip.role.agent_name ? "#2e7d32" : "#e65100",
                padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 500,
              }}>
                {roleTypeLabel(tooltip.role.role_type)}
              </span>
              {tooltip.role.agent_name
                ? <span style={{ color: "#666" }}>{tooltip.role.agent_name}</span>
                : <span style={{ color: "#e65100", fontStyle: "italic" }}>Unassigned</span>
              }
            </div>
            <button
              onClick={() => setTooltip(null)}
              style={{
                position: "absolute", top: 6, right: 8, background: "none", border: "none",
                cursor: "pointer", fontSize: 14, color: "#bbb", lineHeight: 1,
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
  return <div style={{ padding: "8px 12px", fontSize: 13, color: "#9ca3af" }}>Circles</div>;
}

export function AgentRoleTab() {
  return <div style={{ padding: 16 }}><p style={{ color: "#9ca3af" }}>Holacracy role details will appear here.</p></div>;
}

export function CircleDetailTab() {
  return <div style={{ padding: 16 }}><p style={{ color: "#9ca3af" }}>Circle governance and roles will appear here.</p></div>;
}

export function CircleHealthWidget() {
  return <div style={{ padding: 16 }}><h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Circle Health</h3><p style={{ color: "#9ca3af", fontSize: 13 }}>No circles configured yet.</p></div>;
}

export function HolacracySettings() {
  return <div style={{ padding: 24 }}><h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Holacracy Settings</h2><p style={{ color: "#9ca3af" }}>Configure circle structure and governance rules.</p></div>;
}
