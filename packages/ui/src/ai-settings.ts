import type {
  AiConfigSummary,
  AiProvider,
  AiValidationResult,
} from "@adam/core";
import {
  AI_PROVIDERS,
  AI_PROVIDER_METADATA,
} from "@adam/core/src/ai-types";
import { validateApiKeyFormat } from "@adam/core/src/ai-utils";
import { h } from "./dom";
import type { Host } from "./host";

export interface AiButtonInfo {
  label: string;
  isActive: boolean;
  provider?: AiProvider;
}

/** Get human-friendly display name for provider */
export function getProviderDisplayName(provider: AiProvider): string {
  if (provider === "gemini") return "Google Gemini / Antigravity";
  return AI_PROVIDER_METADATA[provider]?.name ?? provider;
}

/** Get short provider name for compact badge */
export function getProviderShortName(provider: AiProvider): string {
  switch (provider) {
    case "chatgpt":
      return "ChatGPT";
    case "claude":
      return "Claude";
    case "grok":
      return "Grok";
    case "gemini":
      return "Gemini";
  }
}

/** Compute the button label & status for the header toolbar */
export function getAiButtonInfo(summary?: AiConfigSummary): AiButtonInfo {
  if (!summary) {
    return { label: "✨ Configure AI", isActive: false };
  }

  const active = summary.activeProvider;
  if (active && summary.providers?.[active]?.configured) {
    const name = getProviderShortName(active);
    return {
      label: `✨ ${name} (Active)`,
      isActive: true,
      provider: active,
    };
  }

  // If no active provider set or configured, check if any provider is configured
  const configured = (AI_PROVIDERS as readonly AiProvider[]).find(
    (p) => summary.providers?.[p]?.configured,
  );
  if (configured) {
    const name = getProviderShortName(configured);
    return {
      label: `✨ ${name}`,
      isActive: false,
      provider: configured,
    };
  }

  return { label: "✨ Configure AI", isActive: false };
}

let activeModalBackdrop: HTMLElement | null = null;

/** Close any currently open AI settings dialog */
export function closeAiSettingsDialog(): void {
  if (activeModalBackdrop) {
    activeModalBackdrop.remove();
    activeModalBackdrop = null;
  }
}

/**
 * Opens the accessible AI Settings dialog.
 */
export async function openAiSettingsDialog(
  host: Host,
  onConfigChange?: (summary: AiConfigSummary) => void,
): Promise<HTMLElement> {
  // If already open, close it first
  closeAiSettingsDialog();

  const prevActiveElement = document.activeElement as HTMLElement | null;

  // Load current configuration
  let summary: AiConfigSummary;
  try {
    summary = await host.getAiConfig();
  } catch {
    summary = {
      activeProvider: undefined,
      providers: {
        chatgpt: { provider: "chatgpt", configured: false },
        claude: { provider: "claude", configured: false },
        grok: { provider: "grok", configured: false },
        gemini: { provider: "gemini", configured: false },
      },
    };
  }

  // Determine initial selected provider tab
  let currentProvider: AiProvider =
    summary.activeProvider ??
    (AI_PROVIDERS.find((p) => summary.providers?.[p]?.configured) ?? "chatgpt");

  // State
  let enteredKey = "";
  let confirmRemove = false;
  let isTesting = false;
  let isSaving = false;
  let testResult: AiValidationResult | null = null;
  let noticeMessage: string | null = null;
  let noticeType: "success" | "error" = "success";
  let modelsByProvider: Partial<Record<AiProvider, string[]>> = {};
  let modelRefreshState: "idle" | "loading" | "error" | "loaded" = "idle";
  let modelRefreshMessage: string | null = null;

  // Elements
  const backdrop = h("div", { class: "ai-modal-backdrop", role: "presentation" });
  const modal = h("div", {
    class: "ai-modal",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "ai-modal-title",
  });

  const closeDialog = () => {
    window.removeEventListener("keydown", onKeyDown);
    backdrop.remove();
    activeModalBackdrop = null;
    prevActiveElement?.focus?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeDialog();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeDialog();
  });

  const titleEl = h("h2", { id: "ai-modal-title", class: "ai-modal-title" }, "🤖 AI Provider & Keys");
  const closeBtn = h(
    "button",
    {
      class: "ai-modal-close",
      "aria-label": "Close dialog",
      title: "Close (Esc)",
      onclick: () => closeDialog(),
    },
    "✕",
  );

  const headerEl = h("header", { class: "ai-modal-header" }, titleEl, closeBtn);

  const securityBanner = h(
    "div",
    { class: "ai-security-banner" },
    h("span", { class: "ai-security-icon", "aria-hidden": "true" }, "🛡️"),
    h(
      "span",
      { class: "ai-security-text" },
      "Stored locally and safely. Your API key is stored in VS Code SecretStorage and is sent only to the selected provider. When you run a scan, the selected file’s source code and analysis context are sent to that provider. Do not scan confidential code unless your provider’s data-handling terms permit it.",
    ),
  );

  const tabsContainer = h("div", { class: "ai-providers-grid", role: "tablist", "aria-label": "AI Providers" });
  const detailPanel = h("div", { class: "ai-provider-detail", role: "tabpanel" });

  const modalBody = h("div", { class: "ai-modal-body" }, securityBanner, tabsContainer, detailPanel);
  modal.append(headerEl, modalBody);
  backdrop.append(modal);
  document.body.append(backdrop);
  activeModalBackdrop = backdrop;

  // Render provider tabs
  function renderTabs(): void {
    tabsContainer.replaceChildren(
      ...AI_PROVIDERS.map((provider) => {
        const meta = AI_PROVIDER_METADATA[provider];
        const status = summary.providers?.[provider];
        const isSelected = provider === currentProvider;
        const isActive = summary.activeProvider === provider;
        const isConfigured = Boolean(status?.configured);

        const card = h(
          "div",
          {
            class: `ai-provider-card${isSelected ? " selected" : ""}`,
            role: "tab",
            "aria-selected": isSelected ? "true" : "false",
            tabindex: "0",
            onclick: () => {
              if (currentProvider !== provider) {
                currentProvider = provider;
                enteredKey = "";
                confirmRemove = false;
                testResult = null;
                noticeMessage = null;
                renderTabs();
                renderDetail();
              }
            },
            onkeydown: (e: Event) => {
              const ke = e as KeyboardEvent;
              if (ke.key === "Enter" || ke.key === " ") {
                ke.preventDefault();
                (e.currentTarget as HTMLElement).click();
              }
            },
          },
          h(
            "div",
            { class: "ai-card-head" },
            h("span", { class: "ai-card-title" }, getProviderDisplayName(provider)),
            h(
              "div",
              { class: "ai-card-badges" },
              isActive ? h("span", { class: "ai-badge active" }, "Active") : false,
              isConfigured ? h("span", { class: "ai-badge configured" }, "Saved") : false,
            ),
          ),
          h("div", { class: "ai-card-desc" }, meta.description),
          h(
            "div",
            { class: "ai-card-link-row" },
            h(
              "a",
              {
                href: meta.consoleUrl,
                target: "_blank",
                rel: "noopener noreferrer",
                class: "link ai-console-link",
                onclick: (e: Event) => e.stopPropagation(),
              },
              "Get an API key ↗",
            ),
          ),
        );
        return card;
      }),
    );
  }

  // Render detail panel for selected provider
  function renderDetail(): void {
    detailPanel.replaceChildren();

    const provider = currentProvider;
    const meta = AI_PROVIDER_METADATA[provider];
    const status = summary.providers?.[provider];
    const isConfigured = Boolean(status?.configured);
    const isActive = summary.activeProvider === provider;

    // Header with provider name & "Set Active" button
    const setActiveBtn = h(
      "button",
      {
        class: "ghost ai-set-active-btn",
        onclick: async () => {
          try {
            summary = await host.setActiveAiProvider(provider);
            noticeMessage = `✓ ${getProviderDisplayName(provider)} is now the active provider.`;
            noticeType = "success";
            onConfigChange?.(summary);
            renderTabs();
            renderDetail();
          } catch (err) {
            noticeMessage = `Failed to set active provider: ${(err as Error).message}`;
            noticeType = "error";
            renderDetail();
          }
        },
      },
      "★ Set as Active",
    );

    const activeBadge = h("span", { class: "ai-badge active ai-badge-lg" }, "★ Active Provider");

    const detailHeader = h(
      "div",
      { class: "ai-detail-header" },
      h(
        "div",
        {},
        h("h3", { class: "ai-detail-title" }, getProviderDisplayName(provider)),
        h("p", { class: "muted small" }, meta.description),
      ),
      h("div", { class: "ai-detail-header-actions" }, isActive ? activeBadge : setActiveBtn),
    );

    detailPanel.append(detailHeader);

    // Stored Key Display (if configured)
    if (isConfigured) {
      if (confirmRemove) {
        const confirmBox = h(
          "div",
          { class: "ai-confirm-box" },
          h(
            "span",
            { class: "ai-confirm-text" },
            `Are you sure you want to remove the saved API key for ${getProviderDisplayName(provider)}?`,
          ),
          h(
            "div",
            { class: "ai-confirm-actions" },
            h(
              "button",
              {
                class: "ghost danger",
                onclick: async () => {
                  try {
                    summary = await host.deleteAiConfig(provider);
                    confirmRemove = false;
                    enteredKey = "";
                    testResult = null;
                    noticeMessage = `✓ API key removed for ${getProviderDisplayName(provider)}.`;
                    noticeType = "success";
                    onConfigChange?.(summary);
                    renderTabs();
                    renderDetail();
                  } catch (err) {
                    noticeMessage = `Failed to remove key: ${(err as Error).message}`;
                    noticeType = "error";
                    renderDetail();
                  }
                },
              },
              "Yes, Remove Key",
            ),
            h(
              "button",
              {
                class: "ghost",
                onclick: () => {
                  confirmRemove = false;
                  renderDetail();
                },
              },
              "Cancel",
            ),
          ),
        );
        detailPanel.append(confirmBox);
      } else {
        const storedKeyBox = h(
          "div",
          { class: "ai-stored-key-box" },
          h(
            "div",
            { class: "ai-stored-key-info" },
            h("span", { class: "ai-stored-label" }, "Saved Key:"),
            h("code", { class: "ai-masked-key" }, status?.maskedKey ?? "••••••••"),
            h("span", { class: "ai-secure-badge" }, "🔒 Saved safely in OS Keychain / local storage"),
          ),
          h(
            "button",
            {
              class: "ghost danger ai-remove-btn",
              title: "Remove stored key",
              onclick: () => {
                confirmRemove = true;
                renderDetail();
              },
            },
            "Remove Key",
          ),
        );
        detailPanel.append(storedKeyBox);
      }
    }

    // Key Input Group
    const keyLabelText = isConfigured ? "Replace API Key" : "API Key";
    const keyHelpText = isConfigured
      ? "Leave blank to keep your currently stored key."
      : `Enter your ${meta.name} API key.`;

    const keyInput = h("input", {
      type: "password",
      class: "ai-key-input",
      placeholder: meta.placeholder,
      value: enteredKey,
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": `${meta.name} API Key`,
    }) as HTMLInputElement;

    const toggleBtn = h(
      "button",
      {
        type: "button",
        class: "ai-toggle-btn",
        title: "Show API key",
        "aria-label": "Show API key",
        onclick: () => {
          const isPassword = keyInput.type === "password";
          keyInput.type = isPassword ? "text" : "password";
          toggleBtn.textContent = isPassword ? "🙈" : "👁️";
          toggleBtn.title = isPassword ? "Hide API key" : "Show API key";
          toggleBtn.setAttribute("aria-label", isPassword ? "Hide API key" : "Show API key");
        },
      },
      "👁️",
    );

    const formatHintEl = h("div", { class: "ai-format-hint", hidden: true });

    const updateFormatHint = (val: string) => {
      const trimmed = val.trim();
      if (!trimmed) {
        formatHintEl.hidden = true;
        formatHintEl.textContent = "";
        return;
      }
      const check = validateApiKeyFormat(provider, trimmed);
      formatHintEl.hidden = false;
      if (!check.valid) {
        formatHintEl.className = "ai-format-hint warn";
        formatHintEl.textContent = `⚠️ ${check.reason ?? "Invalid format"}`;
      } else {
        formatHintEl.className = "ai-format-hint ok";
        formatHintEl.textContent = `✓ Valid ${meta.name} format`;
      }
    };

    keyInput.addEventListener("input", () => {
      enteredKey = keyInput.value;
      updateFormatHint(enteredKey);
    });

    const keyGroup = h(
      "div",
      { class: "ai-field-group" },
      h(
        "div",
        { class: "ai-field-label-row" },
        h("label", { class: "ai-field-label", for: "ai-key-input" }, keyLabelText),
        h("span", { class: "muted small" }, keyHelpText),
      ),
      h("div", { class: "ai-input-wrapper" }, keyInput, toggleBtn),
      formatHintEl,
    );

    if (enteredKey) updateFormatHint(enteredKey);

    detailPanel.append(keyGroup);

    // Model Selection Dropdown
    const availableModels = modelsByProvider[provider] ?? [...meta.availableModels];
    const isCustomModel = Boolean(status?.selectedModel && !availableModels.includes(status.selectedModel));
    const currentSelectedModel = status?.selectedModel || meta.defaultModel;

    const customModelOption = h(
      "option",
      { value: "__custom__" },
      "Custom model (type below)…",
    ) as HTMLOptionElement;
    if (isCustomModel) customModelOption.selected = true;

    const modelSelect = h(
      "select",
      { class: "ai-model-select", "aria-label": "Select AI Model" },
      ...availableModels.map((m) => {
        const opt = h("option", { value: m }, m);
        if (!isCustomModel && m === currentSelectedModel) (opt as HTMLOptionElement).selected = true;
        return opt;
      }),
      customModelOption,
    ) as HTMLSelectElement;

    const customModelInput = h("input", {
      type: "text",
      class: "ai-custom-model-input",
      placeholder: `Custom model ID (e.g. ${meta.defaultModel})`,
      value: isCustomModel ? currentSelectedModel : "",
      hidden: !isCustomModel,
      "aria-label": "Custom Model Identifier",
    }) as HTMLInputElement;

    modelSelect.addEventListener("change", () => {
      const isCustom = modelSelect.value === "__custom__";
      customModelInput.hidden = !isCustom;
      if (isCustom) {
        customModelInput.focus();
      }
    });

    const refreshModelsBtn = h(
      "button",
      {
        class: "ghost ai-refresh-models-btn",
        type: "button",
        disabled: modelRefreshState === "loading",
        onclick: async () => {
          modelRefreshState = "loading";
          modelRefreshMessage = null;
          renderDetail();
          try {
            const models = await host.listAiModels(provider, enteredKey.trim() || undefined);
            if (models.length === 0) {
              modelsByProvider[provider] = [];
              modelRefreshState = "error";
              modelRefreshMessage = "The provider returned no compatible text-generation models. You can still enter a custom model ID.";
            } else {
              modelsByProvider[provider] = models;
              modelRefreshState = "loaded";
              modelRefreshMessage = `Loaded ${models.length} models from ${meta.name}.`;
            }
          } catch (err) {
            modelRefreshState = "error";
            modelRefreshMessage = (err as Error).message || "Could not refresh models.";
          }
          renderDetail();
        },
      },
      modelRefreshState === "loading" ? "Refreshing…" : "↻ Refresh from provider",
    );
    const modelRefreshStatus = modelRefreshMessage
      ? h("p", { class: `muted small ai-model-refresh-status${modelRefreshState === "error" ? " error" : ""}`, role: "status" }, modelRefreshMessage)
      : h("p", { class: "muted small" }, "Model choices can be refreshed from your provider using your API key.");

    const modelGroup = h(
      "div",
      { class: "ai-field-group" },
      h("label", { class: "ai-field-label" }, "Model"),
      modelSelect,
      customModelInput,
      h("div", { class: "ai-model-refresh-row" }, refreshModelsBtn),
      modelRefreshStatus,
    );
    detailPanel.append(modelGroup);

    // Status / Notice Banner
    if (noticeMessage) {
      const noticeBanner = h(
        "div",
        { class: `ai-notice-callout ${noticeType}` },
        noticeMessage,
      );
      detailPanel.append(noticeBanner);
    }

    // Connection Test Result
    if (isTesting) {
      const testingBanner = h(
        "div",
        { class: "ai-test-callout loading" },
        h("span", { class: "ai-spinner" }, "⏳"),
        ` Validating credentials with ${meta.name}…`,
      );
      detailPanel.append(testingBanner);
    } else if (testResult) {
      const bannerClass = testResult.ok ? "success" : "error";
      const icon = testResult.ok ? "✓" : "✕";
      const latencyText = testResult.latencyMs !== undefined ? ` (${testResult.latencyMs}ms)` : "";
      const resultBanner = h(
        "div",
        { class: `ai-test-callout ${bannerClass}` },
        `${icon} ${testResult.message}${latencyText}`,
      );
      detailPanel.append(resultBanner);
    }

    // Action Buttons
    const testBtn = h(
      "button",
      {
        class: "ghost ai-test-btn",
        onclick: async () => {
          const keyToTest = enteredKey.trim() || undefined;
          if (!keyToTest && !isConfigured) {
            testResult = {
              provider,
              ok: false,
              message: "Please enter an API key to test.",
            };
            renderDetail();
            return;
          }

          isTesting = true;
          testResult = null;
          noticeMessage = null;
          renderDetail();

          try {
            const res = await host.validateAiKey({
              provider,
              apiKey: keyToTest,
            });
            testResult = res;
          } catch (err) {
            testResult = {
              provider,
              ok: false,
              message: (err as Error).message,
            };
          } finally {
            isTesting = false;
            renderDetail();
          }
        },
      },
      "⚡ Test Connection",
    ) as HTMLButtonElement;

    const saveBtn = h(
      "button",
      {
        class: "primary ai-save-btn",
        onclick: async () => {
          const keyToSave = enteredKey.trim();
          if (!keyToSave && !isConfigured) {
            noticeMessage = "Please enter an API key to configure this provider.";
            noticeType = "error";
            renderDetail();
            return;
          }

          isSaving = true;
          noticeMessage = null;
          renderDetail();

          try {
            const chosenModel =
              modelSelect.value === "__custom__"
                ? customModelInput.value.trim() || meta.defaultModel
                : modelSelect.value;

            summary = await host.saveAiConfig({
              provider,
              apiKey: keyToSave || undefined,
              selectedModel: chosenModel,
              setActive: isActive || !summary.activeProvider,
            });
            enteredKey = "";
            noticeMessage = `✓ Configuration saved for ${getProviderDisplayName(provider)}.`;
            noticeType = "success";
            onConfigChange?.(summary);
            renderTabs();
            renderDetail();
          } catch (err) {
            noticeMessage = `Failed to save configuration: ${(err as Error).message}`;
            noticeType = "error";
            renderDetail();
          } finally {
            isSaving = false;
          }
        },
      },
      isSaving ? "Saving…" : "Save",
    ) as HTMLButtonElement;

    const closeFooterBtn = h(
      "button",
      {
        class: "ghost",
        onclick: () => closeDialog(),
      },
      "Close",
    );

    if (isTesting || isSaving) {
      testBtn.disabled = true;
      saveBtn.disabled = true;
    }

    const footer = h(
      "div",
      { class: "ai-modal-footer" },
      h("div", { class: "ai-footer-left" }, testBtn),
      h("div", { class: "ai-footer-right" }, closeFooterBtn, saveBtn),
    );

    detailPanel.append(footer);
  }

  // Initial renders
  renderTabs();
  renderDetail();

  // Focus modal
  closeBtn.focus();

  return backdrop;
}
