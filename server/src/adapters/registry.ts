import type { AdapterModelProfileDefinition, ServerAdapterModule } from "./types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  execute as acpxExecute,
  testEnvironment as acpxTestEnvironment,
  sessionCodec as acpxSessionCodec,
  getConfigSchema as getAcpxConfigSchema,
  listAcpxSkills,
  syncAcpxSkills,
} from "@paperclipai/adapter-acpx-local/server";
import { agentConfigurationDoc as acpxAgentConfigurationDoc } from "@paperclipai/adapter-acpx-local";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  modelProfiles as claudeModelProfiles,
} from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  modelProfiles as codexModelProfiles,
} from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  modelProfiles as cursorModelProfiles,
} from "@paperclipai/adapter-cursor-local";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  modelProfiles as geminiModelProfiles,
} from "@paperclipai/adapter-gemini-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  modelProfiles as openCodeModelProfiles,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import {
  execute as bedrockGatewayExecute,
  testEnvironment as bedrockGatewayTestEnvironment,
  listBedrockSkills,
  syncBedrockSkills,
} from "@paperclipai/adapter-bedrock-gateway/server";
import {
  agentConfigurationDoc as bedrockGatewayAgentConfigurationDoc,
  models as bedrockGatewayModels,
} from "@paperclipai/adapter-bedrock-gateway";
import {
  execute as a2aMqttExecute,
  testEnvironment as a2aMqttTestEnvironment,
  listA2AMqttSkills,
  syncA2AMqttSkills,
} from "@paperclipai/adapter-a2a-mqtt/server";
import {
  agentConfigurationDoc as a2aMqttAgentConfigurationDoc,
  models as a2aMqttModels,
} from "@paperclipai/adapter-a2a-mqtt";
import { listCodexModels, refreshCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  modelProfiles as piModelProfiles,
} from "@paperclipai/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

function normalizeHermesConfig<T extends { config?: unknown; agent?: unknown }>(ctx: T): T {
  const config =
    ctx && typeof ctx === "object" && "config" in ctx && ctx.config && typeof ctx.config === "object"
      ? (ctx.config as Record<string, unknown>)
      : null;
  const agent =
    ctx && typeof ctx === "object" && "agent" in ctx && ctx.agent && typeof ctx.agent === "object"
      ? (ctx.agent as Record<string, unknown>)
      : null;
  const agentAdapterConfig =
    agent?.adapterConfig && typeof agent.adapterConfig === "object"
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;

  const configCommand =
    typeof config?.command === "string" && config.command.length > 0 ? config.command : undefined;
  const agentCommand =
    typeof agentAdapterConfig?.command === "string" && agentAdapterConfig.command.length > 0
      ? agentAdapterConfig.command
      : undefined;

  if (config && !config.hermesCommand && configCommand) {
    config.hermesCommand = configCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.hermesCommand && agentCommand) {
    agentAdapterConfig.hermesCommand = agentCommand;
  }

  return ctx;
}

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  modelProfiles: claudeModelProfiles,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  execute: acpxExecute,
  testEnvironment: acpxTestEnvironment,
  listSkills: listAcpxSkills,
  syncSkills: syncAcpxSkills,
  sessionCodec: acpxSessionCodec,
  sessionManagement: getAdapterSessionManagement("acpx_local") ?? undefined,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: acpxAgentConfigurationDoc,
  getConfigSchema: getAcpxConfigSchema,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  modelProfiles: cursorModelProfiles,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  modelProfiles: geminiModelProfiles,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const bedrockGatewayAdapter: ServerAdapterModule = {
  type: "bedrock_gateway",
  execute: bedrockGatewayExecute,
  testEnvironment: bedrockGatewayTestEnvironment,
  listSkills: listBedrockSkills,
  syncSkills: syncBedrockSkills,
  models: bedrockGatewayModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: bedrockGatewayAgentConfigurationDoc,
};

const a2aMqttAdapter: ServerAdapterModule = {
  type: "a2a_mqtt",
  execute: a2aMqttExecute,
  testEnvironment: a2aMqttTestEnvironment,
  listSkills: listA2AMqttSkills,
  syncSkills: syncA2AMqttSkills,
  models: a2aMqttModels,
  // a2a_mqtt speaks to a remote agent over MQTT — no local-JWT impersonation,
  // no managed instructions bundle, no materialised runtime skills.
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: a2aMqttAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  modelProfiles: openCodeModelProfiles,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: piModelProfiles,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

// hermes-paperclip-adapter v0.2.0 predates the authToken field; cast is
// intentional until hermes ships a matching AdapterExecutionContext type.
const executeHermesLocal = hermesExecute as unknown as ServerAdapterModule["execute"];

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: async (ctx) => {
    const normalizedCtx = normalizeHermesConfig(ctx);
    if (!normalizedCtx.authToken) return executeHermesLocal(normalizedCtx);

    const existingConfig = (normalizedCtx.agent.adapterConfig ?? {}) as Record<string, unknown>;
    const existingEnv =
      typeof existingConfig.env === "object" && existingConfig.env !== null && !Array.isArray(existingConfig.env)
        ? (existingConfig.env as Record<string, string>)
        : {};
    const explicitApiKey =
      typeof existingEnv.PAPERCLIP_API_KEY === "string" && existingEnv.PAPERCLIP_API_KEY.trim().length > 0;
    const promptTemplate =
      typeof existingConfig.promptTemplate === "string" && existingConfig.promptTemplate.trim().length > 0
        ? existingConfig.promptTemplate
        : "";
    const authGuardPrompt = [
      "Paperclip API safety rule:",
      "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
      "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
      "Never use a board, browser, or local-board session for Paperclip API writes.",
    ].join("\n");

    // Phase 1.15h-f — surface the neighbourhood snapshot to hermes. The
    // heartbeat composes `runtimeConfig.companyDnaMarkdown` (DNA + circle
    // peers + recent broadcasts + active discussions) — claude-local reads it
    // natively, hermes does not. Prepend it to the prompt so hermes agents can
    // SEE their team and recent activity, not just their assigned task.
    const runtimeConfigForHermes = (normalizedCtx as unknown as { config?: Record<string, unknown> }).config ?? {};
    const dnaMarkdown =
      typeof runtimeConfigForHermes.companyDnaMarkdown === "string"
        ? runtimeConfigForHermes.companyDnaMarkdown.trim()
        : "";

    // Phase 1.15h-g2 — discussion-mode preamble. When the heartbeat injects
    // a `discussion:turn` issue, it also sets `discussionMode = true` so the
    // wrapper can prepend a conversational instruction telling the agent HOW
    // to engage in a reactions round (voice substantive view, ground in role,
    // build on peers, etc.) instead of merely acknowledging context.
    //
    // Phase 1.15h-h2 — SMART scoping + per-role synthesis variants.
    // When the heartbeat surfaces SMART context + discussionRole, the preamble
    // (a) injects DEADLINE / SUCCESS CRITERION / SCOPE / EXPECTED OUTPUT,
    // (b) swaps in role-specific blocks for Lead Link (synthesis) and
    // Secretary on summary turns (capture), and (c) appends an HTTP-bridge
    // ledger so agents know how to ESCALATE via Paperclip API instead of
    // emitting prose-only handovers.
    const isDiscussionTurn = runtimeConfigForHermes.discussionMode === true;

    type DiscussionSmart = {
      successCriterion?: string | null;
      scopeIn?: string[] | null;
      scopeOut?: string[] | null;
      decisionDeadline?: string | null;
      expectedOutputKind?: string | null;
      motivatingTensionId?: string | null;
      hoursRemaining?: number | null;
      // Phase 1.15h-i #2 — Grove pre-flight (HOM ch. 5).
      decisionOwnerAgentId?: string | null;
      decisionOwnerName?: string | null;
      ratifierAgentId?: string | null;
      ratifierName?: string | null;
      consultedAgentIds?: string[] | null;
      consultedNames?: string[] | null;
      informedAgentIds?: string[] | null;
      informedNames?: string[] | null;
    };
    const smart =
      isDiscussionTurn && runtimeConfigForHermes.discussionSmart &&
      typeof runtimeConfigForHermes.discussionSmart === "object"
        ? (runtimeConfigForHermes.discussionSmart as DiscussionSmart)
        : null;
    const discussionRole =
      isDiscussionTurn && typeof runtimeConfigForHermes.discussionRole === "string"
        ? (runtimeConfigForHermes.discussionRole as string).toLowerCase()
        : "";
    const discussionTurnKind =
      isDiscussionTurn && typeof runtimeConfigForHermes.discussionTurnKind === "string"
        ? (runtimeConfigForHermes.discussionTurnKind as string)
        : "";
    const isSummaryTurn = discussionTurnKind === "discussion:summary";
    // Phase 1.15h-l F2 — IDM phase from circle_discussions.phase. Only the 6
    // IDM phases (proposal / clarifying_questions / reactions / amend /
    // objections / integration) get a phase-specific preamble block;
    // other values ("open", "awaiting_commitments", "concluded",
    // "deadlocked") fall through and preserve existing behaviour.
    const discussionPhase =
      isDiscussionTurn && typeof runtimeConfigForHermes.discussionPhase === "string"
        ? (runtimeConfigForHermes.discussionPhase as string).toLowerCase()
        : "";

    const expectedKindLabel =
      smart && typeof smart.expectedOutputKind === "string" && smart.expectedOutputKind.trim().length > 0
        ? smart.expectedOutputKind.trim()
        : "next_action";

    const smartBlock = smart
      ? (() => {
          const deadlineText =
            smart.decisionDeadline
              ? `${smart.decisionDeadline}${
                  typeof smart.hoursRemaining === "number"
                    ? ` (${Math.max(0, Math.round(smart.hoursRemaining))}h remaining)`
                    : ""
                }`
              : "unset";
          const inList = Array.isArray(smart.scopeIn) && smart.scopeIn.length > 0
            ? smart.scopeIn.join(", ")
            : "(unspecified)";
          const outList = Array.isArray(smart.scopeOut) && smart.scopeOut.length > 0
            ? smart.scopeOut.join(", ")
            : "(none)";
          const sc =
            typeof smart.successCriterion === "string" && smart.successCriterion.trim().length > 0
              ? smart.successCriterion.trim()
              : "(unspecified — request one or propose your own)";
          return [
            "This discussion is SMART-scoped:",
            `- DEADLINE: ${deadlineText}`,
            `- SUCCESS CRITERION: ${sc}`,
            `- IN SCOPE: ${inList}`,
            `- OUT OF SCOPE: ${outList} (raise as separate tension; do NOT derail this discussion)`,
            `- EXPECTED OUTPUT: ONE \`${expectedKindLabel}\` artifact by deadline`,
          ].join("\n");
        })()
      : "";

    // Phase 1.15h-i #2 — Grove pre-flight (High Output Management, ch. 5).
    // Only render when at least one of the four WHO fields is populated; an
    // entirely-empty Grove block adds noise without information. Names are
    // joined from the heartbeat's agents-table LEFT JOIN.
    const groveBlock = smart
      ? (() => {
          const ownerName =
            typeof smart.decisionOwnerName === "string" && smart.decisionOwnerName.trim().length > 0
              ? smart.decisionOwnerName.trim()
              : (typeof smart.decisionOwnerAgentId === "string" && smart.decisionOwnerAgentId.length > 0
                  ? smart.decisionOwnerAgentId
                  : "");
          const ratifierName =
            typeof smart.ratifierName === "string" && smart.ratifierName.trim().length > 0
              ? smart.ratifierName.trim()
              : (typeof smart.ratifierAgentId === "string" && smart.ratifierAgentId.length > 0
                  ? smart.ratifierAgentId
                  : "");
          const consultedList =
            Array.isArray(smart.consultedNames) && smart.consultedNames.length > 0
              ? smart.consultedNames.join(", ")
              : (Array.isArray(smart.consultedAgentIds) && smart.consultedAgentIds.length > 0
                  ? smart.consultedAgentIds.join(", ")
                  : "");
          const informedList =
            Array.isArray(smart.informedNames) && smart.informedNames.length > 0
              ? smart.informedNames.join(", ")
              : (Array.isArray(smart.informedAgentIds) && smart.informedAgentIds.length > 0
                  ? smart.informedAgentIds.join(", ")
                  : "");
          const anyPopulated = Boolean(ownerName || ratifierName || consultedList || informedList);
          if (!anyPopulated) return "";
          return [
            "Grove pre-flight (this discussion):",
            `- Decision owner: ${ownerName || "unset"}`,
            `- Ratifier: ${ratifierName || "Lead Link"}`,
            `- Consulted: ${consultedList || "none"}`,
            `- Informed: ${informedList || "none"}`,
          ].join("\n");
        })()
      : "";

    // Per-role variant of the "your job RIGHT NOW" block.
    const genericJobBlock = [
      "Your job RIGHT NOW:",
      "1. Voice YOUR view on the topic in 1-2 concrete paragraphs. Don't hedge. Don't only acknowledge context.",
      "2. Ground your view in your role's purpose + accountabilities (see \"Your role\" below).",
      "3. Build on, agree with, or counter what peers have already said (see \"Recent perceptions\" and \"Active discussions\").",
      "4. If the topic is outside your role's domain: instead of guessing, raise a tension with `holacracy-raise-tension-on-bus` OR forward it via `holacracy-forward-tension` OR ask the right role via `holacracy-talk-to-agent`. Do not respond with \"Standing by\" or \"No directives\".",
      "5. If you genuinely don't understand the topic: use `holacracy-ask-clarifying-question` (sidecar — does NOT count as your turn).",
      "",
      "Output format: 1-2 paragraphs of substantive reasoning, ending with a single concrete recommendation or open question.",
    ].join("\n");

    // Phase 1.15h-i — Per-role blocks corrected against deeper books-kb
    // review (Robertson + Getting Teams Done):
    //   Lead Link: PARTICIPANT — voice view, propose role creation if a role
    //     gap is causing the tension, otherwise no special duty in IDM. Cell-
    //     membrane = role assignment / resources / priorities / metrics. NOT
    //     synthesis, NOT meta-process.
    //   Facilitator: PROCESS REFEREE ("scheidsrechter"). Confirm phase,
    //     summarise divergence, ask proposer to amend. No opinion on content.
    //   Secretary: SCRIBE. Capture verbatim, recite on demand. Never
    //     synthesises and never authors a proposal. On the summariser turn,
    //     emit a JSON capture of the round (not new content).
    //   Proposer (whoever raised the motivating tension): owns the proposal —
    //     workable version, defends rationale, re-drafts on valid objections.
    //     We can't dispatch this from the discussion preamble yet because the
    //     proposer is not tracked as a `discussionRole`; flagged for follow-
    //     up (Phase 1.15h-i bridge to idm_approvals).
    const leadLinkBlock = [
      "You are the Lead Link of this circle — your job is role allocation, resource allocation, priority-setting, and defining metrics. In IDM you are a PARTICIPANT, not a synthesiser, not a decider for the group.",
      "Your turn now: voice your view in 1-2 concrete paragraphs grounded in your accountabilities. Same expectations as any other peer.",
      "If the tension exposes a role GAP (no agent in this circle has the accountability for it), call `holacracy-onboard-agent` to propose creating that role. If the topic clearly belongs to a parent circle, call `holacracy-forward-tension`. Otherwise simply contribute your view.",
      "Output: 1-2 paragraphs of substantive reasoning. Do NOT synthesise others' views — that's not your job in IDM.",
    ].join("\n");

    // F7 — Proposer role variant. The proposer (whoever raised the motivating
    // tension) has different obligations from any other participant: they own
    // the proposal, defend its rationale, and re-draft when valid objections
    // land. This is selected via runtimeConfig.isProposer (set by heartbeat
    // when the agent is the discussion's initiated_by_agent_id), and takes
    // precedence over their structural role in the discussion.
    const proposerBlock = [
      "You are the PROPOSER of this discussion (you raised the motivating tension). Robertson: the proposer owns the proposal, defends its rationale, and re-drafts on VALID objections — but never on speculation or preference.",
      "Your turn now depends on the phase. In `proposal`: state the change in 1-2 sentences, cite the tension. In `clarifying`: answer questions; do NOT defend. In `reactions`: listen — you don't speak. In `amend`: amend ONLY if a substantive concern was raised; otherwise hold. In `objections`: respond to each objection's harm-to-the-circle test; if invalid (per Robertson's 3 criteria) say so. In `integration`: re-draft to integrate the valid objection.",
      "Werkbaar over SMART — the bar is 'workable as an experiment', not perfection. Do NOT chase consensus.",
      "Output: 1-2 paragraphs targeted at the current phase.",
    ].join("\n");

    const facilitatorBlock = [
      "You are the Facilitator (Robertson: 'scheidsrechter' / process referee). Your job in this round is PROCESS, not content.",
      "1. Confirm the discussion is in the right phase (reactions vs. amendment vs. objections). Name the phase explicitly.",
      "2. If reactions are still divergent, summarise the divergence in one paragraph and ask the proposer (whoever raised the motivating tension) to amend their proposal.",
      "3. If you spot an invalid objection (not based on harm to the circle / not following from the proposal / not based on current knowledge), name it and call for the proposer to continue.",
      "Do NOT add your own opinion on the topic. Your authority is over the process only.",
      "Output: 1 paragraph naming the current phase + what should happen next.",
    ].join("\n");

    const secretaryScribeBlock = [
      "You are the Secretary — the SCRIBE. Your job is CAPTURE only: record the current state of the proposal verbatim, never synthesise, never author.",
      "Your turn now: produce a 2-3 sentence factual recap of what each prior speaker said. No opinion, no new content.",
      "Output: bullet list, one bullet per peer, in the form `- {agentName}: {brief factual paraphrase of their stated view}`. End with `current_proposal: \"<text the proposer last stated, or 'none yet'>\"`.",
    ].join("\n");

    const secretarySummaryBlock = [
      "You are the Secretary on the summariser turn — still a SCRIBE, not a synthesiser. Capture the conversation as a structured record. The proposer (tension-raiser) owns any new proposal content; you only record what was said.",
      `Output strict JSON: { "current_proposal": "<verbatim from proposer's last turn, or 'none — circle has not converged'>", "kind": "${expectedKindLabel}", "phase_recap": [ { "agent": "<name>", "view": "<one-sentence paraphrase>" } ], "open_objections": [ ... ], "next_action": "<who should re-draft, per Lead Link's routing>" }.`,
      "If no proposer turn was produced, set current_proposal to 'none — circle has not converged' and next_action to 'Lead Link to forward this tension to parent circle'. Do NOT invent a proposal text yourself.",
    ].join("\n");

    // Phase 1.15h-h4 — non-current-speaker suppression. If the heartbeat
    // determined this agent is NOT the active speaker of the current round
    // (woken via a perception, not a turn-spawn), override every other role
    // variant with an OBSERVE-ONLY block so they don't add a spurious turn.
    const isCurrentSpeaker =
      isDiscussionTurn && runtimeConfigForHermes.isCurrentSpeaker === true;
    const observerBlock = [
      "You are OBSERVING this discussion round — this run is NOT your turn.",
      "Do NOT add a turn. Update your mental model from the existing turns + perceptions.",
      "If you spot something the current speaker is missing, use `holacracy-ask-clarifying-question` OR `POST /api/holacracy/talk-to-agent` to send a sidecar note — neither counts as a turn.",
      "Output: one line stating 'OBSERVING — not my turn' followed by at most one optional clarifying question.",
    ].join("\n");

    // F7 — proposer flag takes precedence over the structural role variant
    // because the proposer's obligations are phase-shaped, not role-shaped.
    const isProposer =
      isDiscussionTurn && runtimeConfigForHermes.isProposer === true;

    let roleJobBlock = genericJobBlock;
    if (isDiscussionTurn) {
      if (!isCurrentSpeaker && !isSummaryTurn) {
        roleJobBlock = observerBlock;
      } else if (isProposer) {
        roleJobBlock = proposerBlock;
      } else if (discussionRole === "secretary" && isSummaryTurn) {
        roleJobBlock = secretarySummaryBlock;
      } else if (discussionRole === "secretary") {
        roleJobBlock = secretaryScribeBlock;
      } else if (discussionRole === "facilitator") {
        roleJobBlock = facilitatorBlock;
      } else if (discussionRole === "lead_link") {
        roleJobBlock = leadLinkBlock;
      }
    }

    // Phase 1.15h-l F2 — IDM phase-specific doctrine blocks (Robertson,
    // Holacracy ch. 3 + 4). Prepended ABOVE the role block so the agent sees
    // WHAT PHASE this turn is in BEFORE it sees WHAT THEIR ROLE asks for.
    // Skipped entirely for non-IDM phases ("open", "awaiting_commitments",
    // etc.) to preserve the existing behaviour for legacy / non-governance
    // discussions.
    const proposalBlock = [
      "Phase: PROPOSAL. You are presenting your tension as a concrete change to roles/policies/process. State the proposal in 1-2 sentences. Cite the tension. Do NOT yet defend or elaborate — that comes in reactions if needed.",
    ].join("\n");
    const clarifyingQuestionsBlock = [
      "Phase: CLARIFYING QUESTIONS. ONLY questions are allowed — no opinions, no reactions yet. If you don't have a clarifying question, output 'PASS' on one line. Questions go to the proposer. The proposer answers; nobody else.",
    ].join("\n");
    const reactionsBlock = [
      "Phase: REACTIONS. Voice your reaction in 1-2 paragraphs. No cross-talk: react to the PROPOSAL, not to other reactions. The proposer listens silently — they do NOT respond to your reaction in this phase.",
    ].join("\n");
    const amendBlock = [
      "Phase: AMEND OR CLARIFY. If you are the proposer, decide whether to revise the proposal based on what you heard in reactions. Output either the revised proposal text OR 'NO CHANGE' on one line.",
    ].join("\n");
    const objectionsBlock = [
      "Phase: OBJECTIONS. Each participant: do you have a VALID objection? Robertson's 3 criteria — ALL must be true:",
      " 1. Proposal causes NEW harm to the circle (not current-state harm)",
      " 2. Harm FOLLOWS from the proposal text (not from speculation)",
      " 3. Harm is based on CURRENT knowledge or near-term forecast",
      "If all 3 true: state the objection. If any fails: output 'NO OBJECTION'. Invalid objections auto-downgrade to support-with-objection.",
    ].join("\n");
    const integrationBlock = [
      "Phase: INTEGRATION. If you are the proposer or the objector: work the proposal together until the objection is integrated (modified so the harm no longer follows). Output the integrated proposal text. Other participants stay silent.",
    ].join("\n");

    let phaseBlock = "";
    if (isDiscussionTurn) {
      switch (discussionPhase) {
        case "proposal":
          phaseBlock = proposalBlock;
          break;
        case "clarifying_questions":
          phaseBlock = clarifyingQuestionsBlock;
          break;
        case "reactions":
          phaseBlock = reactionsBlock;
          break;
        case "amend":
          phaseBlock = amendBlock;
          break;
        case "objections":
          phaseBlock = objectionsBlock;
          break;
        case "integration":
          phaseBlock = integrationBlock;
          break;
        default:
          phaseBlock = "";
      }
    }

    const httpBridgeLedger = [
      "You can ESCALATE via HTTP. Paperclip API base is $PAPERCLIP_API_BASE (env var). Endpoints:",
      "- POST {base}/api/holacracy/tensions  body { circleId, title, body, severity } — raise a tension",
      "- POST {base}/api/holacracy/forward-tension  body { tensionId, context } — escalate to parent circle",
      "- POST {base}/api/holacracy/talk-to-agent  body { toAgentId, text, contextId? } — DM a peer",
      "- POST {base}/api/holacracy/ask-skill  body { skill, text } — broadcast to skill pool",
      "- POST {base}/api/holacracy/broadcast  body { circleId, kind, body } — circle-wide announce",
      "Authorize with `Authorization: Bearer $PAPERCLIP_API_KEY` (set in env).",
      "",
      "If you say \"I will forward this\" or \"I will raise a tension,\" you MUST call the relevant endpoint in this run. Prose-only handovers do NOT count.",
    ].join("\n");

    const discussionPreamble = isDiscussionTurn
      ? [
          "You are in a Holacracy team discussion (reactions round). This run is your turn.",
          ...(phaseBlock ? ["", phaseBlock] : []),
          "",
          roleJobBlock,
          ...(smartBlock ? ["", smartBlock] : []),
          ...(groveBlock ? ["", groveBlock] : []),
          "",
          httpBridgeLedger,
        ].join("\n")
      : "";

    // Phase 1.15h-j2 — inject PAPERCLIP_API_BASE so hermes can actually call
    // the HTTP-bridge endpoints documented in the preamble. Without this var,
    // hermes attempts curl with an empty base and gets connection-refused
    // (curl error 7). Falls back to local default if no public URL is set.
    const paperclipApiBase =
      (typeof process.env.PAPERCLIP_PUBLIC_URL === "string" && process.env.PAPERCLIP_PUBLIC_URL.trim().length > 0
        ? process.env.PAPERCLIP_PUBLIC_URL.replace(/\/+$/, "")
        : null)
      ?? `http://127.0.0.1:${process.env.PORT || "3100"}`;

    const patchedConfig: Record<string, unknown> = {
      ...existingConfig,
      env: {
        ...existingEnv,
        ...(!explicitApiKey ? { PAPERCLIP_API_KEY: normalizedCtx.authToken } : {}),
        PAPERCLIP_RUN_ID: normalizedCtx.runId,
        PAPERCLIP_API_BASE: paperclipApiBase,
      },
    };

    // Build the effective promptTemplate:
    //   <neighbourhood snapshot>\n\n---\n\n<auth guard>\n\n<existing template>
    // When no existing template is set, hermes uses its built-in default
    // heartbeat/task prompt — but we still want the neighbourhood prefix in
    // front of it, so we set promptTemplate to (snapshot + auth guard) and
    // rely on hermes appending its default per-turn body if needed. If we
    // have NO snapshot AND NO existing template, leave promptTemplate unset
    // so hermes's default behaviour is preserved end-to-end.
    const prefixParts: string[] = [];
    if (discussionPreamble) prefixParts.push(discussionPreamble);
    if (dnaMarkdown) prefixParts.push(dnaMarkdown);
    if (promptTemplate || dnaMarkdown || discussionPreamble) prefixParts.push(authGuardPrompt);
    const prefix = prefixParts.join("\n\n---\n\n");
    if (prefix && promptTemplate) {
      patchedConfig.promptTemplate = `${prefix}\n\n${promptTemplate}`;
    } else if (prefix && !promptTemplate) {
      patchedConfig.promptTemplate = prefix;
    } else if (promptTemplate) {
      // No DNA snapshot but custom template exists — preserve prior behaviour
      // (auth guard prepended to template).
      patchedConfig.promptTemplate = `${authGuardPrompt}\n\n${promptTemplate}`;
    }

    const patchedCtx = {
      ...normalizedCtx,
      agent: {
        ...normalizedCtx.agent,
        adapterConfig: patchedConfig,
      },
    };

    return executeHermesLocal(patchedCtx);
  },
  testEnvironment: (ctx) => hermesTestEnvironment(normalizeHermesConfig(ctx) as never),
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    openclawGatewayAdapter,
    bedrockGatewayAdapter,
    a2aMqttAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Used by both the init-time IIFE below (external-adapter load pass on
 * server start) and the hot-install path in `routes/adapters.ts`
 * (`registerWithSessionManagement`), so the two load paths resolve
 * `sessionManagement` identically.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
        ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? processAdapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function refreshAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.refreshModels) {
    const refreshed = await adapter.refreshModels();
    if (refreshed.length > 0) return refreshed;
  }
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelProfiles(type: string): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModelProfiles) {
    const discovered = await adapter.listModelProfiles();
    if (discovered.length > 0) return discovered;
  }
  return adapter.modelProfiles ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
