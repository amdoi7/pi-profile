/**
 * System prompt section detail.
 */
export interface SystemPromptSectionDetail {
  name: string;
  tokens: number;
}

/**
 * Memory file detail
 */
export interface MemoryFileDetail {
  path: string;
  type: string;
  tokens: number;
}

/**
 * System tool detail (built-in tool breakdown)
 */
export interface SystemToolDetail {
  name: string;
  tokens: number;
}

/**
 * Skill detail
 */
export interface SkillDetail {
  name: string;
  tokens: number;
}

/**
 * Message type breakdown
 */
export interface MessageBreakdown {
  userText: number;
  assistantText: number;
  assistantThinking: number;
  toolCalls: number;
  toolResults: number;
  images: number;
  custom: number;
}

/**
 * Compacted history carried forward in the working set.
 */
export interface SummaryBreakdown {
  branchSummaries: number;
  compactionSummaries: number;
}

/**
 * Top-level usage categories shown in the HUD.
 */
export interface CategoryBreakdown {
  systemPrompt: number;
  systemTools: number;
  memoryFiles: number;
  skills: number;
  messages: number;
  autocompactBuffer: number;
  freeSpace: number;
  extensionOverhead: number;
}

/**
 * Unified context breakdown data model.
 * Single source of truth for all context analysis displays.
 */
export interface ContextBreakdown {
  // Measured state from the model (null after compaction)
  measuredTotal: number | null;
  contextWindow: number;
  available: number;

  // Estimated breakdown (always computed)
  estimatedTotal: number;

  // High-level buckets for display
  buckets: {
    systemPrompt: number;    // Total system prompt + context
    systemTools: number;     // Built-in tools only (excluding skills)
    skills: number;          // Skill definitions
    memory: number;          // All memory files combined
    userText: number;
    assistantText: number;
    assistantThinking: number;
    toolCalls: number;
    toolResults: number;
    images: number;
    summaries: number;       // Compacted/summarized history
    custom: number;
  };

  // Detailed breakdowns for tooltips/expanded view
  details?: {
    systemPromptSections?: SystemPromptSectionDetail[];
    memoryFiles?: MemoryFileDetail[];
    systemTools?: SystemToolDetail[];
    skills?: SkillDetail[];
    messageBreakdown?: MessageBreakdown;
    summaryBreakdown?: SummaryBreakdown;
  };

  // Top-level rollup, aligned with the model usage HUD.
  categoryBreakdown: CategoryBreakdown;

  // Truth about uncertainty
  delta: number | null;
  confidence: "measured" | "mixed" | "estimated";

  // Metadata
  metadata: {
    compactionDetected: boolean;
    hasPostCompactionData: boolean;
    buildSessionContextMessageCount: number;
  };
}

/**
 * History topology metrics (separate from working context).
 */
export interface HistoryMetrics {
  branchDepth: number;
  tagDistance: number;
  nearestTag: string | null;
  summaryCount: number;
  compactionCount: number;
}
