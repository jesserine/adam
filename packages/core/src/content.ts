import * as fs from "node:fs";
import * as path from "node:path";
import { countSecrets, maskSensitive, redactSecrets } from "./sensitive";
import type { CodeSymbol, GraphNode } from "./types";

export interface NodeContent {
  content: string;
  /** True when the node is sensitive and only a masked view is returned. */
  masked: boolean;
  /** Secret-looking values replaced in an ordinary file. */
  redactions: number;
}

export interface SymbolCode extends NodeContent {
  symbol: CodeSymbol;
}

/** Resolves a node id to a path inside the root, refusing anything that escapes it. */
function safePath(root: string, node: GraphNode): string {
  const abs = path.resolve(root, node.id);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Node ${node.id} is outside the repository`);
  const real = fs.realpathSync(abs);
  const realRoot = fs.realpathSync(root);
  const realRel = path.relative(realRoot, real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new Error(`Node ${node.id} links outside the repository`);
  return real;
}

/**
 * Reads a node for display. Sensitive nodes come back masked (env files keep their keys),
 * and secret-looking values in ordinary files are redacted. This is the only way content
 * leaves the core, so the same rules apply to the UI and, later, to the agent.
 */
export function readNodeContent(root: string, node: GraphNode): NodeContent {
  if (node.binary) return { content: "", masked: false, redactions: 0 };
  const raw = fs.readFileSync(safePath(root, node), "utf8");
  if (node.sensitive) return { content: maskSensitive(node.id, raw), masked: true, redactions: 0 };
  const redactions = countSecrets(raw);
  return { content: redactions ? redactSecrets(raw) : raw, masked: false, redactions };
}

/** Returns one symbol's source lines from a node, with the same masking as `readNodeContent`. */
export function readSymbolCode(root: string, node: GraphNode, symbolId: string): SymbolCode {
  const symbol = node.symbols.find((s) => s.id === symbolId);
  if (!symbol) throw new Error(`No symbol ${symbolId} in ${node.id}`);
  const whole = readNodeContent(root, node);
  if (whole.masked) return { ...whole, symbol };
  const lines = whole.content.split("\n").slice(symbol.start.line - 1, symbol.end.line);
  return { content: dedent(lines).join("\n"), masked: false, redactions: whole.redactions, symbol };
}

function dedent(lines: string[]): string[] {
  const indent = (l: string) => /^[ \t]*/.exec(l)![0].length;
  const filled = lines.filter((l) => l.trim());
  const shared = filled.length ? Math.min(...filled.map(indent)) : 0;
  return shared > 0 ? lines.map((l) => l.slice(Math.min(shared, indent(l)))) : lines;
}
