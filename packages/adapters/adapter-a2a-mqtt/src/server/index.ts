export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listA2AMqttSkills, syncA2AMqttSkills } from "./skills.js";

export {
  createA2AClient,
  publishRetained,
  publishEvent,
  publishRequestAwaitReply,
  subscribeRetained,
  type A2AClientConfig,
  type PublishEventOptions,
  type PublishRequestAwaitReplyOptions,
  type AwaitReplyResult,
  type SubscribeMessage,
  type SubscribeHandler,
} from "./client.js";

export {
  TOPIC_PREFIX,
  discoveryTopic,
  requestTopic,
  poolRequestTopic,
  replyTopic,
  eventTopic,
  idmPhaseTopic,
  idmInputTopic,
  crossLinkTopic,
  discoveryWildcard,
  requestWildcardForCircle,
  eventWildcardForCircle,
  // Phase 1.8 + 1.9 — heartbeat + DNA topic builders.
  heartbeatTopic,
  heartbeatAckTopic,
  heartbeatAckWildcard,
  dnaTopic,
  hostEventTopic,
  // Phase 1.10 — multi-dimensional addressing (role + skill + broadcasts).
  slugify,
  eventCircleWildcard,
  rolePoolTopic,
  roleBroadcastTopic,
  skillPoolTopic,
  skillBroadcastTopic,
  sharedSubGroup,
} from "./topics.js";
