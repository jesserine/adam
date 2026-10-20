import { describe, expect, it, vi } from "vitest";
import {
  maskApiKey,
  probeAiProviderKey,
  validateApiKeyFormat,
  type AiProvider,
} from "../src";

describe("maskApiKey", () => {
  it("masks keys shorter than 8 characters completely", () => {
    expect(maskApiKey("")).toBe("••••••••");
    expect(maskApiKey("short")).toBe("••••••••");
    expect(maskApiKey("1234567")).toBe("••••••••");
  });

  it("masks OpenAI keys with sk-proj- and sk- prefixes", () => {
    const key1 = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    const masked1 = maskApiKey(key1);
    expect(masked1).toBe("sk-proj-...wxyz");
    expect(masked1.length).toBeLessThan(key1.length);
    expect(masked1).not.toContain("abcdefgh");

    const key2 = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
    const masked2 = maskApiKey(key2);
    expect(masked2).toBe("sk-1...wxyz");
  });

  it("masks Anthropic keys with sk-ant- prefix", () => {
    const key = "sk-ant-api03-abcdefghijklmn1234";
    const masked = maskApiKey(key);
    expect(masked).toBe("sk-ant-...1234");
    expect(masked).not.toContain("api03");
  });

  it("masks xAI keys with xai- prefix", () => {
    const key = "xai-abcdefghijklmnopqrstuvwxyz1234";
    const masked = maskApiKey(key);
    expect(masked).toBe("xai-...1234");
  });

  it("masks Google Gemini keys with AIza or AQ. prefix", () => {
    const key1 = "AIzaSyDummyKeyForGoogleTesting5678";
    const masked1 = maskApiKey(key1);
    expect(masked1).toBe("AIza...5678");

    const key2 = "AQ.Ab8RN6ILHd1234567890abcdef";
    const masked2 = maskApiKey(key2);
    expect(masked2).toBe("AQ.Ab...cdef");
  });

  it("masks generic keys properly", () => {
    const key = "customkey-1234567890abcdef";
    const masked = maskApiKey(key);
    expect(masked).toBe("cust...cdef");
  });
});

describe("validateApiKeyFormat", () => {
  it("rejects empty or whitespace-only keys", () => {
    expect(validateApiKeyFormat("chatgpt", "")).toEqual({
      valid: false,
      reason: "API key cannot be empty",
    });
    expect(validateApiKeyFormat("claude", "   ")).toEqual({
      valid: false,
      reason: "API key cannot be empty",
    });
  });

  it("rejects keys shorter than 16 characters", () => {
    expect(validateApiKeyFormat("chatgpt", "sk-short")).toEqual({
      valid: false,
      reason: "Key is abnormally short",
    });
  });

  it("validates provider-specific prefixes", () => {
    const providers: Array<{ provider: AiProvider; valid: string; invalid: string }> = [
      {
        provider: "chatgpt",
        valid: "sk-proj-12345678901234567890",
        invalid: "wrong-12345678901234567890",
      },
      {
        provider: "claude",
        valid: "sk-ant-api03-1234567890123456",
        invalid: "sk-other-1234567890123456",
      },
      {
        provider: "grok",
        valid: "xai-12345678901234567890",
        invalid: "sk-xai-1234567890123456",
      },
      {
        provider: "gemini",
        valid: "AIzaSy12345678901234567890",
        invalid: "google-1234567890123456",
      },
    ];

    expect(validateApiKeyFormat("gemini", "AQ.Ab8RN6ILHd1234567890")).toEqual({ valid: true });

    for (const { provider, valid, invalid } of providers) {
      expect(validateApiKeyFormat(provider, valid)).toEqual({ valid: true });
      const res = validateApiKeyFormat(provider, invalid);
      expect(res.valid).toBe(false);
      expect(res.reason).toBeDefined();
    }
  });
});

describe("probeAiProviderKey", () => {
  it("returns ok=true when endpoint responds with 200", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as unknown as Response);

    try {
      const res = await probeAiProviderKey("chatgpt", "sk-proj-testkey1234567890");
      expect(res.ok).toBe(true);
      expect(res.provider).toBe("chatgpt");
      expect(res.message).toContain("Successfully authenticated with OpenAI ChatGPT");
      expect(res.latencyMs).toBeTypeOf("number");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns ok=false with error message when provider returns error", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: { message: "Incorrect API key provided" } }),
    } as unknown as Response);

    try {
      const res = await probeAiProviderKey("claude", "sk-ant-testkey1234567890");
      expect(res.ok).toBe(false);
      expect(res.provider).toBe("claude");
      expect(res.message).toBe("Provider request failed (HTTP 401). Check the API key and selected model, then try again.");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles network failure or timeout gracefully", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("Network connection refused"));

    try {
      const res = await probeAiProviderKey("grok", "xai-testkey1234567890");
      expect(res.ok).toBe(false);
      expect(res.provider).toBe("grok");
      expect(res.message).toBe("Provider request failed. Check the API key and network connection, then try again.");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
