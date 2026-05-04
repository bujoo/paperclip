import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import { CIRCLE_COLORS, PLUGIN_ID, ROLE_TYPES } from "../constants.js";

// ---------------------------------------------------------------------------
// Types matching the worker/DB schema
// ---------------------------------------------------------------------------

interface Circle {
  id: string;
  company_id: string;
  parent_circle_id: string | null;
  name: string;
  purpose: string | null;
  domains: string[];
  policies: string[];
  color: string | null;
}

interface Role {
  id: string;
  circle_id: string;
  name: string;
  purpose: string | null;
  role_type: string;
  domains: string[];
  accountabilities: string[];
  agent_name?: string;
  agent_id?: string;
}

interface CircleDetail {
  circle: Circle;
  roles: Role[];
  subCircles: Circle[];
  tensions: Array<{
    id: string;
    circle_id: string;
    title: string;
    description: string | null;
    tension_type: string;
    status: string;
  }>;
}

interface CircleTreeNode {
  circle: Circle;
  children: CircleTreeNode[];
  roles: Role[];
}

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

function getCircleColor(circle: Circle): string {
  if (circle.color && CIRCLE_COLORS[circle.color]) return CIRCLE_COLORS[circle.color];
  if (circle.color && circle.color.startsWith("#")) return circle.color;
  const name = circle.name.toLowerCase();
  for (const [key, value] of Object.entries(CIRCLE_COLORS)) {
    if (key !== "default" && name.includes(key)) return value;
  }
  return CIRCLE_COLORS.default;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getRoleTypeLabel(roleType: string): string {
  switch (roleType) {
    case ROLE_TYPES.circleLead: return "Circle Lead";
    case ROLE_TYPES.facilitator: return "Facilitator";
    case ROLE_TYPES.secretary: return "Secretary";
    case ROLE_TYPES.circleRep: return "Circle Rep";
    default: return "Custom Role";
  }
}

function getRoleTypeColor(roleType: string): string {
  switch (roleType) {
    case ROLE_TYPES.circleLead: return "#f59e0b";
    case ROLE_TYPES.facilitator: return "#3b82f6";
    case ROLE_TYPES.secretary: return "#22c55e";
    case ROLE_TYPES.circleRep: return "#a855f7";
    default: return "#6b7280";
  }
}

// ---------------------------------------------------------------------------
// API fetch helper
// ---------------------------------------------------------------------------

const API_BASE = `/api/plugins/${PLUGIN_ID}/api`;

async function fetchCircles(companyId: string): Promise<Circle[]> {
  const res = await fetch(`${API_BASE}/circles?companyId=${encodeURIComponent(companyId)}`);
  if (!res.ok) throw new Error(`Failed to fetch circles: ${res.status}`);
  return res.json();
}

async function fetchCircleDetail(circleId: string): Promise<CircleDetail> {
  const res = await fetch(`${API_BASE}/circles/${encodeURIComponent(circleId)}`);
  if (!res.ok) throw new Error(`Failed to fetch circle detail: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Build circle tree from flat list
// ---------------------------------------------------------------------------

function buildCircleTree(circles: Circle[], detailsMap: Map<string, CircleDetail>): CircleTreeNode[] {
  const nodeMap = new Map<string, CircleTreeNode>();
  for (const c of circles) {
    const detail = detailsMap.get(c.id);
    nodeMap.set(c.id, { circle: c, children: [], roles: detail?.roles ?? [] });
  }
  const roots: CircleTreeNode[] = [];
  for (const c of circles) {
    const node = nodeMap.get(c.id)!;
    if (c.parent_circle_id && nodeMap.has(c.parent_circle_id)) {
      nodeMap.get(c.parent_circle_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Geometry: layout nested concentric circles in SVG
// ---------------------------------------------------------------------------

interface LayoutCircle {
  cx: number;
  cy: number;
  radius: number;
  node: CircleTreeNode;
  depth: number;
}

interface LayoutRole {
  x: number;
  y: number;
  role: Role;
  circleColor: string;
  circleId: string;
}

interface Layout {
  circles: LayoutCircle[];
  roles: LayoutRole[];
  width: number;
  height: number;
}

function layoutCircleTree(
  roots: CircleTreeNode[],
  focusCircleId: string | null,
): Layout {
  const layoutCircles: LayoutCircle[] = [];
  const layoutRoles: LayoutRole[] = [];

  // If we have a focus, find that subtree
  let treesToRender = roots;
  if (focusCircleId) {
    const findNode = (nodes: CircleTreeNode[]): CircleTreeNode | null => {
      for (const n of nodes) {
        if (n.circle.id === focusCircleId) return n;
        const found = findNode(n.children);
        if (found) return found;
      }
      return null;
    };
    const focused = findNode(roots);
    if (focused) treesToRender = [focused];
  }

  const ROLE_CARD_W = 90;
  const ROLE_CARD_H = 36;

  function computeRadius(node: CircleTreeNode): number {
    const roleCount = node.roles.length;
    const childCount = node.children.length;

    if (childCount === 0) {
      // Leaf circle: size based on roles
      const circumNeeded = Math.max(roleCount, 3) * (ROLE_CARD_W + 12);
      return Math.max(circumNeeded / (2 * Math.PI), 60);
    }

    // Has children: compute child radii first, then pack them inside
    const childRadii = node.children.map(c => computeRadius(c));
    const totalChildDiam = childRadii.reduce((s, r) => s + r * 2 + 20, 0);
    const childRingRadius = Math.max(totalChildDiam / (2 * Math.PI), 80);

    // Also consider own roles
    const ownRoleCount = node.roles.length;
    const roleRingRadius = Math.max(ownRoleCount, 3) * (ROLE_CARD_W + 12) / (2 * Math.PI);

    const maxChildR = Math.max(...childRadii, 0);
    return Math.max(childRingRadius + maxChildR + 30, roleRingRadius + 30, 100);
  }

  function layoutNode(
    node: CircleTreeNode,
    cx: number,
    cy: number,
    depth: number,
  ) {
    const radius = computeRadius(node);
    layoutCircles.push({ cx, cy, radius, node, depth });

    const circleColor = getCircleColor(node.circle);

    // Place roles along the outer ring of this circle
    const roles = [...node.roles];
    // Sort: Circle Lead first (top position)
    roles.sort((a, b) => {
      if (a.role_type === ROLE_TYPES.circleLead) return -1;
      if (b.role_type === ROLE_TYPES.circleLead) return 1;
      const order = [ROLE_TYPES.facilitator, ROLE_TYPES.secretary, ROLE_TYPES.circleRep, ROLE_TYPES.custom];
      return order.indexOf(a.role_type as any) - order.indexOf(b.role_type as any);
    });

    const roleRingR = radius - 28;
    roles.forEach((role, i) => {
      // Start from top (-PI/2), distribute evenly
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(roles.length, 1);
      layoutRoles.push({
        x: cx + roleRingR * Math.cos(angle),
        y: cy + roleRingR * Math.sin(angle),
        role,
        circleColor,
        circleId: node.circle.id,
      });
    });

    // Place child circles inside, arranged in a smaller ring
    if (node.children.length > 0) {
      const childRadii = node.children.map(c => computeRadius(c));
      const maxChildR = Math.max(...childRadii, 0);
      const innerRingR = Math.max(radius - maxChildR - 40, 0);

      node.children.forEach((child, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / node.children.length;
        const childCx = cx + innerRingR * Math.cos(angle);
        const childCy = cy + innerRingR * Math.sin(angle);
        layoutNode(child, childCx, childCy, depth + 1);
      });
    }
  }

  // Layout each root tree
  if (treesToRender.length === 1) {
    layoutNode(treesToRender[0], 0, 0, 0);
  } else {
    // Multiple roots: arrange them in a row
    let xOffset = 0;
    for (const root of treesToRender) {
      const r = computeRadius(root);
      layoutNode(root, xOffset + r + 20, 0, 0);
      xOffset += r * 2 + 60;
    }
  }

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lc of layoutCircles) {
    minX = Math.min(minX, lc.cx - lc.radius);
    minY = Math.min(minY, lc.cy - lc.radius);
    maxX = Math.max(maxX, lc.cx + lc.radius);
    maxY = Math.max(maxY, lc.cy + lc.radius);
  }

  const pad = 60;
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;

  // Shift everything so min is at pad
  const dx = -minX + pad;
  const dy = -minY + pad;
  for (const lc of layoutCircles) { lc.cx += dx; lc.cy += dy; }
  for (const lr of layoutRoles) { lr.x += dx; lr.y += dy; }

  return {
    circles: layoutCircles,
    roles: layoutRoles,
    width: Math.max(width, 400),
    height: Math.max(height, 400),
  };
}

// ---------------------------------------------------------------------------
// SVG Role Card component
// ---------------------------------------------------------------------------

interface RoleCardProps {
  lr: LayoutRole;
  isSelected: boolean;
  onSelect: (role: Role) => void;
}

function RoleCard({ lr, isSelected, onSelect }: RoleCardProps) {
  const w = 90;
  const h = 36;
  const isLead = lr.role.role_type === ROLE_TYPES.circleLead;
  const typeColor = getRoleTypeColor(lr.role.role_type);

  return (
    <g
      transform={`translate(${lr.x - w / 2}, ${lr.y - h / 2})`}
      style={{ cursor: "pointer" }}
      onClick={(e) => { e.stopPropagation(); onSelect(lr.role); }}
    >
      <rect
        width={w}
        height={h}
        rx={6}
        fill={isSelected ? hexToRgba(typeColor, 0.25) : "rgba(24, 24, 27, 0.9)"}
        stroke={isSelected ? typeColor : hexToRgba(lr.circleColor, 0.6)}
        strokeWidth={isSelected ? 2 : 1}
      />
      {/* Role type indicator dot */}
      <circle cx={10} cy={h / 2} r={3.5} fill={typeColor} />
      {/* Role name */}
      <text
        x={18}
        y={h / 2 - 3}
        fill="#fafafa"
        fontSize={isLead ? 9.5 : 9}
        fontWeight={isLead ? 600 : 400}
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {lr.role.name.length > 11 ? lr.role.name.slice(0, 10) + ".." : lr.role.name}
      </text>
      {/* Agent name */}
      <text
        x={18}
        y={h / 2 + 9}
        fill="#71717a"
        fontSize={7.5}
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {lr.role.agent_name
          ? (lr.role.agent_name.length > 12 ? lr.role.agent_name.slice(0, 11) + ".." : lr.role.agent_name)
          : "unassigned"}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// SVG Circle Ring component
// ---------------------------------------------------------------------------

interface CircleRingProps {
  lc: LayoutCircle;
  onZoom: (circleId: string) => void;
}

function CircleRing({ lc, onZoom }: CircleRingProps) {
  const color = getCircleColor(lc.node.circle);
  const isRoot = lc.depth === 0;
  const dashArray = isRoot ? undefined : "6 3";

  return (
    <g>
      {/* Circle ring */}
      <circle
        cx={lc.cx}
        cy={lc.cy}
        r={lc.radius}
        fill={hexToRgba(color, 0.04)}
        stroke={hexToRgba(color, isRoot ? 0.5 : 0.3)}
        strokeWidth={isRoot ? 2 : 1.5}
        strokeDasharray={dashArray}
        style={{ cursor: "pointer" }}
        onClick={() => onZoom(lc.node.circle.id)}
      />
      {/* Circle name label at the bottom of the ring */}
      <text
        x={lc.cx}
        y={lc.cy + lc.radius + 16}
        textAnchor="middle"
        fill={color}
        fontSize={isRoot ? 13 : 11}
        fontWeight={600}
        fontFamily="system-ui, -apple-system, sans-serif"
        style={{ cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.05em" }}
        onClick={() => onZoom(lc.node.circle.id)}
      >
        {lc.node.circle.name}
      </text>
      {/* Purpose as secondary label */}
      {lc.node.circle.purpose && isRoot && (
        <text
          x={lc.cx}
          y={lc.cy + lc.radius + 30}
          textAnchor="middle"
          fill="#71717a"
          fontSize={9}
          fontFamily="system-ui, -apple-system, sans-serif"
        >
          {lc.node.circle.purpose.length > 50
            ? lc.node.circle.purpose.slice(0, 47) + "..."
            : lc.node.circle.purpose}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Role Detail Tooltip
// ---------------------------------------------------------------------------

interface RoleTooltipProps {
  role: Role;
  x: number;
  y: number;
  onClose: () => void;
}

function RoleTooltip({ role, x, y, onClose }: RoleTooltipProps) {
  const typeColor = getRoleTypeColor(role.role_type);
  const accountabilities = Array.isArray(role.accountabilities) ? role.accountabilities : [];
  const domains = Array.isArray(role.domains) ? role.domains : [];
  const tooltipW = 260;
  const lineH = 16;
  const headerH = 52;
  const accH = accountabilities.length > 0 ? 20 + accountabilities.length * lineH : 0;
  const domH = domains.length > 0 ? 20 + domains.length * lineH : 0;
  const agentH = 20;
  const purposeH = role.purpose ? 32 : 0;
  const totalH = headerH + purposeH + accH + domH + agentH + 16;

  // Adjust position so tooltip doesn't go off-screen
  const tx = x + tooltipW / 2;
  const ty = y - totalH - 10;

  return (
    <g>
      {/* Backdrop to catch clicks for closing */}
      <rect
        x={-10000}
        y={-10000}
        width={20000}
        height={20000}
        fill="transparent"
        onClick={onClose}
      />
      <g transform={`translate(${tx - tooltipW / 2}, ${ty})`}>
        {/* Tooltip background */}
        <rect
          width={tooltipW}
          height={totalH}
          rx={8}
          fill="#18181b"
          stroke="#3f3f46"
          strokeWidth={1}
          filter="drop-shadow(0 4px 12px rgba(0,0,0,0.5))"
        />
        {/* Header */}
        <rect width={tooltipW} height={4} rx={2} fill={typeColor} y={0} />
        <text x={12} y={24} fill="#fafafa" fontSize={13} fontWeight={600} fontFamily="system-ui, sans-serif">
          {role.name}
        </text>
        <text x={12} y={40} fill={typeColor} fontSize={10} fontFamily="system-ui, sans-serif">
          {getRoleTypeLabel(role.role_type)}
        </text>

        {/* Purpose */}
        {role.purpose && (
          <text x={12} y={headerH + 14} fill="#a1a1aa" fontSize={10} fontFamily="system-ui, sans-serif">
            {role.purpose.length > 40 ? role.purpose.slice(0, 37) + "..." : role.purpose}
          </text>
        )}

        {/* Agent */}
        <text x={12} y={headerH + purposeH + 14} fill="#71717a" fontSize={9} fontFamily="system-ui, sans-serif">
          {role.agent_name ? `Filled by: ${role.agent_name}` : "Not yet assigned"}
        </text>

        {/* Accountabilities */}
        {accountabilities.length > 0 && (
          <g transform={`translate(0, ${headerH + purposeH + agentH})`}>
            <text x={12} y={14} fill="#a1a1aa" fontSize={9} fontWeight={600} fontFamily="system-ui, sans-serif">
              ACCOUNTABILITIES
            </text>
            {accountabilities.slice(0, 5).map((acc: string, i: number) => (
              <text key={i} x={20} y={28 + i * lineH} fill="#d4d4d8" fontSize={9} fontFamily="system-ui, sans-serif">
                {typeof acc === "string" ? (acc.length > 35 ? acc.slice(0, 32) + "..." : acc) : String(acc)}
              </text>
            ))}
          </g>
        )}

        {/* Domains */}
        {domains.length > 0 && (
          <g transform={`translate(0, ${headerH + purposeH + agentH + accH})`}>
            <text x={12} y={14} fill="#a1a1aa" fontSize={9} fontWeight={600} fontFamily="system-ui, sans-serif">
              DOMAINS
            </text>
            {domains.slice(0, 5).map((dom: string, i: number) => (
              <text key={i} x={20} y={28 + i * lineH} fill="#d4d4d8" fontSize={9} fontFamily="system-ui, sans-serif">
                {typeof dom === "string" ? (dom.length > 35 ? dom.slice(0, 32) + "..." : dom) : String(dom)}
              </text>
            ))}
          </g>
        )}
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Pan/Zoom hook
// ---------------------------------------------------------------------------

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

function usePanZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform(prev => {
      const newScale = Math.max(0.2, Math.min(3, prev.scale * delta));
      // Zoom towards mouse position
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { ...prev, scale: newScale };
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      return {
        x: mx - (mx - prev.x) * (newScale / prev.scale),
        y: my - (my - prev.y) * (newScale / prev.scale),
        scale: newScale,
      };
    });
  }, [containerRef]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only pan on middle click or left click on the background
    if (e.button === 1 || (e.button === 0 && (e.target as HTMLElement).tagName === "svg")) {
      isPanning.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setTransform(prev => ({
      ...prev,
      x: prev.x + dx,
      y: prev.y + dy,
    }));
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [containerRef, handleWheel]);

  const resetView = useCallback(() => {
    setTransform({ x: 0, y: 0, scale: 1 });
  }, []);

  return { transform, handleMouseDown, handleMouseMove, handleMouseUp, resetView, setTransform };
}

// ---------------------------------------------------------------------------
// Main CircleNavigator component
// ---------------------------------------------------------------------------

export function CircleNavigator() {
  const hostCtx = useHostContext();
  const companyId = hostCtx.companyId;

  const [circles, setCircles] = useState<Circle[]>([]);
  const [detailsMap, setDetailsMap] = useState<Map<string, CircleDetail>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusCircleId, setFocusCircleId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const { transform, handleMouseDown, handleMouseMove, handleMouseUp, resetView, setTransform } = usePanZoom(containerRef);

  // Fetch circles and their details
  useEffect(() => {
    if (!companyId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const allCircles = await fetchCircles(companyId!);
        if (cancelled) return;
        setCircles(allCircles);

        // Fetch details for each circle (roles, sub-circles, tensions)
        const details = new Map<string, CircleDetail>();
        await Promise.all(
          allCircles.map(async (c) => {
            try {
              const d = await fetchCircleDetail(c.id);
              details.set(c.id, d);
            } catch {
              // Skip circles that fail to load detail
            }
          }),
        );
        if (cancelled) return;
        setDetailsMap(details);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [companyId]);

  // Build the tree and layout
  const layout = useMemo(() => {
    if (circles.length === 0) return null;
    const roots = buildCircleTree(circles, detailsMap);
    return layoutCircleTree(roots, focusCircleId);
  }, [circles, detailsMap, focusCircleId]);

  // Auto-fit the view when layout changes
  useEffect(() => {
    if (!layout || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const scaleX = rect.width / layout.width;
    const scaleY = rect.height / layout.height;
    const scale = Math.min(scaleX, scaleY, 1.2) * 0.85;
    const x = (rect.width - layout.width * scale) / 2;
    const y = (rect.height - layout.height * scale) / 2;
    setTransform({ x, y, scale });
  }, [layout, setTransform]);

  // Find role position for tooltip
  const selectedRoleLayout = useMemo(() => {
    if (!selectedRole || !layout) return null;
    return layout.roles.find(lr => lr.role.id === selectedRole.id) ?? null;
  }, [selectedRole, layout]);

  const handleZoomToCircle = useCallback((circleId: string) => {
    if (focusCircleId === circleId) {
      // Already focused, zoom out
      setFocusCircleId(null);
    } else {
      setFocusCircleId(circleId);
    }
    setSelectedRole(null);
  }, [focusCircleId]);

  const handleSelectRole = useCallback((role: Role) => {
    setSelectedRole(prev => prev?.id === role.id ? null : role);
  }, []);

  // Breadcrumb path for focused circle
  const breadcrumbs = useMemo(() => {
    if (!focusCircleId) return [];
    const path: Circle[] = [];
    let currentId: string | null = focusCircleId;
    while (currentId) {
      const circle = circles.find(c => c.id === currentId);
      if (!circle) break;
      path.unshift(circle);
      currentId = circle.parent_circle_id;
    }
    return path;
  }, [focusCircleId, circles]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!companyId) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <p style={styles.emptyText}>Select a company to view Holacracy circles.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <div style={styles.spinner} />
          <p style={styles.emptyText}>Loading circles...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <p style={{ ...styles.emptyText, color: "#ef4444" }}>Error: {error}</p>
        </div>
      </div>
    );
  }

  if (!layout || circles.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <svg width={64} height={64} viewBox="0 0 64 64" fill="none" style={{ marginBottom: 16 }}>
            <circle cx={32} cy={32} r={28} stroke="#3f3f46" strokeWidth={2} strokeDasharray="4 3" />
            <circle cx={32} cy={32} r={16} stroke="#3f3f46" strokeWidth={1.5} strokeDasharray="4 3" />
            <circle cx={32} cy={32} r={4} fill="#3f3f46" />
          </svg>
          <p style={{ ...styles.emptyText, fontSize: 15, fontWeight: 500, color: "#d4d4d8" }}>
            No Holacracy circles yet
          </p>
          <p style={styles.emptyText}>
            Create circles via the API to see them visualized here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header bar */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <h2 style={styles.title}>Holacracy Circles</h2>
          {breadcrumbs.length > 0 && (
            <div style={styles.breadcrumbs}>
              <span
                style={styles.breadcrumbLink}
                onClick={() => setFocusCircleId(null)}
              >
                All
              </span>
              {breadcrumbs.map((c, i) => (
                <React.Fragment key={c.id}>
                  <span style={styles.breadcrumbSep}>/</span>
                  <span
                    style={{
                      ...styles.breadcrumbLink,
                      color: i === breadcrumbs.length - 1 ? getCircleColor(c) : "#a1a1aa",
                    }}
                    onClick={() => setFocusCircleId(c.id)}
                  >
                    {c.name}
                  </span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
        <div style={styles.headerRight}>
          <span style={styles.circleCount}>{circles.length} circle{circles.length !== 1 ? "s" : ""}</span>
          <button style={styles.resetBtn} onClick={() => { setFocusCircleId(null); resetView(); }} title="Reset view">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M3 12a9 9 0 1 1 3 6.5" />
              <polyline points="3 22 3 16 9 16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Legend */}
      <div style={styles.legend}>
        {[
          { label: "Lead", color: getRoleTypeColor(ROLE_TYPES.circleLead) },
          { label: "Facilitator", color: getRoleTypeColor(ROLE_TYPES.facilitator) },
          { label: "Secretary", color: getRoleTypeColor(ROLE_TYPES.secretary) },
          { label: "Rep", color: getRoleTypeColor(ROLE_TYPES.circleRep) },
          { label: "Custom", color: getRoleTypeColor(ROLE_TYPES.custom) },
        ].map(item => (
          <div key={item.label} style={styles.legendItem}>
            <span style={{ ...styles.legendDot, backgroundColor: item.color }} />
            <span style={styles.legendLabel}>{item.label}</span>
          </div>
        ))}
      </div>

      {/* SVG Canvas */}
      <div
        ref={containerRef}
        style={styles.canvas}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          width="100%"
          height="100%"
          style={{ display: "block" }}
        >
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
            {/* Render circle rings (back to front by depth, deepest first) */}
            {[...layout.circles]
              .sort((a, b) => a.depth - b.depth)
              .map(lc => (
                <CircleRing
                  key={lc.node.circle.id}
                  lc={lc}
                  onZoom={handleZoomToCircle}
                />
              ))}

            {/* Render role cards */}
            {layout.roles.map(lr => (
              <RoleCard
                key={lr.role.id}
                lr={lr}
                isSelected={selectedRole?.id === lr.role.id}
                onSelect={handleSelectRole}
              />
            ))}

            {/* Role tooltip */}
            {selectedRole && selectedRoleLayout && (
              <RoleTooltip
                role={selectedRole}
                x={selectedRoleLayout.x}
                y={selectedRoleLayout.y}
                onClose={() => setSelectedRole(null)}
              />
            )}
          </g>
        </svg>
      </div>

      {/* Controls hint */}
      <div style={styles.controlsHint}>
        Scroll to zoom -- Drag SVG background to pan -- Click circle ring to focus -- Click role card for details
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 500,
    backgroundColor: "#18181b",
    color: "#fafafa",
    fontFamily: "system-ui, -apple-system, sans-serif",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    borderBottom: "1px solid #27272a",
    flexShrink: 0,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
    color: "#fafafa",
  },
  breadcrumbs: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 12,
  },
  breadcrumbLink: {
    color: "#a1a1aa",
    cursor: "pointer",
    padding: "2px 4px",
    borderRadius: 3,
  },
  breadcrumbSep: {
    color: "#52525b",
  },
  circleCount: {
    fontSize: 12,
    color: "#71717a",
  },
  resetBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: 6,
    border: "1px solid #3f3f46",
    backgroundColor: "transparent",
    color: "#a1a1aa",
    cursor: "pointer",
    padding: 0,
  },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "6px 20px",
    borderBottom: "1px solid #27272a",
    flexShrink: 0,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
  },
  legendLabel: {
    fontSize: 11,
    color: "#a1a1aa",
  },
  canvas: {
    flex: 1,
    overflow: "hidden",
    cursor: "grab",
    position: "relative",
    backgroundColor: "#09090b",
  },
  controlsHint: {
    padding: "6px 20px",
    fontSize: 11,
    color: "#52525b",
    borderTop: "1px solid #27272a",
    textAlign: "center" as const,
    flexShrink: 0,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    minHeight: 400,
    gap: 8,
  },
  emptyText: {
    color: "#71717a",
    fontSize: 13,
    margin: 0,
  },
  spinner: {
    width: 24,
    height: 24,
    border: "2px solid #3f3f46",
    borderTopColor: "#a1a1aa",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
};

// ---------------------------------------------------------------------------
// Other exported components (unchanged placeholders)
// ---------------------------------------------------------------------------

export function HolacracySidebar() {
  return (
    <div style={{ padding: "8px 12px", fontSize: 13, color: "#9ca3af" }}>
      Circles
    </div>
  );
}

export function AgentRoleTab() {
  return (
    <div style={{ padding: 16 }}>
      <p style={{ color: "#9ca3af" }}>Holacracy role details will appear here.</p>
    </div>
  );
}

export function CircleDetailTab() {
  return (
    <div style={{ padding: 16 }}>
      <p style={{ color: "#9ca3af" }}>Circle governance and roles will appear here.</p>
    </div>
  );
}

export function CircleHealthWidget() {
  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Circle Health</h3>
      <p style={{ color: "#9ca3af", fontSize: 13 }}>No circles configured yet.</p>
    </div>
  );
}

export function HolacracySettings() {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Holacracy Settings</h2>
      <p style={{ color: "#9ca3af" }}>Configure circle structure and governance rules.</p>
    </div>
  );
}
