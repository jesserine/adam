import {
  AI_PROVIDER_METADATA,
  type AiProvider,
  type AiValidationResult,
} from "./ai-types";

/**
 * Fetches models available to the supplied API key. Requests are made by the extension host;
 * callers must never forward API keys to the UI or persist them as part of this result.
 */
export async function listAiProviderModels(
  provider: AiProvider,
  apiKey: string,
): Promise<string[]> {
  const key = apiKey.trim();
  if (!key) throw new Error("An API key is required to list models.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const headers: Record<string, string> = { "User-Agent": "Adam-Code-Network/1.0" };

  try {
    let url: string;
    switch (provider) {
      case "chatgpt":
        url = "https://api.openai.com/v1/models";
        headers.Authorization = `Bearer ${key}`;
        break;
      case "claude":
        url = "https://api.anthropic.com/v1/models?limit=1000";
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
        break;
      case "grok":
        url = "https://api.x.ai/v1/models";
        headers.Authorization = `Bearer ${key}`;
        break;
      case "gemini":
        url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
        headers["x-goog-api-key"] = key;
        break;
    }

    const ids = new Set<string>();
    let nextUrl: string | undefined = url;
    let pageCount = 0;
    while (nextUrl && pageCount < 10) {
      const response = await fetch(nextUrl, { method: "GET", headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Model listing failed (HTTP ${response.status}). Check the API key and provider access.`);
      }
      const payload = await response.json() as {
        data?: Array<{ id?: string }>;
        models?: Array<{ name?: string; baseModelId?: string; supportedGenerationMethods?: string[] }>;
        has_more?: boolean;
        last_id?: string | null;
        nextPageToken?: string;
      };

      if (provider === "gemini") {
        for (const model of payload.models ?? []) {
          if (!model.supportedGenerationMethods?.includes("generateContent")) continue;
          const id = model.baseModelId || model.name?.replace(/^models\//, "");
          if (id && /^gemini-/i.test(id) && !/(embedding|aqa|tts|transcri|image|robotics|computer-use|live|audio|veo)/i.test(id)) ids.add(id);
        }
        nextUrl = payload.nextPageToken
          ? `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=${encodeURIComponent(payload.nextPageToken)}`
          : undefined;
      } else {
        for (const model of payload.data ?? []) {
          const id = model.id;
          if (!id) continue;
          if (provider === "claude" && /^claude-/i.test(id)) ids.add(id);
          if (provider === "chatgpt" &&
            /^(gpt-|chatgpt-|o[1-9](?:-|$))/i.test(id) &&
            !/(embedding|audio|transcri|tts|realtime|image|moderation|search|computer-use|codex-mini-latest)/i.test(id)) ids.add(id);
          if (provider === "grok" && /^grok-/i.test(id) &&
            !/(imagine|image|video|voice|audio|transcri|tts)/i.test(id)) ids.add(id);
        }

        if (provider === "claude" && payload.has_more && payload.last_id) {
          const separator = url.includes("?") ? "&" : "?";
          nextUrl = `https://api.anthropic.com/v1/models?limit=1000&after_id=${encodeURIComponent(payload.last_id)}`;
        } else {
          nextUrl = undefined;
        }
      }
      pageCount++;
    }

    return [...ids].sort((a, b) => a.localeCompare(b));
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("Model listing failed")) throw err;
    throw new Error(err instanceof Error && err.name === "AbortError"
      ? "Model listing timed out after 10 seconds."
      : "Could not retrieve models from the provider. Check the API key and network connection.");
  } finally {
    clearTimeout(timeout);
  }
}

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
