package leads

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const ResourceURI = "ui://leads-sidebar/pipeline-v1"
const MIMEType = "text/html;profile=mcp-app"

//go:embed app.html
var appHTML string

func result(data any) *mcp.CallToolResult {
	b, _ := json.Marshal(data)
	return mcp.NewToolResultStructured(data, string(b))
}
func NewServer(version string, store *Store) *server.MCPServer {
	icon := mcp.Icon{Src: "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="#0f766e" stroke-width="2.4" stroke-linecap="round"><path d="M5 6h22M5 16h16M5 26h10"/><circle cx="26" cy="25" r="4"/></g></svg>`)), MIMEType: "image/svg+xml", Sizes: []string{"any"}}
	s := server.NewMCPServer("leads-sidebar", version, server.WithToolCapabilities(false), server.WithResourceCapabilities(false, false), server.WithIcons(icon), server.WithInputSchemaValidation())
	s.AddResource(mcp.NewResource(ResourceURI, "lead-pipeline", mcp.WithResourceTitle("Lead Pipeline"), mcp.WithMIMEType(MIMEType)), func(context.Context, mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		return []mcp.ResourceContents{mcp.TextResourceContents{URI: ResourceURI, MIMEType: MIMEType, Text: appHTML, Meta: map[string]any{"ui": map[string]any{"prefersBorder": true, "csp": map[string]any{"connectDomains": []string{}, "resourceDomains": []string{}}}, "openai/ui": map[string]any{"preferredDisplayMode": "fullscreen", "availableDisplayModes": []string{"inline", "fullscreen"}}}}}, nil
	})
	open := func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		page, err := store.List(1, "", "")
		if err != nil {
			return nil, err
		}
		return result(page), nil
	}
	for _, entry := range []struct{ name, title, kind string }{{"leads.open", "Lead Pipeline", "global"}, {"leads.panel", "Lead Pipeline", "thread"}} {
		tool := mcp.NewTool(entry.name, mcp.WithToolTitle(entry.title), mcp.WithDescription("Open the lead pipeline. Browse 150 mock leads, 50 per page, and move their sales stages."), mcp.WithSchemaAdditionalProperties(false), mcp.WithReadOnlyHintAnnotation(true), mcp.WithDestructiveHintAnnotation(false), mcp.WithOpenWorldHintAnnotation(false), mcp.WithToolIcons(icon))
		tool.Meta = mcp.NewMetaFromMap(map[string]any{"ui": map[string]any{"resourceUri": ResourceURI, "visibility": []string{"app", "model"}}, "openai/ui": map[string]any{"entrypoints": []any{map[string]any{"type": entry.kind}}}})
		s.AddTool(tool, open)
	}
	list := mcp.NewTool("leads.list", mcp.WithToolTitle("List leads"), mcp.WithDescription("List mock leads, exactly 50 per full page. Optional query matches name, company, email, ID, or owner. Optional stage filters by exact stage name. Read version before updating a lead."), mcp.WithSchemaAdditionalProperties(false), mcp.WithReadOnlyHintAnnotation(true), mcp.WithDestructiveHintAnnotation(false), mcp.WithOpenWorldHintAnnotation(false), mcp.WithInteger("page", mcp.Min(1), mcp.Max(3)), mcp.WithString("query", mcp.MaxLength(200)), mcp.WithString("stage", mcp.Enum(append([]string{""}, Stages()...)...)))
	list.Meta = mcp.NewMetaFromMap(map[string]any{"ui": map[string]any{"visibility": []string{"model", "app"}}})
	s.AddTool(list, func(_ context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		page, err := store.List(r.GetInt("page", 1), r.GetString("query", ""), r.GetString("stage", ""))
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return result(page), nil
	})
	update := mcp.NewTool("leads.updateStage", mcp.WithToolTitle("Move lead stage"), mcp.WithDescription("Move a lead to any of the eight sales stages. Pass expectedVersion from leads.list to prevent overwriting a concurrent update. Changes persist in the demo library."), mcp.WithSchemaAdditionalProperties(false), mcp.WithReadOnlyHintAnnotation(false), mcp.WithDestructiveHintAnnotation(false), mcp.WithOpenWorldHintAnnotation(false), mcp.WithString("leadId", mcp.Required()), mcp.WithString("stage", mcp.Required(), mcp.Enum(Stages()...)), mcp.WithInteger("expectedVersion", mcp.Required(), mcp.Min(1)))
	update.Meta = mcp.NewMetaFromMap(map[string]any{"ui": map[string]any{"visibility": []string{"model", "app"}}})
	s.AddTool(update, func(_ context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		lead, err := store.UpdateStage(r.GetString("leadId", ""), r.GetString("stage", ""), r.GetInt("expectedVersion", 0))
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		return result(map[string]any{"lead": lead}), nil
	})
	return s
}
