import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { testEnvironment as claudeTestEnvironment } from "@paperclipai/adapter-claude-local/server";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAwsRegion(value: string): boolean {
  return /^[a-z]{2}-[a-z]+-\d+$/.test(value.trim());
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const region = asString(config.region, "").trim();
  const envConfig = parseObject(config.env);

  if (!isNonEmpty(region)) {
    checks.push({
      code: "bedrock_region_missing",
      level: "error",
      message: "AWS region is required for bedrock_gateway.",
      hint: "Set adapterConfig.region to a valid AWS region (e.g. us-east-1).",
    });
  } else if (!isAwsRegion(region)) {
    checks.push({
      code: "bedrock_region_format_invalid",
      level: "warn",
      message: `Region value does not match expected AWS format: ${region}`,
      hint: "Verify the region string (e.g. us-east-1, eu-west-1, ap-southeast-1).",
    });
  } else {
    checks.push({
      code: "bedrock_region_set",
      level: "info",
      message: `AWS region configured: ${region}`,
    });
  }

  const hasAccessKey =
    isNonEmpty(envConfig.AWS_ACCESS_KEY_ID) || isNonEmpty(process.env.AWS_ACCESS_KEY_ID);
  const hasSecretKey =
    isNonEmpty(envConfig.AWS_SECRET_ACCESS_KEY) || isNonEmpty(process.env.AWS_SECRET_ACCESS_KEY);
  const hasProfile =
    isNonEmpty(envConfig.AWS_PROFILE) || isNonEmpty(process.env.AWS_PROFILE);
  const hasWebIdentityToken =
    isNonEmpty(process.env.AWS_WEB_IDENTITY_TOKEN_FILE);

  if (hasAccessKey && hasSecretKey) {
    checks.push({
      code: "bedrock_credentials_explicit",
      level: "info",
      message: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are configured.",
    });
  } else if (hasProfile) {
    checks.push({
      code: "bedrock_credentials_profile",
      level: "info",
      message: `AWS_PROFILE is configured: ${envConfig.AWS_PROFILE ?? process.env.AWS_PROFILE}`,
    });
  } else if (hasWebIdentityToken) {
    checks.push({
      code: "bedrock_credentials_web_identity",
      level: "info",
      message: "AWS web identity token detected (EKS/IRSA).",
    });
  } else {
    checks.push({
      code: "bedrock_credentials_implicit",
      level: "warn",
      message: "No explicit AWS credentials detected in adapter config or environment.",
      hint:
        "If running on EC2/ECS/Lambda, an attached IAM role will be used automatically. " +
        "Otherwise, set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY or AWS_PROFILE in adapterConfig.env.",
    });
  }

  const patchedConfig: Record<string, unknown> = {
    ...config,
    env: {
      ...envConfig,
      CLAUDE_CODE_USE_BEDROCK: "1",
      ...(isNonEmpty(region) ? { AWS_REGION: region } : {}),
    },
  };

  const claudeResult = await claudeTestEnvironment({ ...ctx, config: patchedConfig });

  const allChecks = [...checks, ...claudeResult.checks];
  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(allChecks),
    checks: allChecks,
    testedAt: new Date().toISOString(),
  };
}
