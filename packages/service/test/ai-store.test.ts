import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiConfigStore } from "../src/ai-store";

describe("AiConfigStore", () => {
  let tmpDir: string;
  let store: AiConfigStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adam-ai-store-"));
    store = new AiConfigStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns default summary when file does not exist", async () => {
    const summary = await store.getConfigSummary();
    expect(summary.activeProvider).toBeUndefined();
    expect(summary.providers.chatgpt.configured).toBe(false);
    expect(summary.providers.claude.configured).toBe(false);
    expect(summary.providers.grok.configured).toBe(false);
    expect(summary.providers.gemini.configured).toBe(false);
  });

  it("recovers gracefully from a corrupted JSON file", async () => {
    const filePath = path.join(tmpDir, ".adam", "ai-config.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "invalid json {[[", "utf8");

    const summary = await store.getConfigSummary();
    expect(summary.activeProvider).toBeUndefined();
    expect(summary.providers.claude.configured).toBe(false);
  });

  it("saves a key, updates model, and masks the key in summary", async () => {
    const rawKey = "sk-ant-api03-abcdefghijklmn9876";
    const summary = await store.saveKey({
      provider: "claude",
      apiKey: rawKey,
      selectedModel: "claude-3-5-sonnet-20241022",
      setActive: true,
    });

    expect(summary.activeProvider).toBe("claude");
    expect(summary.providers.claude.configured).toBe(true);
    expect(summary.providers.claude.maskedKey).toBe("sk-ant-...9876");
    expect(summary.providers.claude.selectedModel).toBe("claude-3-5-sonnet-20241022");
    expect(summary.providers.claude.updatedAt).toBeDefined();

    // Verify raw key on disk vs getRawKey
    const retrievedRaw = await store.getRawKey("claude");
    expect(retrievedRaw).toBe(rawKey);

    const onDisk = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    expect(onDisk.providers.claude.encryptedOrRawKey).toBe(rawKey);
  });

  it("manages active provider and deletion", async () => {
    await store.saveKey({
      provider: "chatgpt",
      apiKey: "sk-proj-test1234567890",
    });
    await store.saveKey({
      provider: "grok",
      apiKey: "xai-test12345678901234",
    });

    expect((await store.getConfigSummary()).activeProvider).toBe("chatgpt");

    await store.setActiveProvider("grok");
    expect((await store.getConfigSummary()).activeProvider).toBe("grok");

    // Delete active provider
    const afterDelete = await store.deleteKey("grok");
    expect(afterDelete.activeProvider).toBeUndefined();
    expect(afterDelete.providers.grok.configured).toBe(false);
    expect(afterDelete.providers.chatgpt.configured).toBe(true);
  });

  it("records validation test results", async () => {
    await store.saveKey({
      provider: "gemini",
      apiKey: "AIzaSyTestKey12345678",
    });

    await store.recordTestResult("gemini", true);
    let summary = await store.getConfigSummary();
    expect(summary.providers.gemini.lastTestStatus).toBe("ok");
    expect(summary.providers.gemini.lastTestedAt).toBeDefined();
    expect(summary.providers.gemini.lastTestError).toBeUndefined();

    await store.recordTestResult("gemini", false, "Quota exceeded");
    summary = await store.getConfigSummary();
    expect(summary.providers.gemini.lastTestStatus).toBe("error");
    expect(summary.providers.gemini.lastTestError).toBe("Quota exceeded");
  });
});
