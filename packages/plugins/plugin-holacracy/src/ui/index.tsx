import React, { useMemo } from "react";
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

const COLORS: Record<string, string> = {
  strategy: "#3b82f6",
  product: "#22c55e",
  growth: "#f59e0b",
  content: "#a855f7",
  default: "#6b7280",
};

function getColor(c: CircleWithRoles): string {
  if (c.color && COLORS[c.color]) return COLORS[c.color];
  const n = c.name.toLowerCase();
  for (const [k, v] of Object.entries(COLORS)) {
    if (k !== "default" && n.includes(k)) return v;
  }
  return COLORS.default;
}

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

function roleTypeDot(type: string): string {
  switch (type) {
    case "circle_lead": return "#f59e0b";
    case "facilitator": return "#3b82f6";
    case "secretary": return "#22c55e";
    case "circle_rep": return "#a855f7";
    default: return "#6b7280";
  }
}

function roleTypeLabel(type: string): string {
  switch (type) {
    case "circle_lead": return "Lead";
    case "facilitator": return "Facilitator";
    case "secretary": return "Secretary";
    case "circle_rep": return "Rep";
    default: return "";
  }
}

interface RenderedCircle {
  cx: number;
  cy: number;
  r: number;
  node: TreeNode;
  color: string;
}

interface RenderedRole {
  cx: number;
  cy: number;
  r: number;
  role: CircleWithRoles["roles"][0];
  circleColor: string;
}

function layoutTree(roots: TreeNode[]): { circles: RenderedCircle[]; roles: RenderedRole[] } {
  const allCircles: RenderedCircle[] = [];
  const allRoles: RenderedRole[] = [];

  function layoutNode(node: TreeNode, cx: number, cy: number, r: number) {
    const color = getColor(node.circle);
    allCircles.push({ cx, cy, r, node, color });

    const children = node.children;
    const roles = node.circle.roles;

    if (children.length === 0) {
      const roleR = Math.min(r * 0.22, 40);
      const count = roles.length;
      roles.forEach((role, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(count, 1);
        const dist = r * 0.55;
        allRoles.push({
          cx: cx + Math.cos(angle) * dist,
          cy: cy + Math.sin(angle) * dist,
          r: roleR,
          role,
          circleColor: color,
        });
      });
      return;
    }

    const childR = r * 0.42;
    const ringR = r * 0.48;
    const startAngle = -Math.PI / 2;

    children.forEach((child, i) => {
      const angle = startAngle + (2 * Math.PI * i) / children.length;
      const childCx = cx + Math.cos(angle) * ringR;
      const childCy = cy + Math.sin(angle) * ringR;
      layoutNode(child, childCx, childCy, childR);
    });

    const labelR = r * 0.18;
    const labelAngle = Math.PI * 0.75;
    const labelCx = cx + Math.cos(labelAngle) * (r - labelR - 10);
    const labelCy = cy + Math.sin(labelAngle) * (r - labelR - 10);

    const roleR = Math.min(labelR * 0.7, 32);
    roles.forEach((role, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(roles.length, 1);
      const dist = labelR * 1.8;
      const rx = labelCx + Math.cos(angle) * dist;
      const ry = labelCy + Math.sin(angle) * dist;
      if (Math.sqrt((rx - cx) ** 2 + (ry - cy) ** 2) + roleR < r - 5) {
        allRoles.push({ cx: rx, cy: ry, r: roleR, role, circleColor: color });
      }
    });
  }

  if (roots.length === 1) {
    layoutNode(roots[0], 500, 500, 480);
  } else {
    roots.forEach((root, i) => {
      const angle = (2 * Math.PI * i) / roots.length - Math.PI / 2;
      const cx = 500 + Math.cos(angle) * 250;
      const cy = 500 + Math.sin(angle) * 250;
      layoutNode(root, cx, cy, 200);
    });
  }

  return { circles: allCircles, roles: allRoles };
}

export function CircleNavigator() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;

  const { data, loading, error } = usePluginData<CircleWithRoles[]>("circles-tree", {
    companyId: companyId ?? "",
  });

  const tree = useMemo(() => (data ? buildTree(data) : []), [data]);
  const layout = useMemo(() => layoutTree(tree), [tree]);

  if (!companyId) {
    return <div style={{ padding: 32, color: "#9ca3af" }}>Select a company to view circles.</div>;
  }

  if (loading) {
    return <div style={{ padding: 32, color: "#9ca3af" }}>Loading circles...</div>;
  }

  if (error) {
    return <div style={{ padding: 32, color: "#ef4444" }}>Failed to load circles: {String(error)}</div>;
  }

  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: "center" }}>
        <p style={{ color: "#9ca3af", marginBottom: 8 }}>No circles configured yet.</p>
        <p style={{ color: "#6b7280", fontSize: 13 }}>Create circles via the API or agent tools.</p>
      </div>
    );
  }

  return (
    <div style={{ background: "#09090b", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #27272a" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "#fafafa", margin: 0 }}>Holacracy Circles</h2>
          <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 12 }}>
            {[["Lead", "#f59e0b"], ["Facilitator", "#3b82f6"], ["Secretary", "#22c55e"], ["Rep", "#a855f7"], ["Custom", "#6b7280"]].map(([label, color]) => (
              <span key={label} style={{ display: "flex", alignItems: "center", gap: 4, color: "#a1a1aa" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
                {label}
              </span>
            ))}
          </div>
        </div>
        <span style={{ color: "#71717a", fontSize: 13 }}>{data.length} circles</span>
      </div>

      <svg
        viewBox="0 -15 1000 1030"
        style={{ width: "100%", height: "calc(100vh - 240px)", minHeight: 500 }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {layout.circles.map((lc) => (
          <g key={lc.node.circle.id}>
            <circle
              cx={lc.cx}
              cy={lc.cy}
              r={lc.r}
              fill={lc.color + "10"}
              stroke={lc.color}
              strokeWidth={2}
              strokeOpacity={0.6}
            />
            <foreignObject
              x={lc.cx - lc.r * 0.4}
              y={lc.cy - lc.r + 8}
              width={lc.r * 0.8}
              height={lc.r * 0.3}
            >
              <div style={{
                color: lc.color,
                fontSize: Math.max(Math.min(lc.r * 0.08, 18), 11),
                fontWeight: 600,
                textAlign: "center",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {lc.node.circle.name}
              </div>
              {lc.node.circle.purpose && (
                <div style={{
                  color: "#71717a",
                  fontSize: Math.max(Math.min(lc.r * 0.05, 11), 8),
                  textAlign: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  marginTop: 2,
                }}>
                  {lc.node.circle.purpose}
                </div>
              )}
            </foreignObject>
          </g>
        ))}

        {layout.roles.map((lr) => (
          <g key={lr.role.id}>
            <circle
              cx={lr.cx}
              cy={lr.cy}
              r={lr.r}
              fill={roleTypeDot(lr.role.role_type) + "20"}
              stroke={roleTypeDot(lr.role.role_type)}
              strokeWidth={1.5}
              strokeOpacity={0.8}
            />
            <foreignObject
              x={lr.cx - lr.r + 4}
              y={lr.cy - lr.r + 4}
              width={(lr.r - 4) * 2}
              height={(lr.r - 4) * 2}
            >
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                textAlign: "center",
                overflow: "hidden",
              }}>
                <div style={{
                  color: "#fafafa",
                  fontSize: Math.max(Math.min(lr.r * 0.3, 11), 7),
                  fontWeight: 500,
                  lineHeight: 1.2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}>
                  {lr.role.name}
                </div>
                {lr.role.agent_name && (
                  <div style={{
                    color: "#a1a1aa",
                    fontSize: Math.max(Math.min(lr.r * 0.22, 9), 6),
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    width: "100%",
                  }}>
                    {lr.role.agent_name}
                  </div>
                )}
                <div style={{
                  color: "#71717a",
                  fontSize: Math.max(Math.min(lr.r * 0.2, 8), 5),
                  marginTop: 1,
                }}>
                  {roleTypeLabel(lr.role.role_type)}
                </div>
              </div>
            </foreignObject>
          </g>
        ))}
      </svg>
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
