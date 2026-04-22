import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function getEnvValue(config: Record<string, unknown>, key: string): string {
  const env = config.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return "";
  const entry = (env as Record<string, unknown>)[key];
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null && "value" in entry) {
    return typeof (entry as Record<string, unknown>).value === "string"
      ? String((entry as Record<string, unknown>).value)
      : "";
  }
  return "";
}

export function BedrockGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  const schemaValues = values?.adapterSchemaValues ?? {};

  const effectiveRegion = isCreate
    ? String(schemaValues.region ?? "")
    : eff("adapterConfig", "region", String(config.region ?? ""));

  const effectiveProfile = isCreate
    ? String(schemaValues.awsProfile ?? "")
    : getEnvValue(
        eff("adapterConfig", "env", config.env) as Record<string, unknown> ?? {},
        "AWS_PROFILE",
      );

  const effectiveModel = isCreate
    ? String(values!.model ?? "")
    : eff("adapterConfig", "model", String(config.model ?? ""));

  const commitProfile = (v: string) => {
    if (isCreate) {
      set!({ adapterSchemaValues: { ...schemaValues, awsProfile: v || undefined } });
      return;
    }
    const existingEnv =
      typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
        ? (config.env as Record<string, unknown>)
        : {};
    const nextEnv = { ...existingEnv };
    if (v.trim()) {
      nextEnv.AWS_PROFILE = { type: "plain", value: v.trim() };
    } else {
      delete nextEnv.AWS_PROFILE;
    }
    mark("adapterConfig", "env", Object.keys(nextEnv).length > 0 ? nextEnv : undefined);
  };

  return (
    <>
      <Field
        label="AWS region"
        hint="AWS region where Bedrock is enabled (e.g. us-west-2). Required."
      >
        <DraftInput
          value={effectiveRegion}
          onCommit={(v) =>
            isCreate
              ? set!({ adapterSchemaValues: { ...schemaValues, region: v || undefined } })
              : mark("adapterConfig", "region", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="us-west-2"
        />
      </Field>

      <Field
        label="AWS profile"
        hint="SSO or named profile from ~/.aws/config. Run aws sso login --profile <name> to refresh the token before starting agents."
      >
        <DraftInput
          value={effectiveProfile}
          onCommit={commitProfile}
          immediate
          className={inputClass}
          placeholder="wds_dev"
        />
      </Field>

      <Field
        label="Model"
        hint="Bedrock model ID (e.g. us.anthropic.claude-sonnet-4-5-20250929-v2:0). Leave blank to use the default."
      >
        {models.length > 0 ? (
          <select
            value={effectiveModel}
            onChange={(e) =>
              isCreate
                ? set!({ model: e.target.value })
                : mark("adapterConfig", "model", e.target.value || undefined)
            }
            className={inputClass}
          >
            <option value="">Default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <DraftInput
            value={effectiveModel}
            onCommit={(v) =>
              isCreate
                ? set!({ model: v })
                : mark("adapterConfig", "model", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="us.anthropic.claude-sonnet-4-5-20250929-v2:0"
          />
        )}
      </Field>

      <Field
        label="Working directory"
        hint="Absolute path used as the default working directory for the Claude process."
      >
        <DraftInput
          value={
            isCreate
              ? values!.cwd
              : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ cwd: v })
              : mark("adapterConfig", "cwd", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/workspace/project"
        />
      </Field>
    </>
  );
}
