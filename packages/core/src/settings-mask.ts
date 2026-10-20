/**
 * Masking for structured settings files (.NET `appsettings*.json`, `web.config`): every value
 * goes, every key stays, and the file keeps its layout and comments so it still reads naturally.
 */

export interface MaskedSettings {
  content: string;
  /** Leaf keys in .NET configuration form, `Section:Key` (array items as `Section:0`). */
  keys: string[];
}

interface Frame {
  kind: "object" | "array";
  path: string[];
  key?: string;
  index: number;
  expectKey: boolean;
}

/**
 * Masks a JSON (or JSONC, as .NET reads it: comments and trailing commas allowed) settings file.
 * Strings and numbers become the mask; `true`, `false`, `null` and empty strings stay, since
 * they cannot carry a secret and tell the reader a setting is off or unset.
 * Throws on text it cannot follow, so the caller withholds the file instead of leaking it.
 */
export function maskJsonSettings(text: string, mask: string): MaskedSettings {
  const out: string[] = [];
  const keys = new Set<string>();
  const stack: Frame[] = [];
  let i = 0;

  const top = () => stack[stack.length - 1];
  const valuePath = (): string[] => {
    const f = top();
    if (!f) return [];
    return f.kind === "object" ? [...f.path, f.key ?? ""] : [...f.path, String(f.index)];
  };
  const leaf = () => {
    const p = valuePath();
    if (p.length) keys.add(p.join(":"));
  };

  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch) || ch === ",") {
      if (ch === ",") {
        const f = top();
        if (f?.kind === "object") f.expectKey = true;
        else if (f) f.index++;
      }
      out.push(ch);
      i++;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out.push(text.slice(i, stop));
      i = stop;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unterminated comment");
      out.push(text.slice(i, end + 2));
      i = end + 2;
    } else if (ch === "{" || ch === "[") {
      const p = valuePath();
      stack.push({ kind: ch === "{" ? "object" : "array", path: p, index: 0, expectKey: ch === "{" });
      out.push(ch);
      i++;
    } else if (ch === "}" || ch === "]") {
      if (!stack.pop()) throw new Error("Unbalanced bracket");
      out.push(ch);
      i++;
    } else if (ch === ":") {
      const f = top();
      if (f?.kind !== "object") throw new Error("Unexpected colon");
      f.expectKey = false;
      out.push(ch);
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) throw new Error("Unterminated string");
      const raw = text.slice(i, j + 1);
      const f = top();
      if (f?.kind === "object" && f.expectKey) {
        f.key = JSON.parse(raw) as string;
        out.push(raw);
      } else {
        leaf();
        out.push(raw === '""' ? raw : `"${mask}"`);
      }
      i = j + 1;
    } else {
      const m = /^[^\s,:\]}/"]+/.exec(text.slice(i, i + 256));
      if (!m) throw new Error(`Unexpected character ${ch}`);
      leaf();
      out.push(/^(true|false|null)$/.test(m[0]) ? m[0] : `"${mask}"`);
      i += m[0].length;
    }
  }
  if (stack.length) throw new Error("Unbalanced bracket");
  return { content: out.join(""), keys: [...keys] };
}

/** Attributes that name a setting rather than hold its value. */
const XML_KEEP_ATTRIBUTE = /^(key|name|xmlns(:[\w.-]+)?|xdt:[\w.-]+|version|encoding|standalone)$/i;

/**
 * Masks an XML config (`web.config`, `app.config`): attribute values other than names and
 * namespaces, text content and CDATA are masked; element names, `key`/`name` attributes and
 * comments stay. Keys come from `<add key>`, `<add name connectionString>` and `<setting name>`.
 */
export function maskXmlSettings(text: string, mask: string): MaskedSettings {
  const keys = new Set<string>();
  const content = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g, (token) => {
    if (token.startsWith("<!--")) return token;
    if (token.startsWith("<![CDATA[")) return `<![CDATA[${mask}]]>`;
    if (token.startsWith("<")) {
      const tag = /^<\s*([\w:.-]+)/.exec(token)?.[1]?.toLowerCase();
      const attrs = new Map<string, string>();
      const masked = token.replace(/([\w:.-]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g, (whole, name: string, eq: string, quoted: string, dq?: string, sq?: string) => {
        const value = dq ?? sq ?? "";
        attrs.set(name.toLowerCase(), value);
        if (XML_KEEP_ATTRIBUTE.test(name) || value === "") return whole;
        const q = quoted[0];
        return `${name}${eq}${q}${mask}${q}`;
      });
      if (tag === "add" && attrs.get("key")) keys.add(attrs.get("key")!);
      else if (tag === "add" && attrs.get("name") && attrs.has("connectionstring")) keys.add(`ConnectionStrings:${attrs.get("name")}`);
      else if (tag === "setting" && attrs.get("name")) keys.add(attrs.get("name")!);
      return masked;
    }
    if (!token.trim()) return token;
    const lead = /^\s*/.exec(token)![0];
    const trail = /\s*$/.exec(token)![0];
    return `${lead}${mask}${trail}`;
  });
  return { content, keys: [...keys] };
}
