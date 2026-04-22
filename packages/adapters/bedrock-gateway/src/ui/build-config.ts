import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildBedrockGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const schema = v.adapterSchemaValues ?? {};
  const region = typeof schema.region === "string" ? schema.region.trim() : "";
  const awsProfile = typeof schema.awsProfile === "string" ? schema.awsProfile.trim() : "";

  const ac: Record<string, unknown> = {};

  if (region) ac.region = region;
  if (v.cwd) ac.cwd = v.cwd;
  if (v.model) ac.model = v.model;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;

  ac.timeoutSec = 0;
  ac.graceSec = 15;
  ac.maxTurnsPerRun = v.maxTurnsPerRun;
  ac.dangerouslySkipPermissions = v.dangerouslySkipPermissions;

  if (awsProfile) {
    ac.env = { AWS_PROFILE: { type: "plain", value: awsProfile } };
  }

  return ac;
}
