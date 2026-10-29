import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { HarnessSession } from "../../contracts/ui/state.js";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_ACTIVITY_ITEMS = 60;
const MAX_ACTIVITY_TEXT_BYTES = 256 * 1024;
const MAX_VISIBLE_COMMAND_BYTES = 16 * 1024;
const RPC_TIMEOUT_MS = 90_000;

type RpcId = string | number;
type HarnessChild = ChildProcessByStdio<Writable, Readable, null>;
type UserQuestion = { id: string; header: string; question: string; options: { label: string; description: string }[]; secret: boolean };
type ApprovalTicket = {
  readonly id: string;
  readonly rpcId: RpcId;
  readonly kind: "command" | "file_change" | "question";
  readonly command?: string | null;
  readonly questions?: readonly UserQuestion[];
  questionIndex?: number;
  answers?: Record<string, { answers: string[] }>;
  readonly reason: string;
  readonly cwd?: string | null;
};
type RpcRequest = { resolve(value: unknown): void; reject(): void; timeout: ReturnType<typeof setTimeout> };
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum ? value : undefined;
}
function rpcId(value: unknown): value is RpcId {
  return (typeof value === "string" && value.length <= 256) || (typeof value === "number" && Number.isSafeInteger(value));
}
function errorCode(error: unknown): NonNullable<HarnessSession["error"]> {
  if (record(error) && error.code === "ENOENT") return "CODEX_NOT_FOUND";
  return "CODEX_START_FAILED";
}

async function codexExecutable(): Promise<string> {
  if (process.platform === "win32") return "codex";
  const fromPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "codex"));
  const candidates = [...new Set([...fromPath, join(homedir(), ".local", "bin", "codex")])];
  for (const candidate of candidates) {
    try { await access(candidate, fsConstants.X_OK); return candidate; }
    catch { /* Continue through the user's launch PATH and standard local install location. */ }
  }
  throw Object.assign(new Error("Codex CLI is unavailable."), { code: "ENOENT" });
}

/** Local Codex app-server client. It uses stdio JSONL and never invokes a shell. */
export class CodexAppServer {
  private child: HarnessChild | undefined;
  private nextRpcId = 1;
  private stdoutBuffer = "";
  private readonly rpcRequests = new Map<string, RpcRequest>();
  private readonly approvals: ApprovalTicket[] = [];
  private activeApproval: ApprovalTicket | undefined;
  private activeTurnId: string | undefined;
  private stopping = false;
  private session: HarnessSession = { status: "idle", workspace: null, thread_id: null, activity: [], approval: null, error: null };
  constructor(private readonly onChange: (session: HarnessSession) => void) {}

  snapshot(): HarnessSession {
    return structuredClone(this.session);
  }

  async start(workspacePath: string, workspaceLabel: string, goal: string): Promise<HarnessSession> {
    if (this.child) throw new Error("A Codex session is already active.");
    this.session = { status: "starting", workspace: workspaceLabel, thread_id: null, activity: [], approval: null, error: null };
    this.publish();
    this.stopping = false;
    try {
      const executable = await codexExecutable();
      const binaryDirectory = dirname(executable);
      const path = process.env.PATH ?? "";
      const child = spawn(executable, ["app-server", "--stdio"], { cwd: workspacePath,
        env: { ...process.env, ...(binaryDirectory !== "." ? { PATH: path ? `${binaryDirectory}${delimiter}${path}` : binaryDirectory } : {}) },
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consume(chunk));
      child.on("error", (error: NodeJS.ErrnoException) => this.fail(error.code === "ENOENT" ? "CODEX_NOT_FOUND" : "CODEX_START_FAILED"));
      child.on("close", () => {
        if (this.child === child) this.child = undefined;
        this.rejectPending();
        if (!this.stopping && this.session.status !== "error") this.fail("CODEX_PROTOCOL_FAILED");
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Codex startup timed out.")), 10_000);
        timeout.unref();
        child.once("spawn", () => { clearTimeout(timeout); resolve(); });
        child.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timeout); reject(error); });
      });
      await this.request("initialize", { clientInfo: { name: "openwhisper", title: "OpenWhisper Voice Workspace", version: "0.4.2" },
        capabilities: { experimentalApi: true, requestAttestation: false } });
      this.notifyServer("initialized");
      const threadResponse = await this.request("thread/start", { cwd: workspacePath, approvalPolicy: "on-request",
        approvalsReviewer: "user", sandbox: "workspace-write" });
      const thread = record(threadResponse) && record(threadResponse.thread) ? threadResponse.thread : undefined;
      const threadId = thread && boundedString(thread.id, 256);
      if (!threadId) throw new Error("Codex returned an invalid session.");
      this.session.thread_id = threadId;
      this.session.status = "ready";
      this.addActivity("openwhisper", "activity", "Codex session connected. The selected folder is the writable workspace; other changes require approval.");
      this.addActivity("you", "message", goal);
      await this.sendTurn(goal);
      return this.snapshot();
    } catch (error: unknown) {
      if (this.session.status !== "error") this.fail(errorCode(error));
      await this.closeProcess();
      return this.snapshot();
    }
  }

  async sendMessage(text: string): Promise<HarnessSession> {
    if (!this.child || !this.session.thread_id) throw new Error("Start a Codex session first.");
    if (this.activeApproval) throw new Error("Resolve the current Codex request first.");
    this.addActivity("you", "message", text);
    try { await this.sendTurn(text); }
    catch { this.fail("CODEX_SESSION_FAILED"); }
    return this.snapshot();
  }

  async respondApproval(id: string, decision: "accept" | "decline" | "cancel"): Promise<HarnessSession> {
    const approval = this.activeApproval;
    if (!approval || approval.id !== id || approval.kind === "question") throw new Error("This Codex approval is no longer active.");
    this.activeApproval = undefined;
    this.sendServerResponse(approval.rpcId, { decision });
    this.addActivity("openwhisper", "activity", decision === "accept" ? "You approved this one request." : "You declined this request.");
    this.showNextApproval();
    return this.snapshot();
  }

  async answerQuestion(id: string, answer: string): Promise<HarnessSession> {
    const approval = this.activeApproval;
    if (!approval || approval.id !== id || approval.kind !== "question" || !approval.questions) throw new Error("This Codex question is no longer active.");
    const question = approval.questions[approval.questionIndex ?? 0];
    if (!question) throw new Error("This Codex question is no longer active.");
    (approval.answers ??= {})[question.id] = { answers: [answer] };
    this.addActivity("you", "message", answer);
    const nextIndex = (approval.questionIndex ?? 0) + 1;
    if (nextIndex < approval.questions.length) approval.questionIndex = nextIndex;
    else {
      this.activeApproval = undefined;
      this.sendServerResponse(approval.rpcId, { answers: approval.answers });
      this.showNextApproval();
    }
    this.publish();
    return this.snapshot();
  }

  async stop(): Promise<HarnessSession> {
    if (this.activeTurnId && this.session.thread_id && this.child) {
      await this.request("turn/interrupt", { threadId: this.session.thread_id, turnId: this.activeTurnId }).catch(() => {});
    }
    this.stopping = true;
    for (const approval of [this.activeApproval, ...this.approvals]) {
      if (approval) this.sendServerResponse(approval.rpcId, { decision: "cancel" });
    }
    this.activeApproval = undefined;
    this.approvals.length = 0;
    this.session = { ...this.session, status: "idle", thread_id: null, approval: null, error: null };
    this.publish();
    await this.closeProcess();
    return this.snapshot();
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.rejectPending();
    await this.closeProcess();
  }

  private async sendTurn(text: string): Promise<void> {
    const threadId = this.session.thread_id;
    if (!threadId || !this.child) throw new Error("Codex session is unavailable.");
    const input = [{ type: "text", text, text_elements: [] }];
    const result = this.activeTurnId
      ? await this.request("turn/steer", { threadId, expectedTurnId: this.activeTurnId, input })
      : await this.request("turn/start", { threadId, input });
    const turn = record(result) && record(result.turn) ? result.turn : undefined;
    const turnId = turn && boundedString(turn.id, 256);
    if (turnId) this.activeTurnId = turnId;
    this.session.status = "working";
    this.publish();
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES) { this.fail("CODEX_PROTOCOL_FAILED"); void this.closeProcess(); return; }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line) as unknown; } catch { this.fail("CODEX_PROTOCOL_FAILED"); void this.closeProcess(); return; }
      this.receive(message);
    }
  }

  private receive(input: unknown): void {
    if (!record(input)) return;
    if (rpcId(input.id) && (Object.hasOwn(input, "result") || Object.hasOwn(input, "error"))) {
      const pending = this.rpcRequests.get(String(input.id));
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.rpcRequests.delete(String(input.id));
      if (Object.hasOwn(input, "error")) pending.reject();
      else pending.resolve(input.result);
      return;
    }
    if (rpcId(input.id) && typeof input.method === "string") {
      this.handleServerRequest(input.id, input.method, input.params);
      return;
    }
    if (typeof input.method === "string") this.handleNotification(input.method, input.params);
  }

  private handleServerRequest(id: RpcId, method: string, rawParams: unknown): void {
    const params = record(rawParams) ? rawParams : {};
    if (method === "item/commandExecution/requestApproval") {
      const command = boundedString(params.command, MAX_VISIBLE_COMMAND_BYTES);
      const cwd = boundedString(params.cwd, 4096);
      this.queueApproval({ id: randomUUID(), rpcId: id, kind: "command", command: command ?? null,
        reason: boundedString(params.reason, 4096) ?? "Codex requested permission to run a command.",
        ...(cwd !== undefined ? { cwd } : {}) });
    } else if (method === "item/fileChange/requestApproval") {
      const cwd = boundedString(params.cwd, 4096);
      this.queueApproval({ id: randomUUID(), rpcId: id, kind: "file_change",
        reason: boundedString(params.reason, 4096) ?? "Codex requested permission to apply file changes.",
        ...(cwd !== undefined ? { cwd } : {}) });
    } else if (method === "item/tool/requestUserInput") {
      const questions = this.parseQuestions(params.questions);
      if (questions.length === 0) { this.sendServerError(id, "The question request could not be displayed."); return; }
      this.queueApproval({ id: randomUUID(), rpcId: id, kind: "question", questions, questionIndex: 0,
        reason: questions[0]?.question ?? "Codex needs your input." });
    } else {
      this.sendServerError(id, "This request type is not supported in the Voice Workspace.");
      this.addActivity("openwhisper", "activity", "Codex requested an unsupported action. OpenWhisper rejected it.");
    }
  }

  private parseQuestions(value: unknown): UserQuestion[] {
    if (!Array.isArray(value) || value.length > 8) return [];
    const questions: UserQuestion[] = [];
    for (const raw of value) {
      if (!record(raw)) return [];
      const id = boundedString(raw.id, 256), question = boundedString(raw.question, 8192);
      if (!id || !question) return [];
      const options = Array.isArray(raw.options) ? raw.options.slice(0, 12).flatMap((option) => {
        if (!record(option)) return [];
        const label = boundedString(option.label, 1024), description = boundedString(option.description, 2048);
        return label && description ? [{ label, description }] : [];
      }) : [];
      questions.push({ id, question, header: boundedString(raw.header, 256) ?? "Codex question", options, secret: raw.isSecret === true });
    }
    return questions;
  }

  private queueApproval(approval: ApprovalTicket): void {
    this.approvals.push(approval);
    this.showNextApproval();
  }

  private showNextApproval(): void {
    if (!this.activeApproval) this.activeApproval = this.approvals.shift();
    const approval = this.activeApproval;
    if (approval) {
      const workspace = approval.cwd ? approval.cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? null : null;
      if (approval.kind === "question") {
        const question = approval.questions?.[approval.questionIndex ?? 0];
        this.session.approval = question ? { kind: "question", id: approval.id, title: question.header,
          details: question.question, options: question.options, secret: question.secret } : null;
      } else if (approval.kind === "command") {
        this.session.approval = { kind: "command", id: approval.id, title: "Codex requests command approval",
          details: approval.reason, command: approval.command ?? null, working_directory: workspace };
      } else {
        this.session.approval = { kind: "file_change", id: approval.id, title: "Codex requests file change approval",
          details: approval.reason, working_directory: workspace };
      }
      this.session.status = "waiting";
    } else {
      this.session.approval = null;
      if (this.session.status === "waiting") this.session.status = this.activeTurnId ? "working" : "ready";
    }
    this.publish();
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = record(rawParams) ? rawParams : {};
    if (method === "turn/started") {
      const turn = record(params.turn) ? params.turn : undefined;
      this.activeTurnId = turn && boundedString(turn.id, 256) || undefined;
      this.session.status = "working";
      this.addActivity("openwhisper", "activity", "Codex started working on the current request.");
    } else if (method === "item/agentMessage/delta") {
      const itemId = boundedString(params.itemId, 256), delta = boundedString(params.delta, MAX_ACTIVITY_TEXT_BYTES);
      if (itemId && delta) this.appendAgentMessage(itemId, delta);
    } else if (method === "item/started") {
      const item = record(params.item) ? params.item : undefined;
      if (item) this.startedItem(item);
    } else if (method === "item/completed") {
      const item = record(params.item) ? params.item : undefined;
      if (item) this.completedItem(item);
    } else if (method === "turn/completed") {
      this.activeTurnId = undefined;
      const turn = record(params.turn) ? params.turn : undefined;
      this.session.status = this.activeApproval ? "waiting" : "ready";
      if (!turn || turn.status !== "failed") this.addActivity("openwhisper", "activity", "Codex finished this turn.");
      else this.addActivity("openwhisper", "activity", "Codex could not complete this turn. You can send another instruction.");
      this.publish();
    }
  }

  private startedItem(item: RecordValue): void {
    const id = boundedString(item.id, 256);
    if (item.type === "agentMessage" && id) this.ensureAgentMessage(id);
    else if (item.type === "commandExecution") this.addActivity("openwhisper", "activity", "Codex is running a command in the selected workspace.");
    else if (item.type === "fileChange") this.addActivity("openwhisper", "activity", "Codex is preparing file changes.");
    else if (item.type === "mcpToolCall") this.addActivity("openwhisper", "activity", "Codex is using an integration.");
  }

  private completedItem(item: RecordValue): void {
    const id = boundedString(item.id, 256);
    if (item.type === "agentMessage" && id) {
      const text = boundedString(item.text, MAX_ACTIVITY_TEXT_BYTES);
      const activity = this.session.activity.find((entry) => entry.id === `codex-${id}`);
      if (activity && text) activity.text = text;
      if (activity) activity.streaming = false;
      this.publish();
    } else if (item.type === "commandExecution") {
      this.addActivity("openwhisper", "activity", "Codex finished a command.");
    } else if (item.type === "fileChange") this.addActivity("openwhisper", "activity", "Codex applied file changes in the workspace.");
  }

  private ensureAgentMessage(itemId: string): HarnessSession["activity"][number] | undefined {
    const id = `codex-${itemId}`;
    let message = this.session.activity.find((entry) => entry.id === id);
    if (!message) {
      message = { id, speaker: "codex", kind: "message", text: "", streaming: true };
      this.session.activity.push(message);
      this.trimActivity();
    }
    return message;
  }

  private appendAgentMessage(itemId: string, delta: string): void {
    const message = this.ensureAgentMessage(itemId);
    if (!message) return;
    if (Buffer.byteLength(message.text + delta, "utf8") <= MAX_ACTIVITY_TEXT_BYTES) message.text += delta;
    else if (!message.text.endsWith("[Further output hidden]") && Buffer.byteLength(message.text + "\n[Further output hidden]", "utf8") <= MAX_ACTIVITY_TEXT_BYTES) {
      message.text += "\n[Further output hidden]";
      message.streaming = false;
    }
    this.publish();
  }

  private addActivity(speaker: "you" | "codex" | "openwhisper", kind: "message" | "activity", text: string): void {
    this.session.activity.push({ id: randomUUID(), speaker, kind, text, streaming: false });
    this.trimActivity();
    this.publish();
  }

  private trimActivity(): void {
    if (this.session.activity.length > MAX_ACTIVITY_ITEMS) this.session.activity.splice(0, this.session.activity.length - MAX_ACTIVITY_ITEMS);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error("Codex is unavailable."));
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.rpcRequests.delete(String(id)); reject(new Error("Codex did not respond.")); }, RPC_TIMEOUT_MS);
      timeout.unref();
      this.rpcRequests.set(String(id), { resolve, reject, timeout });
      try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }
      catch { clearTimeout(timeout); this.rpcRequests.delete(String(id)); reject(new Error("Codex request failed.")); }
    });
  }

  private notifyServer(method: string): void {
    const child = this.child;
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private sendServerResponse(id: RpcId, result: unknown): void {
    const child = this.child;
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private sendServerError(id: RpcId, message: string): void {
    const child = this.child;
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
  }

  private rejectPending(): void {
    for (const pending of this.rpcRequests.values()) { clearTimeout(pending.timeout); pending.reject(); }
    this.rpcRequests.clear();
  }

  private fail(error: NonNullable<HarnessSession["error"]>): void {
    this.session.status = "error";
    this.session.error = error;
    this.session.approval = null;
    this.publish();
  }

  private publish(): void {
    this.onChange(this.snapshot());
  }

  private async closeProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
      timeout.unref();
      child.once("close", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
    if (this.child === child) this.child = undefined;
  }
}
