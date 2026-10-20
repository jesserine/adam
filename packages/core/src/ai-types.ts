/** Supported AI Provider Identifiers */
export type AiProvider = "chatgpt" | "claude" | "grok" | "gemini";

export const AI_PROVIDERS: readonly AiProvider[] = [
  "chatgpt",
  "claude",
  "grok",
  "gemini",
] as const;

/** Display metadata for UI rendering */
export interface AiProviderMeta {
  readonly id: AiProvider;
  readonly name: string;
  readonly description: string;
  readonly placeholder: string;
  readonly keyPrefixHint?: string;
  readonly consoleUrl: string;
  readonly defaultModel: string;
  readonly availableModels: readonly string[];
}

export const AI_PROVIDER_METADATA: Record<AiProvider, AiProviderMeta> = {
  chatgpt: {
    id: "chatgpt",
    name: "OpenAI ChatGPT",
    description: "GPT-4o, GPT-4.5, and o-series reasoning models (o3, o3-mini, o1)",
    placeholder: "sk-proj-...",
    keyPrefixHint: "sk-",
    consoleUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4o",
    availableModels: [
      "gpt-4o",
      "gpt-4o-mini",
      "o3-mini",
      "o3",
      "o1",
      "gpt-4.5-preview",
    ],
  },
  claude: {
    id: "claude",
    name: "Anthropic Claude",
    description: "Claude 3.7 Sonnet (hybrid reasoning), Claude 3.5 Sonnet, and Haiku",
    placeholder: "sk-ant-api03-...",
    keyPrefixHint: "sk-ant-",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-3-7-sonnet-20250219",
    availableModels: [
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ],
  },
  grok: {
    id: "grok",
    name: "xAI Grok",
    description: "Grok 3, Grok 3 Mini, and Grok 2 models with extended reasoning",
    placeholder: "xai-...",
    keyPrefixHint: "xai-",
    consoleUrl: "https://console.x.ai/",
    defaultModel: "grok-3",
    availableModels: [
      "grok-3",
      "grok-3-mini",
      "grok-2-latest",
      "grok-2-vision-1212",
      "grok-beta",
    ],
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    description: "Gemini 3.8 Flash, 3.7 Flash, 3.1 Pro, and 2.5 Pro reasoning models",
    placeholder: "AQ... or AIza...",
    keyPrefixHint: "AQ. or AIza",
    consoleUrl: "https://aistudio.google.com/app/apikey",
    defaultModel: "gemini-3.8-flash",
    availableModels: [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-thinking-exp",
    ],
  },
};

/** Safe summary of a single provider returned to the UI */
export interface AiProviderStatus {
  provider: AiProvider;
  configured: boolean;
  /** Masked key representation, e.g. "sk-...4a2b" or undefined if unconfigured */
  maskedKey?: string;
  selectedModel?: string;
  updatedAt?: string;
  lastTestedAt?: string;
  lastTestStatus?: "ok" | "error";
  lastTestError?: string;
}

/** Global configuration summary sent to UI */
export interface AiConfigSummary {
  activeProvider?: AiProvider;
  providers: Record<AiProvider, AiProviderStatus>;
}

/** Mutation payload to save or update provider settings */
export interface SaveAiConfigRequest {
  provider: AiProvider;
  /** Plaintext key provided when updating or setting new key */
  apiKey?: string;
  selectedModel?: string;
  /** If true, immediately set this provider as the active engine */
  setActive?: boolean;
}

/** Payload to delete a configured key */
export interface DeleteAiConfigRequest {
  provider: AiProvider;
}

/** Payload to test a key (either newly input or previously stored) */
export interface ValidateAiKeyRequest {
  provider: AiProvider;
  /** If omitted, tests the currently stored key */
  apiKey?: string;
}

/** Result of a key validation probe */
export interface AiValidationResult {
  provider: AiProvider;
  ok: boolean;
  message: string;
  testedModel?: string;
  latencyMs?: number;
}
