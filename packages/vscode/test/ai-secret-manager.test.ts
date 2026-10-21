import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { VsCodeAiSecretManager } from "../src/ai-secret-manager";

class MockSecretStorage implements vscode.SecretStorage {
  private readonly map = new Map<string, string>();
  readonly onDidChange = (() => ({ dispose: () => {} })) as any;

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class MockMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();

  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.has(key) ? (this.store.get(key) as T) : defaultValue);
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }
}

describe("VsCodeAiSecretManager", () => {
  it("initializes empty summary correctly", async () => {
    const secrets = new MockSecretStorage();
    const state = new MockMemento();
    const manager = new VsCodeAiSecretManager(secrets, state);

    const summary = await manager.getConfigSummary();
    expect(summary.activeProvider).toBeUndefined();
    expect(summary.providers.chatgpt.configured).toBe(false);
    expect(summary.providers.claude.configured).toBe(false);
  });

  it("stores and retrieves keys securely", async () => {
    const secrets = new MockSecretStorage();
    const state = new MockMemento();
    const manager = new VsCodeAiSecretManager(secrets, state);

    await manager.saveKey({
      provider: "claude",
      apiKey: "sk-ant-api03-abcdefghijklmn5678",
      selectedModel: "claude-3-7-sonnet-20250219",
    });

    const summary = await manager.getConfigSummary();
    expect(summary.activeProvider).toBe("claude");
    expect(summary.providers.claude.configured).toBe(true);
    expect(summary.providers.claude.maskedKey).toBe("sk-ant-...5678");
    expect(summary.providers.claude.selectedModel).toBe("claude-3-7-sonnet-20250219");

    const raw = await manager.getRawKey("claude");
    expect(raw).toBe("sk-ant-api03-abcdefghijklmn5678");
  });

  it("handles setting active provider and deletion", async () => {
    const secrets = new MockSecretStorage();
    const state = new MockMemento();
    const manager = new VsCodeAiSecretManager(secrets, state);

    await manager.saveKey({
      provider: "chatgpt",
      apiKey: "sk-proj-test1234567890",
    });
    await manager.saveKey({
      provider: "grok",
      apiKey: "xai-test12345678901234",
    });

    await manager.setActiveProvider("grok");
    expect((await manager.getConfigSummary()).activeProvider).toBe("grok");

    await manager.deleteKey("grok");
    const summary = await manager.getConfigSummary();
    expect(summary.activeProvider).toBeUndefined();
    expect(summary.providers.grok.configured).toBe(false);
    expect(await manager.getRawKey("grok")).toBeUndefined();
  });

  it("records probe test results in memento", async () => {
    const secrets = new MockSecretStorage();
    const state = new MockMemento();
    const manager = new VsCodeAiSecretManager(secrets, state);

    await manager.recordTestResult("chatgpt", true);
    let summary = await manager.getConfigSummary();
    expect(summary.providers.chatgpt.lastTestStatus).toBe("ok");
    expect(summary.providers.chatgpt.lastTestedAt).toBeDefined();

    await manager.recordTestResult("chatgpt", false, "Invalid key");
    summary = await manager.getConfigSummary();
    expect(summary.providers.chatgpt.lastTestStatus).toBe("error");
    expect(summary.providers.chatgpt.lastTestError).toBe("Invalid key");
  });
});
