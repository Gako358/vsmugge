import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { MuggeEvent, MuggeIpc } from './ipc';

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
    public static readonly viewType = 'mugge.chat';

    private view: vscode.WebviewView | undefined;
    private log: MuggeEvent[] = [];
    private snapshot: Snapshot = { me: '', users: [], typing: [], connected: false };

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly ipc: MuggeIpc
    ) {
        this.ipc.onEvent((event) => this.handle(event));
        this.ipc.onStatus((status) => this.post({ type: 'socket', status }));
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('mugge.mentionSound')) {
                this.postSettings();
            }
        });
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        view.webview.html = this.html(view.webview);

        view.webview.onDidReceiveMessage((message: { type?: string; text?: string }) => {
            switch (message?.type) {
                case 'ready':
                    this.replay();
                    break;
                case 'send':
                    if (!this.ipc.send(String(message.text ?? ''))) {
                        this.post({ type: 'error', text: 'Not connected to the mugge client.' });
                    }
                    break;
                case 'reconnect':
                    this.ipc.reconnect();
                    break;
                case 'mention':
                    this.playMentionSound();
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
            case 'hello':
                // A fresh hello replays the recent buffer, so drop what we had.
                this.log = [];
                this.snapshot = {
                    me: String(event.me ?? ''),
                    users: asStrings(event.users),
                    typing: asStrings(event.typing),
                    connected: event.connected === true,
                };
                break;
            case 'me':
                this.snapshot.me = String(event.name ?? '');
                break;
            case 'users':
                this.snapshot.users = asStrings(event.users);
                break;
            case 'typing':
                this.snapshot.typing = asStrings(event.users);
                break;
            case 'connection':
                this.snapshot.connected = event.connected === true;
                break;
            case 'message':
            case 'whisper':
            case 'notice':
                this.log.push(event);
                if (this.log.length > LOG_LIMIT) {
                    this.log = this.log.slice(-LOG_LIMIT);
                }
                this.maybeFlashJoin(String(event.text ?? ''));
                break;
            default:
                break;
        }
        this.post(event);
    }

    private replay(): void {
        this.post({
            type: 'reset',
            snapshot: this.snapshot,
            status: this.ipc.status,
            log: this.log,
        });
        this.postSettings();
    }

    private postSettings(): void {
        const mentionSound = vscode.workspace.getConfiguration('mugge').get<string>('mentionSound', 'chime');
        this.post({ type: 'settings', mentionSound });
    }

    private maybeFlashJoin(text: string): void {
        const m = text.match(/^(\S+) has joined/i);
        if (!m) return;
        vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${m[1]} has joined the chat`, cancellable: false },
            () => new Promise<void>((resolve) => setTimeout(resolve, 3000))
        );
    }

    public testMentionSound(): void {
        this.playMentionSound();
    }

    private soundPlaying = false;
    private soundCache = new Map<string, Buffer>();

    private getSoundBuffer(name: string): Buffer {
        const cached = this.soundCache.get(name);
        if (cached) {
            return cached;
        }
        const soundMap: Record<string, { freq: number; duration: number }> = {
            chime: { freq: 1000, duration: 0.15 },
            ping: { freq: 1400, duration: 0.1 },
            pop: { freq: 600, duration: 0.08 },
            bell: { freq: 1047, duration: 0.3 },
        };
        const s = soundMap[name] ?? soundMap['chime'];
        const rate = 44100;
        const samples = Math.floor(rate * s.duration);
        const buf = Buffer.alloc(samples * 2);
        for (let i = 0; i < samples; i++) {
            const t = i / rate;
            const envelope = 1 - t / s.duration;
            const val = Math.sin(2 * Math.PI * s.freq * t) * 0.3 * envelope;
            buf.writeInt16LE(Math.round(val * 32767), i * 2);
        }
        this.soundCache.set(name, buf);
        return buf;
    }

    private playMentionSound(): void {
        const sound = vscode.workspace.getConfiguration('mugge').get<string>('mentionSound', 'chime');
        if (sound === 'none' || this.soundPlaying) {
            return;
        }
        const pcm = this.getSoundBuffer(sound);
        this.soundPlaying = true;
        const proc = spawn('paplay', ['--raw', '--rate=44100', '--channels=1', '--format=s16le'], {
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        proc.stdin.end(pcm);
        proc.on('close', () => {
            this.soundPlaying = false;
        });
        proc.on('error', () => {
            this.soundPlaying = false;
        });
    }

    private post(message: unknown): void {
        void this.view?.webview.postMessage(message);
    }

    private html(webview: vscode.Webview): string {
        const nonce = nonceString();
        const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...parts));

        return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src https:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${uri('chat.css')}" rel="stylesheet" />
    <title>Mugge</title>
  </head>
  <body>
    <header id="bar">
      <button id="people" type="button" title="Who is online"></button>
      <span id="status"></span>
      <button id="search-toggle" type="button" title="Search messages">🔍</button>
    </header>
    <div id="search-bar" hidden>
      <input id="search-input" type="text" placeholder="Search messages…" />
      <span id="search-count"></span>
      <button id="search-prev" type="button" title="Previous match">▲</button>
      <button id="search-next" type="button" title="Next match">▼</button>
      <button id="search-close" type="button" title="Close search">✕</button>
    </div>
    <ul id="roster" hidden></ul>
    <main id="log" tabindex="0"></main>
    <footer>
      <div id="typing"></div>
      <ul id="completions" hidden></ul>
      <textarea id="composer" rows="1" placeholder="Message the chat (/help for commands)"></textarea>
    </footer>
    <script nonce="${nonce}" src="${uri('chat.js')}"></script>
  </body>
</html>`;
    }
}

function asStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function nonceString(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
}
