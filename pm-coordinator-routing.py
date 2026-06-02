#!/usr/bin/env python3
"""PM Coordinator routing table and decision logic."""

import os
import requests
import json
from typing import Optional, Tuple

# Agent circle mappings (agent_id: agent_name)
CIRCLE_AGENTS = {
    "e1f66962-dc3c-4a8e-9875-de1a1dee2839": "Dev Lead",
    "9adc6c20-de6e-4f0a-83de-ebe8a380f5d0": "Product Manager",
    "aec05dae-7af7-4323-a21e-00040fbc766a": "Strategist",
    "d3715d54-6c06-4535-abe4-e51523968f38": "Workflow Architect",
    "1243032c-c03f-4fe7-8b5d-4eb3a77e84db": "Doc Lead",
    "89c526a5-f886-4bf7-bc0a-fc32f1b00b9e": "Sales Lead",
    "c8cd3e0c-de83-4bc6-b568-66651c5e925e": "Growth Lead",
    "b7e25a62-179b-44eb-962e-3a23eb06c0ea": "QA Lead",
}

ROUTING_TABLE = {
    # Engineering keywords → Dev Lead (e1f66962-dc3c-4a8e-9875-de1a1dee2839)
    "deploy": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.95, "deploy/release"),
    "build": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.90, "build task"),
    "bug": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.95, "bug fix"),
    "fix": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.85, "bug fix"),
    "crash": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.95, "crash/critical"),
    "git": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.90, "git workflow"),
    "pr": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.90, "pull request"),
    "commit": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.85, "git commit"),
    "code": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.80, "code task"),
    "implement": ("e1f66962-dc3c-4a8e-9875-de1a1dee2839", 0.75, "implementation"),
    
    # Product keywords → Product Manager (9adc6c20-de6e-4f0a-83de-ebe8a380f5d0)
    "spec": ("9adc6c20-de6e-4f0a-83de-ebe8a380f5d0", 0.95, "spec/requirements"),
    "feature": ("9adc6c20-de6e-4f0a-83de-ebe8a380f5d0", 0.90, "feature request"),
    "roadmap": ("9adc6c20-de6e-4f0a-83de-ebe8a380f5d0", 0.95, "roadmap"),
    "user story": ("9adc6c20-de6e-4f0a-83de-ebe8a380f5d0", 0.95, "user story"),
    "requirement": ("9adc6c20-de6e-4f0a-83de-ebe8a380f5d0", 0.85, "requirements"),
    
    # Strategy keywords → Strategist (aec05dae-7af7-4323-a21e-00040fbc766a)
    "strategy": ("aec05dae-7af7-4323-a21e-00040fbc766a", 0.95, "strategy"),
    "research": ("aec05dae-7af7-4323-a21e-00040fbc766a", 0.90, "research"),
    "investigate": ("aec05dae-7af7-4323-a21e-00040fbc766a", 0.85, "investigation"),
    "analyze": ("aec05dae-7af7-4323-a21e-00040fbc766a", 0.80, "analysis"),
    "okr": ("aec05dae-7af7-4323-a21e-00040fbc766a", 0.95, "OKR"),
    "vision": ("aec05dae-7af7-4323-a21e-00040fbc766a", 0.90, "vision/direction"),
    "direction": ("aec05dae-7af7-4323-a21e-00040fbc766a", 0.85, "strategic direction"),
    
    # Workflow/Process keywords → Workflow Architect (d3715d54-6c06-4535-abe4-e51523968f38)
    "workflow": ("d3715d54-6c06-4535-abe4-e51523968f38", 0.95, "workflow"),
    "process": ("d3715d54-6c06-4535-abe4-e51523968f38", 0.90, "process"),
    "template": ("d3715d54-6c06-4535-abe4-e51523968f38", 0.85, "template"),
    "playbook": ("d3715d54-6c06-4535-abe4-e51523968f38", 0.90, "playbook"),
    "hire": ("d3715d54-6c06-4535-abe4-e51523968f38", 0.80, "hiring/onboarding"),
    "role": ("d3715d54-6c06-4535-abe4-e51523968f38", 0.75, "role definition"),
    
    # Documentation keywords → Doc Lead (1243032c-c03f-4fe7-8b5d-4eb3a77e84db)
    "doc": ("1243032c-c03f-4fe7-8b5d-4eb3a77e84db", 0.95, "documentation"),
    "wiki": ("1243032c-c03f-4fe7-8b5d-4eb3a77e84db", 0.95, "wiki"),
    "guide": ("1243032c-c03f-4fe7-8b5d-4eb3a77e84db", 0.90, "guide"),
    "readme": ("1243032c-c03f-4fe7-8b5d-4eb3a77e84db", 0.95, "README"),
    "manual": ("1243032c-c03f-4fe7-8b5d-4eb3a77e84db", 0.85, "manual"),
    
    # Sales keywords → Sales Lead (89c526a5-f886-4bf7-bc0a-fc32f1b00b9e)
    "sales": ("89c526a5-f886-4bf7-bc0a-fc32f1b00b9e", 0.95, "sales"),
    "outreach": ("89c526a5-f886-4bf7-bc0a-fc32f1b00b9e", 0.90, "outreach"),
    "pipeline": ("89c526a5-f886-4bf7-bc0a-fc32f1b00b9e", 0.85, "sales pipeline"),
    
    # Marketing keywords → Growth Lead (c8cd3e0c-de83-4bc6-b568-66651c5e925e)
    "marketing": ("c8cd3e0c-de83-4bc6-b568-66651c5e925e", 0.95, "marketing"),
    "growth": ("c8cd3e0c-de83-4bc6-b568-66651c5e925e", 0.95, "growth"),
    "content": ("c8cd3e0c-de83-4bc6-b568-66651c5e925e", 0.90, "content"),
    "seo": ("c8cd3e0c-de83-4bc6-b568-66651c5e925e", 0.85, "SEO"),
    "campaign": ("c8cd3e0c-de83-4bc6-b568-66651c5e925e", 0.85, "campaign"),
    
    # QA keywords → QA Lead (b7e25a62-179b-44eb-962e-3a23eb06c0ea)
    "test": ("b7e25a62-179b-44eb-962e-3a23eb06c0ea", 0.90, "testing"),
    "qa": ("b7e25a62-179b-44eb-962e-3a23eb06c0ea", 0.95, "QA"),
    "quality": ("b7e25a62-179b-44eb-962e-3a23eb06c0ea", 0.90, "quality assurance"),
    "regression": ("b7e25a62-179b-44eb-962e-3a23eb06c0ea", 0.85, "regression test"),
    "test case": ("b7e25a62-179b-44eb-962e-3a23eb06c0ea", 0.90, "test case"),
}

FACILITATOR_ID = "4d53f137-4eeb-43ff-86c6-2fea42ce849e"  # GCC Facilitator (manual assignment)


def route_issue(title: str, description: str = "", confidence_threshold: float = 0.8) -> Tuple[str, float, str]:
    """
    Route an issue based on title/description keywords.
    
    Returns: (agent_id, confidence, reason)
    """
    text = (title + " " + description).lower()
    
    best_agent_id = None
    best_confidence = 0.0
    best_reason = ""
    
    # Scan routing table
    for keyword, (agent_id, confidence, reason) in ROUTING_TABLE.items():
        if keyword.lower() in text:
            if confidence > best_confidence:
                best_agent_id = agent_id
                best_confidence = confidence
                best_reason = reason
    
    # Fallback to Facilitator if confidence too low
    if best_confidence < confidence_threshold:
        return (FACILITATOR_ID, 0.0, f"low_confidence({best_confidence:.2f}) fallback")
    
    if best_agent_id:
        return (best_agent_id, best_confidence, best_reason)
    
    # No match — fallback
    return (FACILITATOR_ID, 0.0, "no_keyword_match")


def log_routing_decision(issue_id: str, title: str, agent_id: str, confidence: float, reason: str):
    """Log routing decision for audit trail."""
    log_entry = {
        "timestamp": os.popen("date -u +%Y-%m-%dT%H:%M:%SZ").read().strip(),
        "issue_id": issue_id,
        "title": title,
        "routed_to": agent_id,
        "confidence": confidence,
        "reason": reason,
    }
    print(json.dumps(log_entry))


if __name__ == "__main__":
    # Example
    agent_id, conf, reason = route_issue("Fix critical database bug in auth service")
    print(f"Route to: {agent_id} (confidence: {conf:.2f}, reason: {reason})")
