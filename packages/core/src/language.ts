import * as path from "node:path";

const BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".py": "python",
  ".cs": "csharp",
  ".csproj": "xml",
  ".java": "java",
  ".kt": "kotlin",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".sql": "sql",
  ".prisma": "prisma",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".env": "dotenv",
};

const BY_NAME: Record<string, string> = {
  Dockerfile: "docker",
  Makefile: "make",
  ".gitignore": "ignore",
  ".npmrc": "ini",
};

const BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".avif",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar",
  ".pdf", ".exe", ".dll", ".so", ".dylib", ".wasm", ".class", ".jar",
  ".sqlite", ".db", ".vsix", ".p12", ".pfx", ".keystore", ".jks",
]);

/** Extensions the TypeScript compiler can parse for symbols and imports. */
export const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export function languageOf(fileName: string): string {
  const base = path.basename(fileName);
  if (BY_NAME[base]) return BY_NAME[base];
  if (base === ".env" || base.startsWith(".env.")) return "dotenv";
  if (base.endsWith(".d.ts")) return "typescript";
  return BY_EXTENSION[path.extname(base).toLowerCase()] ?? "text";
}

export function isBinaryByName(fileName: string): boolean {
  return BINARY.has(path.extname(fileName).toLowerCase());
}

/** A NUL byte in the first 8 KB is a reliable sign of a binary file. */
export function looksBinary(content: Buffer): boolean {
  const end = Math.min(content.length, 8192);
  for (let i = 0; i < end; i++) if (content[i] === 0) return true;
  return false;
}
