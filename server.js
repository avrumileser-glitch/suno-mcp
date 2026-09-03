import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---- Config -----------------------------------------------------------
const PORT = process.env.PORT || 3000;
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const SUNO_API_BASE = process.env.SUNO_API_BASE || "https://sunor.cc/api/v1";
// Optional: set MCP_SERVER_SECRET to require callers to send
// `Authorization: Bearer <secret>`. Leave unset while testing locally.
const MCP_SERVER_SECRET = process.env.MCP_SERVER_SECRET;

if (!SUNO_API_KEY) {
  console.warn("[warn] SUNO_API_KEY is not set — tool calls will fail until it is.");
}
// Using sunor.cc: auth via `x-api-key` header, POST /task to start a job,
// GET /task/:id to poll it. Adjust here if you switch providers later.

// ---- Helpers ------------------------------------------------------------
async function sunoFetch(path, options = {}) {
  const res = await fetch(SUNO_API_BASE + path, {
    ...options,
    headers: {
      "x-api-key": SUNO_API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: data };
  }
  return { ok: true, data };
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

// ---- MCP server + tools ---------------------------------------------
function buildServer() {
  const server = new McpServer({ name: "suno-mcp", version: "1.0.0" });

  server.tool(
    "generate_song",
    "Generate a song with Suno. Give either a short description (non-custom mode) " +
      "or full lyrics plus a style (custom mode). Returns a taskId — use " +
      "get_song_status to poll for the finished audio.",
    {
      prompt: z
        .string()
        .describe(
          "Description of the song to generate, OR the lyrics themselves if customMode is true"
        ),
      customMode: z
        .boolean()
        .optional()
        .describe("true = prompt is treated as lyrics; provide style/title too"),
      style: z.string().optional().describe("Musical style/genre tags, e.g. 'lofi hip hop'"),
      title: z.string().optional().describe("Song title (custom mode only)"),
      instrumental: z.boolean().optional().describe("true = no vocals"),
    },
    async ({ prompt, customMode, style, title, instrumental }) => {
      const input = customMode
        ? { prompt, tags: style, title, make_instrumental: !!instrumental }
        : { gpt_description_prompt: prompt, make_instrumental: !!instrumental };

      const result = await sunoFetch("/task", {
        method: "POST",
        body: JSON.stringify({
          model: "suno",
          task_type: "music",
          input,
        }),
      });

      if (!result.ok) {
        return toolResult({ error: "Failed to start generation", details: result.error });
      }
      return toolResult(result.data);
    }
  );

  server.tool(
    "get_song_status",
    "Check the status of a song generation job and get the audio URL once ready.",
    {
      taskId: z.string().describe("The task_id returned by generate_song"),
    },
    async ({ taskId }) => {
      const result = await sunoFetch("/task/" + encodeURIComponent(taskId), {
        method: "GET",
      });

      if (!result.ok) {
        return toolResult({ error: "Failed to fetch status", details: result.error });
      }
      return toolResult(result.data);
    }
  );

  return server;
}

// ---- HTTP transport (stateful: sessions persisted across requests) ---
const sessions = new Map(); // sessionId -> { server, transport }

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (!MCP_SERVER_SECRET) return next();
  const auth = req.headers.authorization || "";
  if (auth === "Bearer " + MCP_SERVER_SECRET) return next();
  res.status(401).json({ error: "Unauthorized" });
});

app.post("/mcp", async (req, res) => {
  console.log("[mcp] incoming request", JSON.stringify(req.body)?.slice(0, 300));
  try {
    const sessionId = req.headers["mcp-session-id"];
    let entry = sessionId && sessions.get(sessionId);

    if (!entry) {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          sessions.set(newId, entry);
          console.log("[mcp] session initialized:", newId);
        },
      });
      entry = { server, transport };
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
    }

    await entry.transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", message: err.message });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const entry = sessionId && sessions.get(sessionId);
  if (!entry) {
    res.status(400).json({ error: "No active session" });
    return;
  }
  await entry.transport.handleRequest(req, res);
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("suno-mcp listening on :" + PORT + " (MCP endpoint: /mcp)");
});
