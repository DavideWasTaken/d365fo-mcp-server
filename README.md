# D365 F&O MCP Server

<div align="center">

**Up to 22 AI tools for grounded X++ development, browser verification and optional AxDB SQL debugging**

> **Both additional tools are included on this fork's `main`: `verify_ui_customization` and optional `axdb_sql`.** Use AI-guided browser discovery or reusable deterministic plans after deployment (two cases recommended, one to five supported); use live SQL independently for debugging and targeted development data changes. SQL setup can be left blank and never replaces a UI creation/validation path under test. See [UI setup](docs/UI_CUSTOMIZATION_TESTING.md) and [SQL setup](docs/AXDB_SQL.md). Guided verification uses the AI already in your client; the server makes no LLM calls. Install or update this fork from `main` using [Quick Start](#quick-start); no feature branch is needed. The maintainer confirmed successful end-to-end use on the D365FO development VM on 2026-09-26; see [validation status](docs/TESTING.md#fork-validation-status).

Fork capabilities: builds return in the background with a log path and a retrievable result. Use `restartAos:true` to reload the matching local IIS `AOSService` pool or IIS Express instance after successful build/sync, before testing new objects. Runtime restart and readiness outcomes are saved with the build result. UI verification now independently reports recognized D365 system-error dialogs, even when a declared criterion passes; `validate_code` advisory `UI001` and the `menu-item-guards` knowledge topic cover expected negative guards in action menu entry points. Guided UI tests allow 30 calls per case and measured grid counts with explicit rendered/total semantics. Label translations use case-insensitive exact locale, then a supplied parent (`it` for `it-IT`), then a disclosed fallback. SQL supports read-only collation/database-property functions. Rebuild the C# bridge for SQL changes; see [build behavior](docs/BUILD_FEEDBACK.md), [UI checks and system errors](docs/UI_CUSTOMIZATION_TESTING.md) and [SQL setup](docs/AXDB_SQL.md).

> **This fork also extends the existing build tool, not only UI and SQL.** In the development VM's previous workflow, a successful MCP compilation could leave new objects unavailable in the running UI until a manual AOS restart or a Visual Studio build/runtime refresh. With `restartAos:true`, `build_d365fo_project` now completes compilation, runtime metadata generation and any requested database sync, then restarts the matching IIS/IIS Express host and checks readiness. This removes that manual refresh step when successful; it does not require a second compilation in Visual Studio. If restart/readiness cannot be confirmed, the tool explicitly tells the client AI to notify the user before UI testing. [Build changes and usage](docs/BUILD_FEEDBACK.md#why-this-fork-changes-the-build-workflow)

[![npm](https://img.shields.io/npm/v/d365fo-mcp.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/d365fo-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-5000%2B-brightgreen.svg)](docs/TESTING.md)
<!-- coverage-badge:start -->
[![Core coverage](https://img.shields.io/badge/core_coverage-100%25-brightgreen.svg)](eval/COVERAGE.md) [![Total coverage](https://img.shields.io/badge/total_coverage-100%25-lightgrey.svg)](eval/COVERAGE.md)
<!-- coverage-badge:end -->

*Grounded AI development for Dynamics 365 Finance & Operations — works with GitHub Copilot and Claude Code*

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_d365fo-0098FF?style=flat-square&logo=githubcopilot&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=d365fo&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22d365fo_server_url%22%2C%22description%22%3A%22D365FO%20MCP%20server%20URL%20(e.g.%20https%3A%2F%2Fyour-server.azurewebsites.net%2Fmcp%2F)%22%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22%24%7Binput%3Ad365fo_server_url%7D%22%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_d365fo-24bfa5?style=flat-square&logo=githubcopilot&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=d365fo&quality=insiders&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22d365fo_server_url%22%2C%22description%22%3A%22D365FO%20MCP%20server%20URL%20(e.g.%20https%3A%2F%2Fyour-server.azurewebsites.net%2Fmcp%2F)%22%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22%24%7Binput%3Ad365fo_server_url%7D%22%7D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_d365fo-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=d365fo&config=eyJ1cmwiOiJodHRwczovL3lvdXItc2VydmVyLmF6dXJld2Vic2l0ZXMubmV0L21jcC8ifQ%3D%3D)

*These connect an editor to a server that is already deployed — see [Quick Start](#quick-start) if you still need to set one up.*

</div>

---

## Why

AI assistants excel at C#, Python, and JavaScript. X++ is different: your D365FO codebase is private, deeply customized, and invisible to every model — so AI confidently generates code that doesn't compile.

This server pre-indexes your entire D365FO installation (580 000+ symbols across standard, ISV, and custom models) and exposes up to 22 specialized MCP tools (21 when SQL is disabled). Every signature, every CoC wrapper, every label, every form pattern — verified against your real metadata **before** the AI writes a single line.

![Solution Architecture](docs/img/solution-architecture-diagram.svg)

| Task | Without this server | With this server |
|------|--------------------|------------------|
| Method signatures | Guessed → compile errors | Exact, from your codebase |
| Existing CoC wrappers | Manual AOT search | `extension_info(mode="coc")` in < 50 ms |
| New forms | Hand-written XML, broken patterns | Cloned from reference forms, validated against the pattern catalog |
| Labels | Hardcoded strings | Right `@SYS`/`@MODULE` key found instantly |
| Security chains | Hours of manual tracing | Role → Duty → Privilege → Entry Point in one call |
| Generated code | Hallucinated fields and types | Every reference proven against the index, gated before write |

---

## Capabilities

| Feature | Description |
|---|---|
| 🔍 **Full-codebase intelligence** | 580K+ symbols indexed: classes, tables, forms, EDTs, enums, labels (20M+ rows), security artifacts — FTS5 search in < 10 ms |
| 🛡️ **Grounded generation** | Fail-closed gates: `prepare` issues grounding tokens, `validate_code(mode="references")` proves every identifier, `validate_code(mode="syntax")` enforces best practices — hallucinated code never reaches disk |
| 🧩 **Form pattern engine** | Complete catalog of Microsoft form patterns and sub-patterns: recommends the right pattern, clones reference forms with datasource re-binding, **deterministically expands** patterns that have no reference form, **auto-repairs** a form's missing required controls, validates structure and blocks invalid writes |
| ✍️ **Safe metadata writes** | C# bridge uses Microsoft's own `IMetadataProvider` wherever it can express the object; the few types and ops it cannot go through structured XML writers with ambiguity guards — never blind string replacement. Automatic `.rnrproj` registration, one-call undo |
| 🏗️ **SDLC integration** | Background X++ compilation with `xppc.exe`, structured diagnostics, DB sync, xppbp best practices and SysTestRunner. The existing build tool also supports `restartAos:true` to reload the local IIS/IIS Express runtime before UI testing, with an explicit user warning if readiness cannot be confirmed. [Build workflow](docs/BUILD_FEEDBACK.md) |
| 🧪 **Browser customization tests — `verify_ui_customization`** | Guided sessions let your existing client AI observe controls, choose actions and check immutable requirement criteria. Deterministic saved plans remain supported. Both produce evidence and PASS / FAIL / NOT_VERIFIED for one to five cases. Human login works in owned Chromium/Edge; local HTTP and stdio are supported, with no embedded model. [Setup](docs/UI_CUSTOMIZATION_TESTING.md) |
| 🗄️ **Optional AxDB SQL — `axdb_sql`** | Live queries, table columns/keys/defaults and transactional INSERT/UPDATE/DELETE for development debugging. No result cache or automatic write retry. Independent of browser tests: use UI/X++ when creation, validation or CoC is under test. [Setup](docs/AXDB_SQL.md) |
| 📐 **X++ knowledge base** | Queryable rules: select grammar, CoC authoring, financial dimensions, the posting engine (`LedgerVoucher`), number sequences, `SysExtension`, Electronic Reporting, AX2012→D365FO migration — prevents deprecated APIs |

### Configure this fork's additional tools

The UI tool needs the Dynamics environment URL; a missing URL is requested when a test starts. Guided mode opens a visible browser for human login and company discovery. Keep your local MCP endpoint, such as `http://localhost:8080/mcp`: it is separate from the Dynamics URL. Fetch `action="contract", topic="guided"` for the guided protocol; existing `run` plans retain their deterministic behavior. SQL is separately optional: leave the SQL server blank in setup to hide the tool and skip the remaining SQL questions.

Setup also offers **Browser for UI tests**: choose `msedge` when your dev login requires Edge, `chromium` to require Playwright Chromium, or `auto` (default) to try installed Edge only if Chromium cannot launch. The selected browser is reported. Native input fields expose `value` with a check hint; an incompatible `text` assertion is `NOT_VERIFIED`, never a functional `FAIL`. Browser errors identify the phase and safe cause, including a blocked origin. See the [UI troubleshooting guide](docs/UI_CUSTOMIZATION_TESTING.md#troubleshooting).

For SQL on a developer VM, the wizard asks for the server/instance (for example `localhost`), database (normally `AxDB`), whether to allow writes, and whether to trust a self-signed SQL certificate. Authentication uses the Windows account running MCP; it needs the corresponding database permissions. SQL username/password authentication is not implemented. The updated C# bridge must be built and deployed on the D365FO VM; see the [SQL guide](docs/AXDB_SQL.md#build-the-updated-bridge). The SQL workflow has been validated on the maintainer's development VM.

From this checkout, revisit SQL setup with:

```powershell
npx tsx src/cli/index.ts config sql
```

Restart MCP after saving. The upstream npm package does not include this fork's additional tools.

### Pattern-grounded form development

Forms are the hardest artifact to generate correctly — each pattern dictates required containers, ordering, and allowed sub-patterns. The form pattern engine makes it a guided pipeline:

```mermaid
flowchart LR
    A["object_patterns<br/>(domain=form, action=analyze)"] --> B["object_patterns<br/>(domain=form, action=spec)"]
    B --> C["generate_object<br/>objectType=form, cloneFrom"]
    C --> D["object_patterns<br/>(domain=form, action=validate) FP001–FP010"]
    D -->|clean| E["d365fo_file<br/>(action=create) write + project"]
    D -->|errors| C
```

Structural violations (wrong order, missing container, disallowed control) **block the write** — recommendations only warn. Mined pattern statistics from your own environment ground every suggestion in reality.

---

## Quick Start

> **From D365FO platform update 10.0.49 (PU74), Visual Studio 2026 is the supported IDE for X++ development** — Microsoft no longer supports VS 2022. Earlier platform versions still use VS 2022 ≥ 17.14. [Details](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/fin-ops/get-started/whats-new-platform-updates-10-0-49)

### Install this fork from main

On your D365FO developer VM, use Node.js 24+, Git and a .NET SDK compatible with the bridge. The bridge requires the installed D365FO development assemblies; see [setup prerequisites](docs/SETUP.md). Both additional tools are in this repository's `main` branch.

```powershell
git clone --branch main https://github.com/DavideWasTaken/d365fo-mcp-server.git
cd d365fo-mcp-server
npm ci
npm run build
dotnet build bridge/D365MetadataBridge -c Release
npx playwright install chromium
npm run setup
```

Setup asks for the optional UI environment URL and SQL connection settings. For deterministic browser tests, also [save an authenticated session](docs/UI_CUSTOMIZATION_TESTING.md#save-a-local-browser-login); [guided mode](docs/UI_CUSTOMIZATION_TESTING.md#ai-guided-first-verification) handles human login in its owned visible browser. Microsoft Edge can be selected through the browser profile. Point your editor's local MCP configuration at **this checkout's `dist/index.js`**, following [setup scenarios](docs/SETUP.md).

### Update an existing checkout of this fork

Stop the MCP process before replacing its bridge executable. From your checkout on `main`:

```powershell
git pull --ff-only origin main
npm ci
npm run build
dotnet build bridge/D365MetadataBridge -c Release
npx playwright install chromium
```

Restart MCP after updating. Existing configuration is retained; use `npx tsx src/cli/index.ts config sql` when you want to enable or change SQL. Building the bridge and validating live AxDB access must be done on your developer VM; see the [SQL guide](docs/AXDB_SQL.md#build-the-updated-bridge).

### Migrate from an upstream npm installation

If upstream is already installed with `npm install -g d365fo-mcp`, its configuration and index live in that installation's data directory, not in a checkout. A checkout never reads that directory — it ignores `%LOCALAPPDATA%\d365fo-mcp\install.json` and an inherited `D365FO_CONFIG` on purpose — so a fresh checkout reports "database not found" and `npm run setup` would rebuild the index from scratch, which takes hours. Move the existing state instead:

1. **Find the data directory** while the npm install is still there: run `d365fo-mcp doctor` and read the line `Installed from npm; data directory: …`. The default is `%LOCALAPPDATA%\d365fo-mcp\installation`. Then stop MCP (close Visual Studio or the editor that launches it).
2. **Clone and build this fork** as in [Install this fork from main](#install-this-fork-from-main), but skip `npm run setup`.
3. **Copy the state into the checkout root.** From the checkout, with `$old` set to the data directory from step 1:

   ```powershell
   $old = "$env:LOCALAPPDATA\d365fo-mcp\installation"
   foreach ($d in 'config', 'data', 'extracted-metadata', 'instances', '.d365fo-ui') {
     if (Test-Path "$old\$d") { robocopy "$old\$d" ".\$d" /E /NFL /NDL /NJH /NJS }
   }
   ```

   Paths the wizard writes are relative (`./data/xpp-metadata.db`, …) and resolve from the new location. An absolute path you set by hand to somewhere under the old directory has to be edited.
4. **Clear `bridge.exePath`.** The npm wizard pins it to `<old data directory>\bridge\D365MetadataBridge.exe`, a bridge compiled from upstream sources without SQL support — `axdb_sql` reports the missing capability for as long as the setting points there. Delete the `exePath` key from the `bridge` section of `config\d365fo-mcp.json` (and of each `instances\<name>\d365fo-mcp.json`); left empty, the server finds the checkout's own `bridge\D365MetadataBridge\bin\Release` build.
5. **Register the server again.** The existing `.mcp.json` entry still runs the global npm package with `D365FO_CONFIG` pointing at the old directory. Point both at the checkout — `args` at `<checkout>\dist\index.js`, `D365FO_CONFIG` at `<checkout>\config\d365fo-mcp.json` — following [setup scenarios](docs/SETUP.md). For Claude Code, `claude mcp remove` the old entry and add it again with `claude mcp add-json`.
6. **Check it from the checkout**: `npx tsx src/cli/index.ts doctor` should report `Installed from git; data directory: <checkout>` and find the database. Enable SQL with `npx tsx src/cli/index.ts config sql` if you want it.

A `d365fo-mcp` command on `PATH` is still the upstream npm CLI and still manages the old directory, so run the fork's commands from the checkout as above. Once the checkout works, `npm uninstall -g d365fo-mcp` removes the ambiguity; the old data directory can then be deleted.

### Upstream package and shared servers

The npm package `d365fo-mcp`, the original project's installer and its hosted server do **not** include these fork additions. Use the checkout above for UI verification and AxDB SQL.

**Your team already runs a shared server?** Then you install nothing — point your editor at it:

```powershell
npx d365fo-mcp connect https://your-server.azurewebsites.net
```

Both paths in full — prerequisites, editor configuration for every scenario, the required instruction file, and how to verify grounding actually works: **[docs/QUICK_START.md](docs/QUICK_START.md)**

---

## Azure Deployment

One shared instance for the whole team — the metadata index lives in Blob Storage and downloads automatically on startup.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fdynamics365ninja%2Fd365fo-mcp-server%2Frefs%2Fheads%2Fmain%2Finfrastructure%2Fazuredeploy.json)

Deployment guide: [docs/SETUP_AZURE.md](docs/SETUP_AZURE.md) — includes CI/CD pipeline automation

---

## Documentation

| Getting started | Reference | Operations |
|-----------------|-----------|------------|
| [Install/update this fork](#quick-start) | [Tool catalog (up to 22)](docs/MCP_TOOLS.md) | [Azure deployment](docs/SETUP_AZURE.md) |
| [Browser test setup](docs/UI_CUSTOMIZATION_TESTING.md) | [Optional AxDB SQL](docs/AXDB_SQL.md) | [Upstream setup guide](docs/QUICK_START.md) |
| [Setup scenarios A–F](docs/SETUP.md) | [`.mcp.json` reference](docs/MCP_CONFIG.md) | [DevOps pipelines](docs/SETUP_AZURE.md#azure-devops-pipelines) |
| [Claude Code setup](docs/SETUP.md#claude-code-cli) | [Configuration](docs/CONFIGURATION.md) | [Testing](docs/TESTING.md) |
| [Usage examples](docs/USAGE_EXAMPLES.md) — real tool chains | [Architecture](docs/ARCHITECTURE.md) | [Custom / ISV models](docs/CUSTOM_EXTENSIONS.md) |
| [Changelog](CHANGELOG.md) | [Knowledge authoring](docs/KNOWLEDGE_AUTHORING.md) | [Coverage](eval/COVERAGE.md) — what the badge counts |
| [Backlog](docs/BACKLOG.md) — deferred work | [New tool checklist](docs/NEW_TOOL_CHECKLIST.md) | [Eval loop](docs/AGENT_EVAL_LOOP.md) — the self-improvement harness |

## License

MIT
