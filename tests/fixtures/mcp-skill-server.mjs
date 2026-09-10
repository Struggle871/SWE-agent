import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "skills-test", version: "1.0.0" });
server.registerResource("guide", "skill://guide", { description: "Test guide" }, async (uri) => ({ contents: [{ uri: uri.href, text: "MCP_SKILL_BODY" }] }));
server.registerTool("echo", { description: "Echo test" }, async () => ({ content: [{ type: "text", text: "MCP_TOOL_OK" }] }));
server.registerTool("ask", { description: "Ask for a value" }, async () => {
  const result = await server.server.elicitInput({ mode: "form", message: "Provide a value", requestedSchema: { type: "object", properties: { value: { type: "string", title: "Value", enum: ["approved", "declined"] } }, required: ["value"] } });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
