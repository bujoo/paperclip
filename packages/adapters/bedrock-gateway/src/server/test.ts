import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { testEnvironment as claudeTestEnvironment } from "@paperclipai/adapter-claude-local/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function checkSsoTokenExpiry(profileName: string): Promise<"valid" | "expired" | "unknown"> {
  const ssoCacheDir = path.join(os.homedir(), ".aws", "sso", "cache");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(ssoCacheDir);
  } catch {
    return "unknown";
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const data = await readJsonFile(path.join(ssoCacheDir, entry));
    if (!data) continue;

    const startUrl = typeof data.startUrl === "string" ? data.startUrl : null;
    const accountId = typeof data.accountId === "string" ? data.accountId : null;
    const roleName = typeof data.roleName === "string" ? data.roleName : null;
    const expiresAt = typeof data.expiresAt === "string" ? data.expiresAt : null;

    // Token cache files either contain a session token (with startUrl) or
    // role credentials (with accountId + roleName). Check both.
    const isRelevant = startUrl || (accountId && roleName);
    if (!isRelevant) continue;

    if (expiresAt) {
      const expiry = new Date(expiresAt);
      if (!isNaN(expiry.getTime())) {
        return expiry > new Date() ? "valid" : "expired";
      }
    }
  }

  // Fall back to checking the credentials file for a non-SSO entry with the profile name.
  const credsFile = path.join(os.homedir(), ".aws", "credentials");
  const credsContent = await fs.readFile(credsFile, "utf-8").catch(() => "");
  if (credsContent.includes(`[${profileName}]`)) return "valid";

  return "unknown";
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

  const profileName =
    (isNonEmpty(envConfig.AWS_PROFILE) ? (envConfig.AWS_PROFILE as string) : null) ??
    (isNonEmpty(process.env.AWS_PROFILE) ? process.env.AWS_PROFILE! : null);
  const hasAccessKey =
    isNonEmpty(envConfig.AWS_ACCESS_KEY_ID) || isNonEmpty(process.env.AWS_ACCESS_KEY_ID);
  const hasSecretKey =
    isNonEmpty(envConfig.AWS_SECRET_ACCESS_KEY) || isNonEmpty(process.env.AWS_SECRET_ACCESS_KEY);
  const hasWebIdentityToken = isNonEmpty(process.env.AWS_WEB_IDENTITY_TOKEN_FILE);

  if (hasAccessKey && hasSecretKey) {
    checks.push({
      code: "bedrock_credentials_explicit",
      level: "info",
      message: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are configured.",
    });
  } else if (profileName) {
    const ssoStatus = await checkSsoTokenExpiry(profileName);
    if (ssoStatus === "expired") {
      checks.push({
        code: "bedrock_sso_token_expired",
        level: "warn",
        message: `AWS SSO token for profile "${profileName}" appears to be expired.`,
        hint: `Run: aws sso login --profile ${profileName}`,
      });
    } else if (ssoStatus === "valid") {
      checks.push({
        code: "bedrock_credentials_sso",
        level: "info",
        message: `AWS SSO profile "${profileName}" is configured and token appears valid.`,
      });
    } else {
      checks.push({
        code: "bedrock_credentials_profile",
        level: "info",
        message: `AWS_PROFILE is configured: ${profileName}`,
        hint: "Ensure aws sso login has been run if this is an SSO profile.",
      });
    }
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
        "For local use, set AWS_PROFILE (e.g. wds_dev) in adapterConfig.env after running aws sso login.",
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
