import type { UIAdapterModule } from "../types";
import { parseBedrockGatewayStdoutLine, buildBedrockGatewayConfig } from "@paperclipai/adapter-bedrock-gateway/ui";
import { BedrockGatewayConfigFields } from "./config-fields";

export const bedrockGatewayUIAdapter: UIAdapterModule = {
  type: "bedrock_gateway",
  label: "AWS Bedrock",
  parseStdoutLine: parseBedrockGatewayStdoutLine,
  ConfigFields: BedrockGatewayConfigFields,
  buildAdapterConfig: buildBedrockGatewayConfig,
};
