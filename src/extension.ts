import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { MuggeIpc } from './ipc';
import { MuggeChatViewProvider } from './view';

const TERMINAL_NAME = 'mugge';
// Caret notation for the dtach detach key (Ctrl-\), matching mugge.el.
const DETACH_KEY = '^\\';

interface Config {
    socketPath: string;
    dtachProgram: string;
    serviceUnit: string;
    startTimeout: number;
}

function config(): Config {
    const cfg = vscode.workspace.getConfiguration('mugge');
    return {
        socketPath: cfg.get<string>('socketPath', ''),
        dtachProgram: cfg.get<string>('dtachProgram', 'dtach'),
        serviceUnit: cfg.get<string>('serviceUnit', 'mugge-chat'),
        startTimeout: cfg.get<number>('startTimeout', 10),
    };
}

function socketPath(cfg: Config): string {
    if (cfg.socketPath) {
        return cfg.socketPath;
    }
    const runtimeDir = process.env['XDG_RUNTIME_DIR'];
    if (!runtimeDir) {
        throw new Error('Mugge: XDG_RUNTIME_DIR is unset; set mugge.socketPath');
    }
    return join(runtimeDir, 'mugge.sock');
}

function systemctl(action: string, unit: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('systemctl', ['--user', action, unit], (err, stdout, stderr) => {
            if (err && action !== 'status') {
                reject(new Error(`Mugge: systemctl --user ${action} ${unit} failed: ${stderr.trim()}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureService(cfg: Config, socket: string): Promise<void> {
    if (existsSync(socket)) {
        return;
    }
    const answer = await vscode.window.showWarningMessage(
        `Mugge chat service (${cfg.serviceUnit}) is not running. Start it?`,
        { modal: true },
        'Start'
    );
    if (answer !== 'Start') {
        throw new Error('Mugge: service not running');
    }
    await systemctl('start', cfg.serviceUnit);
    const deadline = Date.now() + cfg.startTimeout * 1000;
    while (!existsSync(socket) && Date.now() < deadline) {
        await sleep(200);
    }
    if (!existsSync(socket)) {
        throw new Error(`Mugge: timed out waiting for ${socket}`);
    }
}

function findTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find((t) => t.name === TERMINAL_NAME && t.exitStatus === undefined);
}

async function attach(): Promise<void> {
    const existing = findTerminal();
    if (existing) {
        existing.show();
        return;
    }
    const cfg = config();
    const socket = socketPath(cfg);
    await ensureService(cfg, socket);
    const terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        shellPath: cfg.dtachProgram,
        shellArgs: ['-a', socket, '-e', DETACH_KEY],
    });
    terminal.show();
}

function detach(): void {
    const terminal = findTerminal();
    if (!terminal) {
        throw new Error(`Mugge: no ${TERMINAL_NAME} terminal`);
    }
    terminal.dispose();
}

async function serviceStatus(): Promise<void> {
    const cfg = config();
    const output = await systemctl('status', cfg.serviceUnit);
    const doc = await vscode.workspace.openTextDocument({ content: output });
    await vscode.window.showTextDocument(doc, { preview: true });
}

async function serviceStart(): Promise<void> {
    const cfg = config();
    await systemctl('start', cfg.serviceUnit);
    vscode.window.showInformationMessage(`Mugge: started ${cfg.serviceUnit}`);
}

async function serviceStop(): Promise<void> {
    const cfg = config();
    const answer = await vscode.window.showWarningMessage(
        `Stop the mugge chat service (${cfg.serviceUnit}) and disconnect the chat?`,
        { modal: true },
        'Stop'
    );
    if (answer !== 'Stop') {
        return;
    }
    await systemctl('stop', cfg.serviceUnit);
    vscode.window.showInformationMessage(`Mugge: stopped ${cfg.serviceUnit}`);
}

async function selectMentionSound(): Promise<void> {
    const options: { label: string; description: string; value: string }[] = [
        { label: 'None', description: 'Muted — no sound on mention', value: 'none' },
        { label: 'Chime', description: 'A soft two-tone chime', value: 'chime' },
        { label: 'Ping', description: 'A short high-pitched ping', value: 'ping' },
        { label: 'Pop', description: 'A quick pop', value: 'pop' },
        { label: 'Bell', description: 'A classic bell tone', value: 'bell' },
    ];
    const current = vscode.workspace.getConfiguration('mugge').get<string>('mentionSound', 'chime');
    const picked = await vscode.window.showQuickPick(options, {
        placeHolder: `Current: ${current}`,
        title: 'Select Mention Sound',
    });
    if (picked) {
        const cfg = vscode.workspace.getConfiguration('mugge');
        const targets = [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global];
        for (const target of targets) {
            try {
                await cfg.update('mentionSound', picked.value, target);
                return;
            } catch {
                // try next target
            }
        }
        vscode.window.showWarningMessage('Mugge: could not save setting. Set mugge.mentionSound manually.');
    }
}

function register(command: string, handler: () => void | Promise<void>): vscode.Disposable {
    return vscode.commands.registerCommand(command, async () => {
        try {
            await handler();
        } catch (err) {
            vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
    });
}

export function activate(context: vscode.ExtensionContext): void {
    const ipc = new MuggeIpc();
    const chat = new MuggeChatViewProvider(context.extensionUri, ipc);

    context.subscriptions.push(
        ipc,
        vscode.window.registerWebviewViewProvider(MuggeChatViewProvider.viewType, chat),
        register('mugge.chat', () => chat.focus()),
        register('mugge.reconnect', () => ipc.reconnect()),
        register('mugge.attach', attach),
        register('mugge.detach', detach),
        register('mugge.serviceStatus', serviceStatus),
        register('mugge.serviceStart', serviceStart),
        register('mugge.serviceStop', serviceStop),
        register('mugge.selectMentionSound', selectMentionSound),
        register('mugge.testMentionSound', () => chat.testMentionSound())
    );
}

export function deactivate(): void {}
