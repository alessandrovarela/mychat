export {
  AUTOMATION_SCHEMA_VERSION,
  AUTOMATION_STATES,
  ANY_WORD_MODE,
  CARD_BUTTON_LIMIT,
  COMMENT_MATCH_MODES,
  FLOW_ACTIONS,
  KEYWORD_MATCH_MODES,
  PURE_LINK_LIMIT,
  SUPPORTED_AUTOMATION_SCHEMA_VERSIONS,
  automationStepSchema,
  automationScopeSchema,
  activeAutomationSchema,
  cardButtonSchema,
  directMessageContentSchema,
  draftAutomationSchema,
  stepTextSchema,
  stepWordings,
  triggerSchema,
  unifiedAutomationSchema,
} from "./schema.js";

export type {
  ActiveAutomation,
  AutomationState,
  AutomationStep,
  AutomationScope,
  AutomationTrigger,
  CardButton,
  CommentMatchMode,
  DirectMessageContent,
  DraftAutomation,
  FlowAction,
  KeywordMatchMode,
  StepText,
  UnifiedAutomation,
} from "./schema.js";

export {
  SUPPORTED_STEP_ACTIONS,
  isSupportedStepAction,
} from "./engine-support.js";

export type { SupportedStepAction } from "./engine-support.js";

export { TRIGGER_TYPES } from "./trigger-compatibility.js";

export type { TriggerType } from "./trigger-compatibility.js";

export {
  VALIDATION_ISSUE_CODES,
  validateAutomationActivation,
  validateUnifiedAutomation,
} from "./validation.js";

export type {
  ValidationIssue,
  ValidationIssueCode,
  ValidationResult,
} from "./validation.js";

export { bindActiveAutomation } from "./binding.js";

export type { BindingIssue, BindingResult } from "./binding.js";

export {
  decodeNoMatch,
  encodeNoMatch,
  isMatchRefusal,
  MATCH_REFUSALS,
  matchAutomation,
  matchesKeyword,
  matchEvent,
  normaliseGlobalMatch,
  NO_MATCH_CODE,
} from "./matching.js";

export type {
  FiredAutomation,
  InboundEvent,
  MatchOutcome,
  MatchRefusal,
  MatchResult,
  MatchTally,
} from "./matching.js";

export {
  createAutomationFailureHandler,
  createAutomationAggregateLifecycle,
  activateAutomationDraft,
} from "./automations.js";

export type {
  AutomationAggregateLifecycle,
  AutomationAggregateSaveResult,
  AutomationAggregateStore,
  AutomationFailureLedger,
  StoredDefinition,
} from "./automations.js";
