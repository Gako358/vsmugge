import * as net from "net";
import { join } from "path";
import * as vscode from "vscode";

export type MuggeEvent = {
  type: string;
  [key: string]: unknown;
};

export type IpcStatus = "connecting" | "online" | "offline";

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;

export function defaultIpcSocketPath(): string {
  const configured = vscode.workspace.getConfiguration("mugge").get<string>("ipcSocketPath", "");
  if (configured) {
    return configured;
  }
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  if (!runtimeDir) {
    throw new Error("Mugge: XDG_RUNTIME_DIR is unset; set mugge.ipcSocketPath");
  }
  return join(runtimeDir, "mugge-ipc.sock");
}

/**
 * Line client for the mugge client's companion socket: JSON events in, plain
 * chat lines out. Reconnects on its own, because the background service is
 * restarted independently of VS Code.
 */
export class MuggeIpc implements vscode.Disposable {
  private socket: net.Socket | undefined;
  private buffer = "";
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelay = RETRY_MIN_MS;
  private disposed = false;

  private readonly eventEmitter = new vscode.EventEmitter<MuggeEvent>();
  private readonly statusEmitter = new vscode.EventEmitter<IpcStatus>();

  readonly onEvent = this.eventEmitter.event;
  readonly onStatus = this.statusEmitter.event;

  private currentStatus: IpcStatus = "offline";

  get status(): IpcStatus {
    return this.currentStatus;
  }

  connect(): void {
    if (this.disposed || this.socket) {
      return;
    }
    this.clearRetry();

    let path: string;
    try {
      path = defaultIpcSocketPath();
    } catch (err) {
      this.setStatus("offline");
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      return;
    }

    this.setStatus("connecting");
    const socket = net.createConnection(path);
    this.socket = socket;
    socket.setEncoding("utf8");

    socket.on("connect", () => {
      this.retryDelay = RETRY_MIN_MS;
      this.buffer = "";
      this.setStatus("online");
    });
    socket.on("data", (chunk: string) => this.ingest(chunk));
    socket.on("error", () => {
      /* handled by 'close' */
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      socket.destroy();
      this.setStatus("offline");
      this.scheduleRetry();
    });
  }

  /** Drops the current connection and reconnects immediately. */
  reconnect(): void {
    this.clearRetry();
    this.retryDelay = RETRY_MIN_MS;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.connect();
  }

  send(line: string): boolean {
    const text = line.replace(/[\r\n]+/g, " ").trim();
    if (!text || !this.socket || this.currentStatus !== "online") {
      return false;
    }
    this.socket.write(text + "\n");
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    this.socket?.destroy();
    this.socket = undefined;
    this.eventEmitter.dispose();
    this.statusEmitter.dispose();
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as MuggeEvent;
        if (parsed && typeof parsed.type === "string") {
          this.eventEmitter.fire(parsed);
        }
      } catch {
        // A truncated or future-shaped line is not worth tearing the socket down.
      }
    }
  }

  private setStatus(status: IpcStatus): void {
    if (this.currentStatus !== status) {
      this.currentStatus = status;
      this.statusEmitter.fire(status);
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
      this.connect();
    }, this.retryDelay);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
