import React from "react";

export function CircleNavigator() {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Holacracy Circles</h2>
      <p style={{ color: "#9ca3af" }}>
        Circle visualization coming in Phase 4. Use the API to manage circles and roles.
      </p>
    </div>
  );
}

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
