import React, { useState } from "react";
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";

interface DocSummary {
  id: string;
  title: string | null;
  format: string;
  revision: number;
  created_at: string;
  updated_at: string;
  body_preview: string;
  author_name: string | null;
  issue_identifier: string | null;
  issue_title: string | null;
  project_name: string | null;
}

interface DocDetail {
  id: string;
  title: string | null;
  format: string;
  latest_body: string;
  latest_revision_number: number;
  created_at: string;
  updated_at: string;
  author_name: string | null;
  issue_identifier: string | null;
  issue_title: string | null;
  issue_id: string | null;
  project_name: string | null;
}

export function DocsPage() {
  const hostCtx = useHostContext();
  const companyId = hostCtx?.companyId ?? null;
  const [search, setSearch] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);

  const { data: docs, loading } = usePluginData<DocSummary[]>("documents-list", {
    companyId: companyId ?? "",
    search,
    limit: 50,
  });

  const { data: detail } = usePluginData<DocDetail | null>("document-detail", {
    documentId: selectedDoc ?? "",
  });

  if (!companyId) return <div style={{ padding: 32, color: "var(--muted-foreground)" }}>Select a company.</div>;

  return (
    <div style={{ display: "flex", gap: 0, height: "100%" }}>
      <div style={{ width: selectedDoc ? 360 : "100%", flexShrink: 0, display: "flex", flexDirection: "column" as const }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <input
            type="text"
            placeholder="Search documents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%", padding: "8px 12px", fontSize: 14,
              border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--background)", color: "var(--foreground)",
              outline: "none",
            }}
          />
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {loading && <div style={{ padding: 16, color: "var(--muted-foreground)" }}>Loading...</div>}
          {docs && docs.length === 0 && <div style={{ padding: 16, color: "var(--muted-foreground)" }}>No documents found.</div>}
          {docs && docs.map((doc) => (
            <div
              key={doc.id}
              onClick={() => setSelectedDoc(selectedDoc === doc.id ? null : doc.id)}
              style={{
                padding: "12px 16px", borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                background: selectedDoc === doc.id ? "var(--accent)" : "transparent",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>
                  {doc.title || doc.issue_identifier || "Untitled"}
                </span>
                <span style={{ fontSize: 11, color: "var(--muted-foreground)", whiteSpace: "nowrap", marginLeft: 8 }}>
                  rev {doc.revision}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--muted-foreground)" }}>
                {doc.author_name && <span>{doc.author_name}</span>}
                {doc.project_name && <span style={{ padding: "1px 6px", borderRadius: 3, background: "var(--muted)", fontSize: 11 }}>{doc.project_name}</span>}
                {doc.issue_identifier && <span>{doc.issue_identifier}</span>}
                <span>{new Date(doc.updated_at).toLocaleDateString()}</span>
              </div>
              {!selectedDoc && doc.body_preview && (
                <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4, lineHeight: 1.4, overflow: "hidden", maxHeight: 40 }}>
                  {doc.body_preview.replace(/[#*_\[\]]/g, "").slice(0, 120)}...
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {selectedDoc && detail && (
        <div style={{ flex: 1, borderLeft: "1px solid var(--border)", overflow: "auto", padding: "20px 24px" }}>
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
              {detail.title || "Untitled"}
            </h2>
            <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
              {detail.author_name && <span>by {detail.author_name}</span>}
              {detail.project_name && <span>{detail.project_name}</span>}
              {detail.issue_identifier && (
                <a
                  href={`/CH/issues/${detail.issue_identifier}`}
                  style={{ color: "#60afd8", textDecoration: "none" }}
                >{detail.issue_identifier}: {detail.issue_title}</a>
              )}
              <span>Rev {detail.latest_revision_number}</span>
              <span>{new Date(detail.updated_at).toLocaleString()}</span>
            </div>
          </div>
          <div style={{
            fontSize: 14, lineHeight: 1.7, color: "var(--foreground)",
            whiteSpace: "pre-wrap", fontFamily: "system-ui, -apple-system, sans-serif",
          }}>
            {detail.latest_body}
          </div>
        </div>
      )}
    </div>
  );
}

export function DocsSidebar() {
  const path = "/CH/plugins/paperclipai.plugin-docs";
  return (
    <a href={path} onClick={(e) => { e.preventDefault(); window.history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
      fontSize: 13, fontWeight: 500, color: "var(--foreground)", opacity: 0.8,
      textDecoration: "none", borderRadius: 4,
    }}>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
        <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
        <path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>
      </svg>
      <span>Docs</span>
    </a>
  );
}
