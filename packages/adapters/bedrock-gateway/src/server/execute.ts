import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";

function patchContextForBedrock(ctx: AdapterExecutionContext): AdapterExecutionContext {
  const config = parseObject(ctx.config);
  const region = asString(config.region, "").trim();

  const existingEnv = parseObject(config.env);
  const bedrockEnv: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_SIMPLE: "1",
    ...(region ? { AWS_REGION: region } : {}),
  };

  const patchedConfig: Record<string, unknown> = {
    ...config,
    env: { ...existingEnv, ...bedrockEnv },
  };

  return { ...ctx, config: patchedConfig };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return claudeExecute(patchContextForBedrock(ctx));
}
