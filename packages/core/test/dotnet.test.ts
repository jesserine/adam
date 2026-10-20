import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepository, MASK, parseCSharp, readNodeContent, readSymbolCode, redactSecrets, type CodeGraph } from "../src";

const FIXTURE = path.join(__dirname, "fixtures", "dotnet-app");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "adam-dotnet-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const node = (g: CodeGraph, id: string) => {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`missing node ${id}`);
  return n;
};
const edge = (g: CodeGraph, source: string, target: string) => g.edges.find((e) => e.source === source && e.target === target);

describe("C# parsing", () => {
  it("extracts types and members with kinds, signatures and ranges", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const svc = node(g, "src/Core/Services/UserService.cs");
    expect(svc.language).toBe("csharp");
    expect(svc.parsed).toBe(true);
    expect(svc.symbols.map((s) => [s.id, s.kind])).toEqual([
      ["UserService", "class"],
      ["UserService.UserService", "constructor"],
      ["UserService.Find", "method"],
      ["UserService.OrdersOf", "method"],
    ]);
    const find = svc.symbols.find((s) => s.id === "UserService.Find")!;
    expect(find).toMatchObject({ signature: "public User? Find(int id)", exported: true, parent: "UserService", start: { line: 12 } });
    expect(svc.symbols[0].signature).toBe("public class UserService : IUserService");

    const user = node(g, "src/Core/Models/User.cs");
    expect(user.symbols.map((s) => [s.id, s.kind])).toEqual([
      ["User", "class"],
      ["User.Id", "accessor"],
      ["User.Email", "accessor"],
      ["User.Role", "accessor"],
      ["Role", "enum"],
    ]);
    expect(node(g, "src/Core/Models/Order.cs").symbols[0].signature).toBe("public sealed record Order(int Id, User Buyer)");
  });

  it("keeps attributes in a symbol's code but not its signature", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const controller = node(g, "src/Api/Controllers/UsersController.cs");
    const get = controller.symbols.find((s) => s.id === "UsersController.Get")!;
    expect(get.signature).toBe("public ActionResult<User> Get(int id)");
    const code = readSymbolCode(root, controller, "UsersController.Get");
    expect(code.content.startsWith('[HttpGet("{id}")]\npublic ActionResult<User> Get(int id)')).toBe(true);
  });

  it("reads environment variables and configuration keys", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    expect(node(g, "src/Api/Controllers/UsersController.cs").envReads).toEqual(["ConnectionStrings:Default", "SHOP_REGION"]);
    expect(node(g, "src/Api/Program.cs").envReads).toEqual(["Jwt:Key"]);
  });

  it("handles block namespaces, nested types, operators and interfaces", async () => {
    const facts = await parseCSharp(`
namespace A.B {
  namespace C {
    public interface IThing { void Run(); }
    public struct Point {
      public static Point operator +(Point a, Point b) => a;
      public class Inner { }
    }
  }
}`);
    expect(facts.links.namespaces).toEqual(["A.B", "A.B.C"]);
    expect(facts.links.types).toEqual(["A.B.C.IThing", "A.B.C.Point", "A.B.C.Point.Inner"]);
    expect(facts.symbols.map((s) => [s.id, s.kind, s.exported])).toEqual([
      ["IThing", "interface", true],
      ["IThing.Run", "method", true],
      ["Point", "class", true],
      ["Point.operator +", "method", true],
      ["Point.Inner", "class", true],
    ]);
  });
});

describe(".NET edges", () => {
  it("links C# files through the types they use, across referenced projects", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    // Same project, same namespace (no using needed).
    expect(edge(g, "src/Core/Services/UserService.cs", "src/Core/Services/IUserService.cs")?.kind).toBe("references");
    // Through a global using declared in the .csproj (`<Using Include>`).
    expect(edge(g, "src/Core/Services/IUserService.cs", "src/Core/Models/User.cs")?.specifier).toBe("User");
    // Through a using alias, into a referenced project.
    expect(edge(g, "src/Api/Controllers/UsersController.cs", "src/Core/Services/IUserService.cs")?.specifier).toBe("Svc.IUserService");
    expect(edge(g, "src/Api/Controllers/UsersController.cs", "src/Core/Models/User.cs")).toBeDefined();
    // Top-level statements and generic type arguments.
    expect(edge(g, "src/Api/Program.cs", "src/Core/Services/UserService.cs")).toBeDefined();
    // Transitively referenced project (tests → Api → Core).
    expect(edge(g, "tests/Api.Tests/UsersControllerTests.cs", "src/Api/Controllers/UsersController.cs")).toBeDefined();
    expect(edge(g, "tests/Api.Tests/UsersControllerTests.cs", "src/Core/Models/User.cs")).toBeDefined();
    // Same name in the same namespace in a project nobody references: no edge.
    expect(g.edges.filter((e) => e.target === "samples/Other/User.cs")).toEqual([]);
    // Extension methods, found through an implicitly imported namespace.
    expect(edge(g, "src/Api/Program.cs", "src/Core/ServiceCollectionExtensions.cs")?.specifier).toBe("AddShopCore()");
    // Members, locals and keywords never become edges.
    expect(edge(g, "src/Core/Models/User.cs", "src/Core/Models/Order.cs")).toBeUndefined();
  });

  it("links the parts of a partial type, without extra reference edges between them", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    expect(edge(g, "src/Core/Models/User.Validation.cs", "src/Core/Models/User.cs")?.kind).toBe("partial");
    expect(g.edges.filter((e) => e.source === "src/Core/Models/User.cs" && e.target === "src/Core/Models/User.Validation.cs")).toEqual([]);
    expect(g.edges.filter((e) => e.source === "src/Core/Models/User.Validation.cs" && e.kind === "references")).toEqual([]);
  });

  it("links solutions to projects and projects to projects", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    expect(edge(g, "Shop.sln", "src/Core/Core.csproj")?.kind).toBe("solution-project");
    expect(edge(g, "Shop.sln", "tests/Api.Tests/Api.Tests.csproj")?.kind).toBe("solution-project");
    // Written as `src\api\Api.csproj`: matched case-insensitively, as Windows would.
    expect(edge(g, "Shop.sln", "src/Api/Api.csproj")?.kind).toBe("solution-project");
    expect(edge(g, "src/Api/Api.csproj", "src/Core/Core.csproj")).toMatchObject({ kind: "project-reference", specifier: "..\\Core\\Core.csproj" });
    expect(node(g, "Shop.sln").unresolved).toEqual(["src\\Gone\\Gone.csproj"]);
    expect(node(g, "tests/Api.Tests/Api.Tests.csproj").unresolved).toEqual(["$(RepoRoot)\\Missing\\Missing.csproj"]);
  });

  it("records NuGet packages, external namespaces and the owning project", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    expect(node(g, "src/Core/Core.csproj").packages).toEqual(["Microsoft.EntityFrameworkCore"]);
    expect(node(g, "src/Api/Api.csproj").packages).toEqual(["Swashbuckle.AspNetCore"]);
    expect(node(g, "src/Api/Controllers/UsersController.cs").packages).toEqual(["Microsoft.AspNetCore.Mvc"]);
    expect(node(g, "src/Api/Controllers/UsersController.cs").project).toBe("src/Api/Api.csproj");
    expect(node(g, "tests/Api.Tests/UsersControllerTests.cs").project).toBe("tests/Api.Tests/Api.Tests.csproj");
    expect(node(g, "Shop.sln").language).toBe("solution");
  });

  it("serves .NET facts from the cache on the next run", async () => {
    const first = await indexRepository({ root });
    const second = await indexRepository({ root });
    expect(second.stats.reparsed).toBe(0);
    expect(second.edges).toEqual(first.edges);
    const cache = fs.readFileSync(path.join(root, ".adam", "cache.json"), "utf8");
    expect(cache).not.toContain("fixture-not-a-real-password");
    expect(cache).not.toContain("fixture-not-a-real-jwt-key");
    expect(cache).not.toContain("fixture-smtp-pass");
  });
});

describe(".NET secrets", () => {
  it("treats every appsettings file as sensitive and lists its keys", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const settings = node(g, "src/Api/appsettings.json");
    expect(settings.sensitive).toBe(true);
    expect(settings.hash).toBe("");
    expect(settings.envDeclares).toEqual([
      "Logging:LogLevel:Default",
      "ConnectionStrings:Default",
      "Jwt:Key",
      "Jwt:LifetimeMinutes",
      "Jwt:RequireHttps",
      "AllowedHosts",
      "Optional",
      "Origins:0",
      "Origins:1",
    ]);
    expect(node(g, "src/Api/appsettings.Development.json").sensitive).toBe(true);
  });

  it("masks appsettings values but keeps keys, comments and layout", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const view = readNodeContent(root, node(g, "src/Api/appsettings.json"));
    expect(view.masked).toBe(true);
    expect(view.content).toContain("// Comments are allowed in .NET settings.");
    expect(view.content).toContain(`"Default": "${MASK}"`);
    expect(view.content).toContain(`"LifetimeMinutes": "${MASK}", "RequireHttps": true`);
    expect(view.content).toContain(`"Optional": ""`);
    expect(view.content).not.toContain("fixture-not-a-real");
    expect(view.content).not.toContain("Information");
  });

  it("withholds a settings file it cannot read cleanly", async () => {
    fs.writeFileSync(path.join(root, "src/Api/appsettings.Broken.json"), '{ "Key": "fixture-unterminated');
    const g = await indexRepository({ root, cacheDir: false });
    const view = readNodeContent(root, node(g, "src/Api/appsettings.Broken.json"));
    expect(view.content.startsWith(MASK)).toBe(true);
    expect(view.content).not.toContain("fixture-unterminated");
  });

  it("masks web.config values and lists its settings", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const config = node(g, "legacy/web.config");
    expect(config.sensitive).toBe(true);
    expect(config.envDeclares).toEqual(["ConnectionStrings:Legacy", "SmtpPassword"]);
    const view = readNodeContent(root, config);
    expect(view.content).toContain(`<add key="SmtpPassword" value="${MASK}" />`);
    expect(view.content).toContain(`<add name="Legacy" connectionString="${MASK}"`);
    expect(view.content).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(view.content).not.toContain("fixture-");
  });

  it("redacts ADO.NET connection string passwords in code, not variables named Password", async () => {
    const g = await indexRepository({ root, cacheDir: false });
    const db = node(g, "src/Api/Data/Db.cs");
    expect(db.secretHints).toBe(1);
    const view = readNodeContent(root, db);
    expect(view.content).toContain(`User Id=sa;Password=${MASK};`);
    expect(view.content).toContain("var Password = password; return Password;");
    expect(redactSecrets('"AccountKey=abc123def456==;"')).toBe(`"AccountKey=${MASK};"`);
    expect(redactSecrets('$"Server=x;Password={pwd};"')).toBe('$"Server=x;Password={pwd};"');
  });
});
