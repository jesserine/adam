import * as vscode from "vscode";
import {
  AI_PROVIDER_METADATA,
  AI_PROVIDERS,
  maskApiKey,
  type AiConfigSummary,
  type AiProvider,
  type AiProviderStatus,
  type SaveAiConfigRequest,
} from "@adam/core";

export class VsCodeAiSecretManager {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly globalState: vscode.Memento,
  ) {}

  async getConfigSummary(): Promise<AiConfigSummary> {
    const activeProvider = this.globalState.get<AiProvider>("adam.ai.activeProvider");
    const providers = {} as Record<AiProvider, AiProviderStatus>;

    for (const provider of AI_PROVIDERS) {
      const raw = await this.secrets.get(`adam.ai.key.${provider}`);
      const meta = this.globalState.get<Partial<AiProviderStatus>>(`adam.ai.meta.${provider}`) ?? {};
      providers[provider] = {
        provider,
        configured: Boolean(raw),
        maskedKey: raw ? maskApiKey(raw) : undefined,
        selectedModel: meta.selectedModel ?? AI_PROVIDER_METADATA[provider].defaultModel,
        updatedAt: meta.updatedAt,
        lastTestedAt: meta.lastTestedAt,
        lastTestStatus: meta.lastTestStatus,
        lastTestError: meta.lastTestError,
      };
    }

    return { activeProvider, providers };
  }

  async saveKey(req: SaveAiConfigRequest): Promise<void> {
    if (req.apiKey !== undefined && req.apiKey.trim().length > 0) {
      await this.secrets.store(`adam.ai.key.${req.provider}`, req.apiKey.trim());
    }
    const meta = this.globalState.get<Record<string, unknown>>(`adam.ai.meta.${req.provider}`) ?? {};
    meta.updatedAt = new Date().toISOString();
    if (req.selectedModel) {
      meta.selectedModel = req.selectedModel;
    }
    await this.globalState.update(`adam.ai.meta.${req.provider}`, meta);

    if (req.setActive || !this.globalState.get("adam.ai.activeProvider")) {
      await this.globalState.update("adam.ai.activeProvider", req.provider);
    }
  }

  async deleteKey(provider: AiProvider): Promise<void> {
    await this.secrets.delete(`adam.ai.key.${provider}`);
    await this.globalState.update(`adam.ai.meta.${provider}`, undefined);
    if (this.globalState.get("adam.ai.activeProvider") === provider) {
      await this.globalState.update("adam.ai.activeProvider", undefined);
    }
  }

  async setActiveProvider(provider: AiProvider): Promise<void> {
    await this.globalState.update("adam.ai.activeProvider", provider);
  }

  async getRawKey(provider: AiProvider): Promise<string | undefined> {
    return this.secrets.get(`adam.ai.key.${provider}`);
  }

  async recordTestResult(
    provider: AiProvider,
    ok: boolean,
    error?: string,
  ): Promise<void> {
    const meta = this.globalState.get<Record<string, unknown>>(`adam.ai.meta.${provider}`) ?? {};
    meta.lastTestedAt = new Date().toISOString();
    meta.lastTestStatus = ok ? "ok" : "error";
    meta.lastTestError = error;
    await this.globalState.update(`adam.ai.meta.${provider}`, meta);
  }
}
