import * as path from "node:path";
import { maskJsonSettings, maskXmlSettings } from "./settings-mask";

export const MASK = "••••••••";

/**
 * How a sensitive node is shown: `env` and `json`/`xml` settings keep their keys and lose every
 * value (engineers still see what they must request), `withhold` hides the whole file.
 */
export type MaskStyle = "env" | "json" | "xml" | "withhold";

interface NameRule {
  test: (base: string, relPath: string) => boolean;
  reason: string;
  style: MaskStyle;
}

const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"];

const NAME_RULES: NameRule[] = [
  {
    test: (b) => (b === ".env" || b.startsWith(".env.")) && !TEMPLATE_SUFFIXES.some((s) => b.endsWith(s)),
    reason: "Environment file: values are secrets or machine-specific config",
    style: "env",
  },
  { test: (b) => /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg)$/i.test(b), reason: "Key or certificate file", style: "withhold" },
  { test: (b) => /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(b), reason: "SSH key", style: "withhold" },
  { test: (b) => /^appsettings(\..+)?\.json$/i.test(b), reason: ".NET app settings: values can hold connection strings and keys", style: "json" },
  { test: (b) => /^local\.settings\.json$/i.test(b), reason: "Azure Functions local settings", style: "json" },
  { test: (b) => /^secrets\.json$/i.test(b), reason: ".NET user secrets", style: "json" },
  {
    test: (b) => /^(web|app)(\..+)?\.config$/i.test(b) || /^connectionstrings(\..+)?\.config$/i.test(b),
    reason: ".NET config: connection strings and app settings",
    style: "xml",
  },
  { test: (b) => /^(credentials|secrets?)(\..+)?$/i.test(b), reason: "Credentials file", style: "withhold" },
  { test: (b) => /service[-_]?account.*\.json$/i.test(b), reason: "Cloud service account key", style: "withhold" },
  { test: (b) => b === ".npmrc" || b === ".pypirc" || b === ".netrc", reason: "Package registry credentials", style: "withhold" },
  { test: (b) => /\.tfvars$/i.test(b), reason: "Infrastructure variables", style: "env" },
  { test: (b) => b === "terraform.tfstate", reason: "Infrastructure state", style: "withhold" },
];

function ruleFor(relPath: string): NameRule | undefined {
  const base = path.posix.basename(relPath);
  return NAME_RULES.find((r) => r.test(base, relPath));
}

/** Returns why a file must be treated as a sensitive node, or undefined when it is ordinary. */
export function sensitiveReason(relPath: string): string | undefined {
  return ruleFor(relPath)?.reason;
}

/** How a sensitive node is masked, or undefined when the file is ordinary. */
export function maskStyle(relPath: string): MaskStyle | undefined {
  return ruleFor(relPath)?.style;
}

interface SecretPattern {
  name: string;
  /** With two capture groups, group 1 is kept as context and only group 2 (the secret) is masked. */
  regex: RegExp;
}

/**
 * High-confidence patterns for secrets pasted into ordinary files.
 * Kept conservative: a false positive hides code, a false negative is what we guard against.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "AWS access key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: "Slack token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Stripe secret key", regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { name: "API key", regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "JWT", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: "connection string password",
    regex: /(\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s/'"]+:)([^@\s'"]+)(?=@)/g,
  },
  {
    // ADO.NET and Azure connection strings: `Server=db;User Id=sa;Password=...;`, `AccountKey=...`.
    // Anchored to a `;` or quote on the same line so `Password = input;` in code is left alone.
    name: "connection string secret",
    regex: /([;"'][ \t]*(?:Password|Pwd|AccountKey|SharedAccessKey|SharedSecret|ClientSecret|Client Secret)[ \t]*=[ \t]*)(?![{$])([^;"'\s<>]{3,})/gi,
  },
];

/** Counts secret-looking values in ordinary file content. */
export function countSecrets(content: string): number {
  let count = 0;
  for (const { regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    count += content.match(regex)?.length ?? 0;
  }
  return count;
}

/** Replaces secret-looking values with a mask, keeping the surrounding code readable. */
export function redactSecrets(content: string): string {
  let out = content;
  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    out = out.replace(regex, (match: string, prefix?: unknown, secret?: unknown) =>
      typeof prefix === "string" && typeof secret === "string" ? `${prefix}${MASK}` : `${MASK} (${name})`,
    );
  }
  return out;
}

/**
 * Masks a sensitive node for display. Env-style files and .NET settings keep their keys (so
 * engineers can see what they need to request) and lose every value. Anything else, and any
 * settings file that cannot be read cleanly, is withheld entirely.
 */
export function maskSensitive(relPath: string, content: string): string {
  const withheld = `${MASK}\n\nThis node is sensitive (${sensitiveReason(relPath) ?? "protected file"}). Its content is never shown or sent to a model.`;
  switch (maskStyle(relPath) ?? "withhold") {
    case "env":
      return maskEnv(content);
    case "json":
      try {
        return maskJsonSettings(content, MASK).content;
      } catch {
        return withheld;
      }
    case "xml":
      return maskXmlSettings(content, MASK).content;
    default:
      return withheld;
  }
}

/** Lists the keys a sensitive settings file declares, without their values. Empty for withheld files. */
export function declaredKeys(relPath: string, content: string): string[] {
  switch (maskStyle(relPath)) {
    case "env":
      return envKeys(content);
    case "json":
      try {
        return maskJsonSettings(content, MASK).keys;
      } catch {
        return [];
      }
    case "xml":
      return maskXmlSettings(content, MASK).keys;
    default:
      return [];
  }
}

function maskEnv(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const m = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=)\s*(.*)$/.exec(line);
      if (!m) return line.trim().startsWith("#") || line.trim() === "" ? line : MASK;
      return m[2] === "" ? line : `${m[1]} ${MASK}`;
    })
    .join("\n");
}

/** Lists the variable names an env-style file declares, without their values. */
export function envKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}
