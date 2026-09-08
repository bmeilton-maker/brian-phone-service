import { EventEmitter } from "node:events";
import type { WsLike } from "./realtime.js";

/** In-memory WebSocket stand-in for tests and the demo. Records everything the client sends. */
export class FakeWs extends EventEmitter implements WsLike {
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.emit("close", 1000, "closed"); }
}
