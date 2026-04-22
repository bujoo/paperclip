export const type = "bedrock_gateway";
export const label = "AWS Bedrock";

export const models: { id: string; label: string }[] = [
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Claude Opus 4.6 (Bedrock)" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Claude Sonnet 4.5 (Bedrock)" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5 (Bedrock)" },
];

export const agentConfigurationDoc = `# bedrock_gateway agent configuration

Adapter: bedrock_gateway

Runs Claude Code CLI with AWS Bedrock as the inference backend.

Use when:
- You want agents to invoke Claude models through AWS Bedrock instead of the Anthropic API.
- You are operating in an AWS account and want to use IAM-based auth or VPC-bound inference.
- Your compliance requirements prohibit direct Anthropic API access.

Don't use when:
- You have a valid Anthropic subscription or API key and no Bedrock requirement.
- You do not have Bedrock model access enabled in your AWS account.

Authentication:
Bedrock credentials are resolved from the standard AWS credential chain in the order below.
Configure one of the following in adapter config \`env\` or in the server environment:

1. IAM role (recommended for EC2/ECS/Lambda) — no explicit key needed; attach a role with
   \`bedrock:InvokeModel\` permission.
2. Environment credentials — set \`AWS_ACCESS_KEY_ID\` and \`AWS_SECRET_ACCESS_KEY\` (and
   optionally \`AWS_SESSION_TOKEN\`) in adapter config \`env\`.
3. AWS profile — set \`AWS_PROFILE\` in adapter config \`env\`.

Required IAM permission: \`bedrock:InvokeModel\` on the target model ARN.

Core fields:
- region (string, required): AWS region where Bedrock is enabled (e.g. us-east-1, us-west-2).
  Sets \`AWS_REGION\` for the Claude process.
- model (string, optional): Bedrock model ID (region-qualified, e.g.
  \`us.anthropic.claude-sonnet-4-5-20250929-v2:0\`). Passed to Claude via \`--model\`.
- cwd (string, optional): absolute working directory for the Claude process.
- command (string, optional): path to the \`claude\` CLI binary (default: \`claude\`).
- env (object, optional): additional KEY=VALUE pairs injected into the Claude process.
  Use this to pass \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\`, \`AWS_PROFILE\`, etc.
- effort (string, optional): reasoning effort passed via \`--effort\` (low|medium|high).
- maxTurnsPerRun (number, optional): max Claude turns per heartbeat run.
- dangerouslySkipPermissions (boolean, optional, default true): pass
  \`--dangerously-skip-permissions\` to Claude (required for headless runs).
- extraArgs (string[], optional): additional CLI arguments forwarded to Claude.
- timeoutSec (number, optional): run timeout in seconds.
- graceSec (number, optional): SIGTERM grace period in seconds.
- instructionsFilePath (string, optional): absolute path to a markdown instructions file.
- workspaceStrategy (object, optional): execution workspace strategy.
- workspaceRuntime (object, optional): reserved for workspace runtime metadata.

Notes:
- \`CLAUDE_CODE_USE_BEDROCK=1\` and \`AWS_REGION\` are injected automatically from the
  \`region\` field. Do not set them manually unless you need to override the defaults.
- Cross-region inference profiles (e.g. \`us.anthropic.*\`) are recommended for production
  workloads to improve availability.
`;
