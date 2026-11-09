package leads

import (
	"context"
	"encoding/json"
	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMCPHTTPPipeline(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.NewStreamableHTTPServer(NewServer("test", store), server.WithStateLess(true)))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, err := client.NewStreamableHttpClient(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	init := mcp.InitializeRequest{}
	init.Params.ProtocolVersion = "2025-11-25"
	init.Params.ClientInfo = mcp.Implementation{Name: "test", Version: "1"}
	if _, err = c.Initialize(ctx, init); err != nil {
		t.Fatal(err)
	}
	tools, err := c.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 4 {
		t.Fatal("expected four tools")
	}
	for _, tool := range tools.Tools {
		b, _ := json.Marshal(tool)
		if tool.Name == "leads.open" && (!strings.Contains(string(b), `"type":"global"`) || !strings.Contains(string(b), ResourceURI)) {
			t.Fatal("missing sidebar metadata")
		}
		if tool.Name == "leads.updateStage" && *tool.Annotations.ReadOnlyHint {
			t.Fatal("write marked readonly")
		}
	}
	call := func(name string, args map[string]any) *mcp.CallToolResult {
		t.Helper()
		r, err := c.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: name, Arguments: args}})
		if err != nil || r.IsError {
			t.Fatalf("%s: %v %+v", name, err, r)
		}
		return r
	}
	decode := func(r *mcp.CallToolResult) Page {
		t.Helper()
		b, _ := json.Marshal(r.StructuredContent)
		var p Page
		if err = json.Unmarshal(b, &p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	initial := decode(call("leads.open", map[string]any{}))
	if len(initial.Leads) != 50 || initial.Total != 150 {
		t.Fatal("bad sidebar result")
	}
	third := decode(call("leads.list", map[string]any{"page": 3}))
	if third.Leads[0].ID != "LEAD-101" || third.Leads[49].ID != "LEAD-150" {
		t.Fatal("incorrect third page")
	}
	call("leads.updateStage", map[string]any{"leadId": "LEAD-101", "stage": "Contract Created", "expectedVersion": 1})
	third = decode(call("leads.list", map[string]any{"page": 3}))
	if third.Leads[0].Stage != "Contract Created" || third.Leads[0].Version != 2 {
		t.Fatal("stage update not reflected")
	}
	for _, args := range []map[string]any{{"leadId": "LEAD-101", "stage": "Negotiation", "expectedVersion": 1}, {"leadId": "LEAD-101", "stage": "Made Up", "expectedVersion": 2}, {"leadId": "LEAD-101", "stage": "Negotiation"}} {
		r, err := c.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "leads.updateStage", Arguments: args}})
		if err == nil && !r.IsError {
			t.Fatal("invalid write accepted")
		}
	}
	req := mcp.ReadResourceRequest{}
	req.Params.URI = ResourceURI
	resource, err := c.ReadResource(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(resource)
	if !strings.Contains(string(b), MIMEType) || !strings.Contains(string(b), "Lead Pipeline") {
		t.Fatal("missing app HTML")
	}
}
