import {
  AI_PROVIDER_METADATA,
  type AiProvider,
  type AiValidationResult,
} from "./ai-types";

/**
 * Safely masks an API key so that only a prefix and suffix remain visible.
 * Keys shorter than 8 characters are completely masked.
 * Example: 'sk-ant-api03-abcdefghijklmn1234' -> 'sk-ant-...1234'
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 8) return "••••••••";

  let prefixLength = 4;
  if (trimmed.startsWith("sk-ant-")) prefixLength = 7;
  else if (trimmed.startsWith("sk-proj-")) prefixLength = 8;
  else if (trimmed.startsWith("xai-")) prefixLength = 4;
  else if (trimmed.startsWith("AQ.")) prefixLength = 5;
  else if (trimmed.startsWith("AIza")) prefixLength = 4;

  if (prefixLength >= trimmed.length - 2) {
    prefixLength = Math.min(4, Math.max(1, trimmed.length - 5));
  }

  const suffixLength = Math.max(1, Math.min(4, Math.floor((trimmed.length - prefixLength) / 2)));
  const prefix = trimmed.slice(0, prefixLength);
  const suffix = trimmed.slice(-suffixLength);
  return `${prefix}...${suffix}`;
}

/**
 * Basic syntactic sanity check before submitting network probe.
 */
export function validateApiKeyFormat(
  provider: AiProvider,
  key: string,
): { valid: boolean; reason?: string } {
  const trimmed = key.trim();
  if (!trimmed) return { valid: false, reason: "API key cannot be empty" };
  if (trimmed.length < 16) return { valid: false, reason: "Key is abnormally short" };

  switch (provider) {
    case "chatgpt":
      if (!trimmed.startsWith("sk-")) return { valid: false, reason: "OpenAI keys typically start with 'sk-'" };
      break;
    case "claude":
      if (!trimmed.startsWith("sk-ant-")) return { valid: false, reason: "Anthropic keys typically start with 'sk-ant-'" };
      break;
    case "grok":
      if (!trimmed.startsWith("xai-")) return { valid: false, reason: "xAI keys typically start with 'xai-'" };
      break;
    case "gemini":
      if (!trimmed.startsWith("AIza") && !trimmed.startsWith("AQ.") && !trimmed.startsWith("AQ")) {
        return { valid: false, reason: "Google API keys typically start with 'AQ.' (AI Studio) or 'AIza'" };
      }
      break;
  }
  return { valid: true };
}

/**
 * Probes the provider's HTTPS endpoint to verify credentials.
 */
export async function probeAiProviderKey(
  provider: AiProvider,
  apiKey: string,
): Promise<AiValidationResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    let url = "";
    const headers: Record<string, string> = {
      "User-Agent": "Adam-Code-Network/1.0",
    };

    switch (provider) {
      case "chatgpt":
        url = "https://api.openai.com/v1/models";
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
        break;
      case "claude":
        url = "https://api.anthropic.com/v1/models";
        headers["x-api-key"] = apiKey.trim();
        headers["anthropic-version"] = "2023-06-01";
        break;
      case "grok":
        url = "https://api.x.ai/v1/models";
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
        break;
      case "gemini":
        url = "https://generativelanguage.googleapis.com/v1beta/models";
        headers["x-goog-api-key"] = apiKey.trim();
        break;
    }

    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      return {
        provider,
        ok: true,
        message: `Successfully authenticated with ${AI_PROVIDER_METADATA[provider].name}.`,
        latencyMs,
      };
    }

    return {
      provider,
      ok: false,
      message: `Provider request failed (HTTP ${res.status}). Check the API key and selected model, then try again.`,
      latencyMs,
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      provider,
      ok: false,
      message: error?.name === "AbortError"
        ? "Connection timed out after 10 seconds."
        : "Provider request failed. Check the API key and network connection, then try again.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
