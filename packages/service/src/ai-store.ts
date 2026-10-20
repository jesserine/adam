import * as fs from "node:fs";
import * as path from "node:path";
import {
  AI_PROVIDER_METADATA,
  AI_PROVIDERS,
  maskApiKey,
  type AiConfigSummary,
  type AiProvider,
  type AiProviderStatus,
  type SaveAiConfigRequest,
} from "@adam/core";

export interface DiskAiConfigFile {
  version: 1;
  activeProvider?: AiProvider;
  providers: {
    [key in AiProvider]?: {
      encryptedOrRawKey: string;
      selectedModel?: string;
      updatedAt: string;
      lastTestedAt?: string;
      lastTestStatus?: "ok" | "error";
      lastTestError?: string;
    };
  };
}

export class AiConfigStore {
  readonly filePath: string;

  constructor(rootDirOrPath: string) {
    if (rootDirOrPath.endsWith(".json")) {
      this.filePath = path.resolve(rootDirOrPath);
    } else {
      this.filePath = path.resolve(rootDirOrPath, ".adam", "ai-config.json");
    }
  }

  private readDisk(): DiskAiConfigFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as DiskAiConfigFile;
        if (parsed && parsed.version === 1 && typeof parsed.providers === "object") {
          return parsed;
        }
      }
    } catch {
      // Missing or corrupt file: initialize a fresh configuration
    }
    return { version: 1, providers: {} };
  }

  private writeDisk(data: DiskAiConfigFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.filePath);
    } finally {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  async getConfigSummary(): Promise<AiConfigSummary> {
    const disk = this.readDisk();
    const providers = {} as Record<AiProvider, AiProviderStatus>;

    for (const provider of AI_PROVIDERS) {
      const stored = disk.providers[provider];
      const hasKey = Boolean(stored?.encryptedOrRawKey);
      providers[provider] = {
        provider,
        configured: hasKey,
        maskedKey: stored?.encryptedOrRawKey ? maskApiKey(stored.encryptedOrRawKey) : undefined,
        selectedModel: stored?.selectedModel ?? AI_PROVIDER_METADATA[provider].defaultModel,
        updatedAt: stored?.updatedAt,
        lastTestedAt: stored?.lastTestedAt,
        lastTestStatus: stored?.lastTestStatus,
        lastTestError: stored?.lastTestError,
      };
    }

    return {
      activeProvider: disk.activeProvider,
      providers,
    };
  }

  async saveKey(req: SaveAiConfigRequest): Promise<AiConfigSummary> {
    const disk = this.readDisk();
    const existing = disk.providers[req.provider] ?? {
      encryptedOrRawKey: "",
      updatedAt: new Date().toISOString(),
    };

    if (req.apiKey !== undefined && req.apiKey.trim().length > 0) {
      existing.encryptedOrRawKey = req.apiKey.trim();
    }
    existing.updatedAt = new Date().toISOString();
    if (req.selectedModel) {
      existing.selectedModel = req.selectedModel;
    }

    disk.providers[req.provider] = existing;

    if (req.setActive || !disk.activeProvider) {
      disk.activeProvider = req.provider;
    }

    this.writeDisk(disk);
    return this.getConfigSummary();
  }

  async deleteKey(provider: AiProvider): Promise<AiConfigSummary> {
    const disk = this.readDisk();
    delete disk.providers[provider];

    if (disk.activeProvider === provider) {
      disk.activeProvider = undefined;
    }

    this.writeDisk(disk);
    return this.getConfigSummary();
  }

  async setActiveProvider(provider: AiProvider): Promise<AiConfigSummary> {
    const disk = this.readDisk();
    disk.activeProvider = provider;
    this.writeDisk(disk);
    return this.getConfigSummary();
  }

  async getRawKey(provider: AiProvider): Promise<string | undefined> {
    const disk = this.readDisk();
    return disk.providers[provider]?.encryptedOrRawKey;
  }

  async recordTestResult(
    provider: AiProvider,
    ok: boolean,
    error?: string,
  ): Promise<AiConfigSummary> {
    const disk = this.readDisk();
    const existing = disk.providers[provider];
    if (existing) {
      existing.lastTestedAt = new Date().toISOString();
      existing.lastTestStatus = ok ? "ok" : "error";
      existing.lastTestError = error;
      this.writeDisk(disk);
    }
    return this.getConfigSummary();
  }
}
