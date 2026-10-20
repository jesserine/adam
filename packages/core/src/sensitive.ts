import * as path from "node:path";

export const MASK = "••••••••";

interface NameRule {
  test: (base: string, relPath: string) => boolean;
  reason: string;
}

const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"];

const NAME_RULES: NameRule[] = [
  {
    test: (b) => (b === ".env" || b.startsWith(".env.")) && !TEMPLATE_SUFFIXES.some((s) => b.endsWith(s)),
    reason: "Environment file: values are secrets or machine-specific config",
  },
  { test: (b) => /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg)$/i.test(b), reason: "Key or certificate file" },
  { test: (b) => /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(b), reason: "SSH key" },
  { test: (b) => /^(credentials|secrets?)(\..+)?$/i.test(b), reason: "Credentials file" },
  { test: (b) => /service[-_]?account.*\.json$/i.test(b), reason: "Cloud service account key" },
  { test: (b) => /^appsettings\.(?!Development\.json$).+\.json$/i.test(b), reason: "Environment-specific app settings" },
  { test: (b) => b === ".npmrc" || b === ".pypirc" || b === ".netrc", reason: "Package registry credentials" },
  { test: (b) => /\.tfvars$/i.test(b) || b === "terraform.tfstate", reason: "Infrastructure variables or state" },
];

/** Returns why a file must be treated as a sensitive node, or undefined when it is ordinary. */
export function sensitiveReason(relPath: string): string | undefined {
  const base = path.posix.basename(relPath);
  return NAME_RULES.find((r) => r.test(base, relPath))?.reason;
}

interface SecretPattern {
  name: string;
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
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s/'"]+:([^@\s'"]+)@/g,
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
    if (name === "connection string password") {
      out = out.replace(regex, (match, password: string) => match.replace(`:${password}@`, `:${MASK}@`));
    } else {
      out = out.replace(regex, `${MASK} (${name})`);
    }
  }
  return out;
}

/**
 * Masks a sensitive node for display. Env-style files keep their keys (so engineers can see
 * what they need to request) and lose every value. Anything else is withheld entirely.
 */
export function maskSensitive(relPath: string, content: string): string {
  const base = path.posix.basename(relPath);
  const envLike = base === ".env" || base.startsWith(".env.") || base.endsWith(".tfvars");
  if (!envLike) return `${MASK}\n\nThis node is sensitive (${sensitiveReason(relPath) ?? "protected file"}). Its content is never shown or sent to a model.`;
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
