import Anthropic from "@anthropic-ai/sdk";
import { env, hasLlmKey } from "../env.js";
import { LlmUnavailableError } from "./errors.js";
import { DemoLlmClient } from "./demoLlm.js";

// The seam that makes everything testable: routes and services depend on this interface,
// never on the Anthropic SDK directly. Tests inject a mock that returns canned output —
// including deliberately malformed output — so the whole suite runs without an API key.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema for the tool input — the model is FORCED to call this tool, so it
   *  physically cannot answer in prose. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  system: string;
  user: string;
  tool: ToolSpec;
  maxTokens?: number;
}

export interface ToolCallResult {
  /** The tool input the model produced. Shape-constrained by the schema, but NOT trusted:
   *  semantic validation (Zod) happens in the caller. */
  input: unknown;
  raw: string;
}

export interface StreamTextRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmClient {
  invokeTool(req: ToolCallRequest): Promise<ToolCallResult>;
  /** Stream free-form text, invoking onDelta per chunk; resolves with the full text.
   *  Used where the output is prose bound for human review (drafts) — structured
   *  data always goes through invokeTool's schema instead. */
  streamText(req: StreamTextRequest, onDelta: (text: string) => void): Promise<string>;
}

class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async invokeTool(req: ToolCallRequest): Promise<ToolCallResult> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: req.maxTokens ?? 2048,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name: req.tool.name,
            description: req.tool.description,
            input_schema: req.tool.inputSchema as Anthropic.Tool["input_schema"],
          },
        ],
        // Forced tool choice: structured output is a property of the request, not a hope
        // about the response.
        tool_choice: { type: "tool", name: req.tool.name },
      });
    } catch (err) {
      // Provider/network failures map to the documented 502 taxonomy — the raw SDK error
      // (which can carry provider internals) is logged, never sent to the client.
      console.error("Anthropic invokeTool failed:", err);
      throw new LlmUnavailableError();
    }

    const toolBlock = response.content.find((block) => block.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      // With forced tool_choice this should be unreachable — treated as malformed output
      // rather than an exception so the repair/validation path handles it uniformly.
      return { input: null, raw: JSON.stringify(response.content) };
    }
    return { input: toolBlock.input, raw: JSON.stringify(toolBlock.input) };
  }

  async streamText(req: StreamTextRequest, onDelta: (text: string) => void): Promise<string> {
    try {
      const stream = this.client.messages.stream({
        model: env.ANTHROPIC_MODEL,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      });
      stream.on("text", onDelta);
      const final = await stream.finalMessage();
      return final.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { type: "text"; text: string }).text)
        .join("");
    } catch (err) {
      console.error("Anthropic streamText failed:", err);
      throw new LlmUnavailableError();
    }
  }
}

let overrideClient: LlmClient | null = null;

/** Test seam: inject a mock client. Pass null to restore the real one. */
export function setLlmClient(client: LlmClient | null) {
  overrideClient = client;
}

export function getLlmClient(): LlmClient {
  if (overrideClient) return overrideClient;
  if (env.LLM_MODE === "mock") return new DemoLlmClient();
  if (!hasLlmKey) throw new LlmUnavailableError();
  return new AnthropicLlmClient(env.ANTHROPIC_API_KEY!);
}
