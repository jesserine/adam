import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeThreatReport } from "@adam/core";
import { createBrowserHost, createVsCodeHost, type VsCodeApi } from "../src/host";

describe("Host threat analysis wiring", () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as any).window;
  const originalLocation = (globalThis as any).location;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).window = originalWindow;
    (globalThis as any).location = originalLocation;
  });

  it("wires analyzeNodeThreats in createVsCodeHost", async () => {
    const listeners: Array<(e: any) => void> = [];
    (globalThis as any).window = {
      addEventListener: (type: string, listener: (e: any) => void) => {
        if (type === "message") listeners.push(listener);
      },
    };

    let sentMessage: any;
    const api: VsCodeApi = {
      postMessage: (msg) => {
        sentMessage = msg;
        if (msg.type !== "request") return;
        const msgId = msg.id;
        // Simulate extension reply
        setTimeout(() => {
          listeners.forEach((l) =>
            l({
              data: {
                type: "response",
                id: msgId,
                ok: true,
                result: {
                  nodeId: "src/index.ts",
                  provider: "chatgpt",
                  model: "gpt-4o",
                  analyzedAt: new Date().toISOString(),
                  summary: "No threats",
                  threats: [],
                  overallRisk: "info",
                  masked: false,
                  redactions: 0,
                } as NodeThreatReport,
              },
            }),
          );
        }, 0);
      },
    };

    const host = createVsCodeHost(api);
    expect(host.kind).toBe("vscode");

    const report = await host.analyzeNodeThreats({ nodeId: "src/index.ts" });

    expect(sentMessage.type).toBe("request");
    expect(sentMessage.method).toBe("ai:analyzeThreats");
    expect(sentMessage.params).toEqual({ nodeId: "src/index.ts" });
    expect(report.nodeId).toBe("src/index.ts");
    expect(report.overallRisk).toBe("info");
  });

  it("wires analyzeNodeThreats in createBrowserHost", async () => {
    (globalThis as any).location = { hash: "#token=test-token-123" };

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          nodeId: "src/server.ts",
          provider: "gemini",
          model: "gemini-3.8-flash",
          analyzedAt: new Date().toISOString(),
          summary: "Threat found",
          threats: [
            {
              id: "THREAT-1",
              title: "Path Traversal",
              category: "injection",
              severity: "high",
              description: "User input reaches fs.readFile",
              recommendation: "Validate path",
            },
          ],
          overallRisk: "high",
          masked: false,
          redactions: 0,
        }),
      } as unknown as Response;
    });

    const host = createBrowserHost();
    expect(host.kind).toBe("browser");

    const report = await host.analyzeNodeThreats({ nodeId: "src/server.ts" });

    expect(capturedUrl).toBe("/api/ai/threats");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)?.["Authorization"]).toBe("Bearer test-token-123");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ nodeId: "src/server.ts" });
    expect(report.nodeId).toBe("src/server.ts");
    expect(report.overallRisk).toBe("high");
  });
});
