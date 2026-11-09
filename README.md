# leads-sidebar

A Go-powered ChatGPT sidebar plugin for a mock sales pipeline. It starts with **150 leads**, displays **50 leads per page**, and lets you move every lead to any of these stages:

1. Lead Captured
2. Lead Qualified
3. Contact Established
4. Needs Assessment
5. Proposal Sent
6. Negotiation
7. Deal Approved
8. Contract Created

Each lead has a name, company, email, owner, estimated deal value in USD, stage, and update timestamp. All contact data is fictional. Stage changes persist on the Go server and survive restarts. Search and stage filters combine, and reset pagination to page 1. Stage cards and summary counts describe the entire pipeline; the table and pagination describe the matching leads.

## Start

Requires Go 1.26+. No environment variables or API key are required. The browser bundle is already included; Node is only required to rebuild it.

```sh
cd /Users/paul3ds/3ds/projects/leads-sidebar
go run ./cmd/server
```

MCP endpoint: `http://127.0.0.1:3005/mcp`. Health: `/health`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen interface |
| `PORT` | `3005` | HTTP port |
| `LEADS_DATA_DIR` | `.data` in the working directory | Persistent `leads.json` |

```sh
HOST=0.0.0.0 PORT=3005 LEADS_DATA_DIR=/absolute/path/to/data go run ./cmd/server
go run ./cmd/server --address 127.0.0.1:3005 --endpoint /mcp
go run ./cmd/server --stdio
go run ./cmd/server --version
```

The 150 records are seeded only when the data file is missing. Restarting does not reset stage changes. The server reports damaged storage rather than replacing it. Use one process per data directory. This is an unauthenticated, single-workspace development demo; all connections share the same leads. It does not connect to your real CRM.

## Open in ChatGPT

Follow the [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Account and workspace policies determine availability.

1. Run the server and connect it through a public HTTPS endpoint or Secure MCP Tunnel. A remote ChatGPT connection cannot access your Mac's localhost directly.
2. In **ChatGPT → Plugins → + → Add custom MCP server**, enter the HTTPS `/mcp` URL or select your tunnel, name it **Lead Pipeline**, and choose no authentication for this private demo.
3. Create and install the plugin. Open **Lead Pipeline** in ChatGPT's sidebar.
4. Use Previous, Next, or page buttons to browse all 150 leads. Choose a stage in any row to save it. Search by name, company, email, ID, or owner; filter using the stage selector or stage cards.
5. To open it alongside a conversation, ask **“Open the Lead Pipeline beside this conversation.”**

Refresh the plugin connection after changing tool metadata, then start a new conversation. Native sidebar placement still needs verification in ChatGPT; the automated browser test uses an MCP Apps host harness.

The `/mcp` URL is a protocol endpoint, not a standalone web page. The Go server exposes the UI through `resources/read`. ChatGPT embeds it in an iframe and the official MCP Apps browser SDK sends tool calls through the host bridge.

### Sidebar registration

`leads.open` accepts `{}` and declares:

```json
{
  "ui": { "resourceUri": "ui://leads-sidebar/pipeline-v3", "visibility": ["app", "model"] },
  "openai/ui": { "entrypoints": [{ "type": "global" }] }
}
```

`leads.panel` uses `type: thread` for a conversation panel. Both use the same bundled UI. See the [official extension guide](https://developers.openai.com/plugins/build/extensions).

## Kanban board

Use the **Table / Kanban** switch above the lead list. Both views use the same saved leads and preserve your current page, search, stage filter, and fullscreen state. The board shows the current page of up to 50 leads across all eight stage columns; column counts and subtotals describe this page. The summary cards above describe the entire pipeline.

Drag a lead card to any stage column to move it, including empty columns. Each card also has a **Move to** selector for keyboard and touch use. Moves use the same version-checked server operation as the table. A failed save leaves the lead in its original stage and shows an error; Refresh reloads the saved data. Under an active stage filter, successfully moved leads disappear from the filtered results when they no longer match.

Upgrade to 0.3.0 by rebuilding/redeploying the server or Docker image, refreshing connector metadata, and opening a new view. The UI resource is now `pipeline-v3`.

## Fullscreen in Claude and other MCP Apps hosts

The app declares `availableDisplayModes: ["inline", "fullscreen"]` in the standard MCP Apps initialization, alongside the ChatGPT resource metadata. Use the **Fullscreen** button in the header to call `app.requestDisplayMode({ mode: "fullscreen" })`. **Exit fullscreen** requests inline mode again. Host-initiated changes also update the button.

Claude supports interactive connectors in inline and fullscreen views ([Claude documentation](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). The host controls which modes are available for the current view. If fullscreen is explicitly unavailable, the button is disabled; rejected requests show an error and retain the actual host mode. The app cannot force expansion beyond the host's iframe.

After upgrading, rebuild/redeploy the Go executable or Docker image, refresh the connector/tool metadata, and open a fresh Lead Pipeline view. Versioned UI resources avoid cached copies of the old app. The display-mode workflow is covered by an MCP host browser harness; the actual Claude client still needs a manual check.

## Tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `leads.open` | `{}` | Open the sidebar pipeline at page 1 |
| `leads.panel` | `{}` | Open the pipeline beside a conversation |
| `leads.list` | `page` (1–3, default 1), optional `query` and exact `stage` | Return up to 50 matching leads, pagination, stages, and global summary |
| `leads.updateStage` | `leadId`, `stage`, `expectedVersion` | Persist a stage change and return the updated lead |

Read `version` from `leads.list` and pass it as `expectedVersion` when updating. A stale update returns an error and the user can refresh. Failed saves preserve the previous stage; the browser only displays success after server confirmation. Movement can go forward or backward, or skip stages. No real sales actions are triggered.

Example:

```json
{"name":"leads.list","arguments":{"page":3}}
```

```json
{"name":"leads.updateStage","arguments":{"leadId":"LEAD-101","stage":"Contract Created","expectedVersion":1}}
```

## Build and test

```sh
make build                    # Build Go using the checked-in UI bundle
make test                     # Go tests with race detector and real HTTP MCP calls
go vet ./...

npm ci --ignore-scripts
npm run build                 # Typecheck, bundle browser UI, compile Go
npx playwright install chromium
npm run test:browser
# Or use installed Chrome on macOS:
BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
```

The browser test checks three pages of 50, boundary pagination buttons, persistent stage changes, failed-save recovery and retry, search, no results, stage filters, Table/Kanban switching, real drag-and-drop, empty-column drops, and card stage selectors. Go tests cover pagination without duplicates, all eight stages, persistence across reopen, concurrent updates, stale versions, failed writes, validation, and sidebar tool/resource metadata.

After changing `web/`, run `npm run build:ui` and keep `internal/leads/app.html` updated. The Go executable embeds the UI and needs no Node runtime or external scripts. The layout supports light/dark host themes, horizontal table scrolling on narrow screens, labeled controls, and live status messages.

## Docker

```sh
docker build -t leads-sidebar .
docker run --rm -p 3005:3005 -v leads-sidebar-data:/data leads-sidebar
```

The image binds `0.0.0.0:3005`, runs as a non-root user, and persists data in `/data`.

`docker-build.sh` follows the existing project conventions: repository, tag, Docker Hub username, token on stdin, Buildx build and push. Defaults to `linux/amd64`; set `PLATFORMS` for other targets. It publishes an image when invoked; `docker build` above only builds locally.

## Local plugin / stdio

`make build` creates the executable used by `.mcp.json` and `.codex-plugin/plugin.json`. For a host accepting MCP configuration directly:

```json
{
  "mcpServers": {
    "leads-sidebar": {
      "command": "/Users/paul3ds/3ds/projects/leads-sidebar/build/leads-sidebar",
      "args": ["--stdio"],
      "env": { "LEADS_DATA_DIR": "/Users/paul3ds/3ds/projects/leads-sidebar/.data" }
    }
  }
}
```

The host must implement ChatGPT sidebar extensions to show a native sidebar entry.

## Files

- `internal/leads/store.go`: mock data, fixed-size pagination, filtering, stage changes, persistence.
- `internal/leads/server.go`: Go MCP tools and sidebar metadata.
- `web/leads.ts`, `web/shell.html`: browser interaction, table, pagination, stage dropdowns.
- `scripts/build-ui.mjs`: bundle the official SDK and embed the app.
- `cmd/server/main.go`: HTTP/stdio transport, configuration, and health.
