import * as vscode from "vscode";
import { MuggeEvent, MuggeIpc } from "./ipc";

/** How many chat events are kept for repopulating a webview that was hidden. */
const LOG_LIMIT = 500;

interface Snapshot {
  me: string;
  users: string[];
  typing: string[];
  connected: boolean;
}

/** The sidebar chat: a webview fed by the client's companion socket. */
export class MuggeChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "mugge.chat";

  private view: vscode.WebviewView | undefined;
  private log: MuggeEvent[] = [];
  private snapshot: Snapshot = { me: "", users: [], typing: [], connected: false };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ipc: MuggeIpc,
  ) {
    this.ipc.onEvent((event) => this.handle(event));
    this.ipc.onStatus((status) => this.post({ type: "socket", status }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: { type?: string; text?: string }) => {
      switch (message?.type) {
        case "ready":
          this.replay();
          break;
        case "send":
          if (!this.ipc.send(String(message.text ?? ""))) {
            this.post({ type: "error", text: "Not connected to the mugge client." });
          }
          break;
        case "reconnect":
          this.ipc.reconnect();
          break;
        default:
          break;
      }
    });

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });

    this.ipc.connect();
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${MuggeChatViewProvider.viewType}.focus`);
  }

  private handle(event: MuggeEvent): void {
    switch (event.type) {
      case "hello":
        // A fresh hello replays the recent buffer, so drop what we had.
        this.log = [];
        this.snapshot = {
          me: String(event.me ?? ""),
          users: asStrings(event.users),
          typing: asStrings(event.typing),
          connected: event.connected === true,
        };
        break;
      case "me":
        this.snapshot.me = String(event.name ?? "");
        break;
      case "users":
        this.snapshot.users = asStrings(event.users);
        break;
      case "typing":
        this.snapshot.typing = asStrings(event.users);
        break;
      case "connection":
        this.snapshot.connected = event.connected === true;
        break;
      case "message":
      case "whisper":
      case "notice":
        this.log.push(event);
        if (this.log.length > LOG_LIMIT) {
          this.log = this.log.slice(-LOG_LIMIT);
        }
        break;
      default:
        break;
    }
    this.post(event);
  }

  private replay(): void {
    this.post({
      type: "reset",
      snapshot: this.snapshot,
      status: this.ipc.status,
      log: this.log,
    });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceString();
    const uri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", ...parts));

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${uri("chat.css")}" rel="stylesheet" />
    <title>Mugge</title>
  </head>
  <body>
    <header id="bar">
      <button id="people" type="button" title="Who is online"></button>
      <span id="status"></span>
    </header>
    <ul id="roster" hidden></ul>
    <main id="log" tabindex="0"></main>
    <footer>
      <div id="typing"></div>
      <textarea id="composer" rows="1" placeholder="Message the chat (/help for commands)"></textarea>
    </footer>
    <script nonce="${nonce}" src="${uri("chat.js")}"></script>
  </body>
</html>`;
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function nonceString(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}
