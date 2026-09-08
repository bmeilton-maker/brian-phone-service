import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createService } from "../bootstrap.js";
import { createHttpServer } from "./http.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { MakeCallRequest } from "../types.js";

/**
 * MCP server (stdio) exposing the four phone tools plus answer_question for the needs_user flow.
 * When the xai provider is configured, the HTTP webhook listener is started alongside so Twilio/xAI can reach us.
 */
const { service, xai } = createService();
if (xai) createHttpServer(service, xai).listen(config.port, () => log.info("http.listening", { port: config.port, reason: "xai webhooks" }));

const server = new McpServer({ name: "brian-phone-service", version: "0.1.0" });
const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const ref = { task_id: z.string().optional(), call_id: z.string().optional() };

const authority = z.object({
  may_schedule: z.boolean().optional(), may_reschedule: z.boolean().optional(), may_cancel: z.boolean().optional(),
  may_accept_terms: z.boolean().optional(), may_authorize_amount_up_to: z.number().nullable().optional(),
  may_authorize_repairs: z.boolean().optional(), may_provide_payment_card: z.boolean().optional(), may_disclose: z.array(z.string()).optional(),
}).optional();

server.registerTool("phone_make_call", {
  title: "Place an outbound phone call",
  description: "Start an outbound call on Brian's behalf. Returns immediately with task_id; poll phone_get_status, then phone_get_result. Only pass task-relevant context; never the full knowledge base.",
  inputSchema: {
    recipient_name: z.string(), phone_number: z.string().describe("E.164, e.g. +16145550100"), objective: z.string(),
    relevant_context: z.record(z.string(), z.unknown()).optional(), preferences: z.record(z.string(), z.unknown()).optional(), authority,
    required_outputs: z.array(z.string()), opening_instruction: z.string().optional(), preferred_voice: z.string().optional(),
    max_duration_seconds: z.number().int().positive().optional(), provider: z.enum(["bland", "xai", "mock"]).optional(), idempotency_key: z.string().optional(),
  },
}, async (args) => ok(await service.makeCall(args as MakeCallRequest)));

server.registerTool("phone_get_status", { title: "Get call status", description: "State of a call: queued/dialing/ringing/in_progress/on_hold/needs_user/completed/failed/cancelled, plus a pending question when state is needs_user.", inputSchema: ref },
  async (a) => ok(await service.getStatus(a)));
server.registerTool("phone_get_result", { title: "Get normalized call result", description: "Structured result after completion. Returns {pending:true,status} while the call is still active. Show `summary` to Brian; keep transcript/raw for troubleshooting.", inputSchema: ref },
  async (a) => ok(await service.getResult(a)));
server.registerTool("phone_cancel_call", { title: "Cancel a call", description: "Hang up an active or queued call.", inputSchema: ref },
  async (a) => ok(await service.cancelCall(a)));
server.registerTool("phone_answer_question", { title: "Answer the agent's pending question", description: "Deliver Brian's answer while the agent holds the line (xai/mock only). Use the question id from phone_get_status.pending_question.", inputSchema: { ...ref, question_id: z.string(), answer: z.string() } },
  async (a) => ok(await service.answerQuestion(a, a.question_id, a.answer)));

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("mcp.ready", { default_provider: config.provider });
