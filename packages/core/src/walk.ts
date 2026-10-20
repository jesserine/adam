import * as fs from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";

/** Folders that are never part of the graph: dependencies, build output, tool state. */
export const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  ".adam/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".vercel/",
  ".cache/",
  "coverage/",
  "bin/Debug/",
  "bin/Release/",
  "obj/",
  ".vs/",
  "TestResults/",
  "__pycache__/",
  ".venv/",
  "*.vsix",
  ".DS_Store",
];

export interface WalkedFile {
  /** Repo-relative path with forward slashes. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

export function createIgnore(root: string, extra: string[] = []): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES).add(extra);
  const gitignore = path.join(root, ".gitignore");
  if (fs.existsSync(gitignore)) ig.add(fs.readFileSync(gitignore, "utf8"));
  return ig;
}

/** Lists every file under `root` that is not ignored. Symlinks are not followed. */
export async function walk(root: string, ig: Ignore): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  const queue = [""];
  while (queue.length) {
    const dirRel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, dirRel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ig.ignores(`${rel}/`)) queue.push(rel);
      } else if (entry.isFile() && !ig.ignores(rel)) {
        const abs = path.join(root, rel);
        try {
          const stat = await fs.promises.stat(abs);
          files.push({ rel, abs, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // Deleted between readdir and stat.
        }
      }
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}
