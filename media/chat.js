// @ts-check
(function () {
    const vscode = acquireVsCodeApi();

    const logEl = document.getElementById('log');
    const rosterEl = document.getElementById('roster');
    const peopleEl = document.getElementById('people');
    const statusEl = document.getElementById('status');
    const typingEl = document.getElementById('typing');
    const composerEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('composer'));

    let me = '';
    let users = [];
    let connected = false;
    let socketStatus = 'connecting';
    let lastSender = null;

    const userColors = [
        'var(--vscode-charts-red, #f14c4c)',
        'var(--vscode-charts-blue, #3794ff)',
        'var(--vscode-charts-yellow, #cca700)',
        'var(--vscode-charts-orange, #d18616)',
        'var(--vscode-charts-green, #89d185)',
        'var(--vscode-charts-purple, #b180d7)',
    ];

    function nameColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = (hash * 31 + name.charCodeAt(i)) | 0;
        }
        return userColors[((hash % userColors.length) + userColors.length) % userColors.length];
    }

    function atBottom() {
        return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    }

    function scroll() {
        logEl.scrollTop = logEl.scrollHeight;
    }

    function clearLog() {
        logEl.textContent = '';
        lastSender = null;
    }

    /** Inline markup: links, @mentions, bold, italic, strikethrough, inline code. */
    function withInlineMarkup(text) {
        const fragment = document.createDocumentFragment();
        const pattern = /https?:\/\/[^\s"'<>)\]]+|@(\w+)|`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~/g;
        let index = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match.index > index) {
                fragment.append(text.slice(index, match.index));
            }
            if (match[1] !== undefined) {
                const mention = document.createElement('span');
                mention.className = 'mention';
                if (me && match[1].toLowerCase() === me.toLowerCase()) {
                    mention.classList.add('mention-me');
                }
                mention.textContent = match[0];
                fragment.append(mention);
            } else if (match[2] !== undefined) {
                const code = document.createElement('code');
                code.textContent = match[2];
                fragment.append(code);
            } else if (match[3] !== undefined) {
                const bold = document.createElement('strong');
                bold.textContent = match[3];
                fragment.append(bold);
            } else if (match[4] !== undefined) {
                const em = document.createElement('em');
                em.textContent = match[4];
                fragment.append(em);
            } else if (match[5] !== undefined) {
                const del = document.createElement('del');
                del.textContent = match[5];
                fragment.append(del);
            } else {
                const anchor = document.createElement('a');
                anchor.href = match[0];
                anchor.textContent = match[0];
                fragment.append(anchor);
            }
            index = match.index + match[0].length;
        }
        if (index < text.length) {
            fragment.append(text.slice(index));
        }
        return fragment;
    }

    function entry(kind, extraClass) {
        const el = document.createElement('div');
        el.className = 'entry ' + kind + (extraClass ? ' ' + extraClass : '');
        return el;
    }

    function header(el, name, time) {
        const who = document.createElement('div');
        who.className = 'who';
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = name;
        nameEl.style.color = nameColor(name);
        who.append(nameEl);
        if (time) {
            const timeEl = document.createElement('span');
            timeEl.className = 'time';
            timeEl.textContent = time;
            who.append(timeEl);
        }
        el.append(who);
    }

    function body(el, text, isCode, lang) {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'body';
        if (isCode) {
            const pre = document.createElement('pre');
            if (lang) {
                pre.dataset.lang = lang;
            }
            pre.textContent = text;
            bodyEl.append(pre);
        } else {
            bodyEl.append(withInlineMarkup(text));
        }
        el.append(bodyEl);
    }

    function appendMessage(event) {
        const stick = atBottom();
        const sender = String(event.sender || '');
        const mine = !!me && sender.toLowerCase() === me.toLowerCase();
        const el = entry('message', (mine ? 'mine ' : '') + (event.history ? 'history' : ''));
        // Consecutive lines from one sender read as a block, like a chat app.
        if (sender !== lastSender) {
            header(el, sender, String(event.time || ''));
        }
        body(el, String(event.text || ''), event.code === true, String(event.lang || ''));
        logEl.append(el);
        lastSender = sender;
        if (stick) {
            scroll();
        }
    }

    function appendWhisper(event) {
        const stick = atBottom();
        const peer = String(event.peer || '');
        const label = event.incoming ? '✉ ' + peer + ' → you' : '✉ you → ' + peer;
        const el = entry('whisper');
        header(el, label, String(event.time || ''));
        body(el, String(event.text || ''), false, '');
        logEl.append(el);
        lastSender = null;
        if (stick) {
            scroll();
        }
    }

    function appendNotice(text, kind) {
        const stick = atBottom();
        const el = entry(kind || 'notice');
        body(el, text, false, '');
        logEl.append(el);
        lastSender = null;
        if (stick) {
            scroll();
        }
    }

    function renderRoster() {
        peopleEl.textContent = 'Online ' + users.length;
        rosterEl.textContent = '';
        for (const user of users) {
            const li = document.createElement('li');
            const dot = document.createElement('span');
            dot.className = 'dot';
            const name = document.createElement('span');
            name.textContent = user;
            name.style.color = nameColor(user);
            li.append(dot, name);
            rosterEl.append(li);
        }
    }

    function renderStatus() {
        let text = '';
        if (socketStatus !== 'online') {
            text = 'waiting for the mugge client…';
        } else if (!connected) {
            text = 'client offline — reconnecting…';
        }
        statusEl.textContent = text;
        statusEl.classList.toggle('warn', text !== '');
        composerEl.disabled = socketStatus !== 'online' || !connected;
    }

    function renderTyping(list) {
        if (!list.length) {
            typingEl.textContent = '';
        } else if (list.length === 1) {
            typingEl.textContent = list[0] + ' is typing…';
        } else {
            typingEl.textContent = list.join(', ') + ' are typing…';
        }
    }

    function apply(event) {
        switch (event.type) {
            case 'hello':
                clearLog();
                me = String(event.me || '');
                users = event.users || [];
                connected = event.connected === true;
                renderRoster();
                renderStatus();
                renderTyping(event.typing || []);
                break;
            case 'message':
                appendMessage(event);
                break;
            case 'whisper':
                appendWhisper(event);
                break;
            case 'notice':
                appendNotice(String(event.text || ''));
                break;
            case 'users':
                users = event.users || [];
                renderRoster();
                break;
            case 'typing':
                renderTyping(event.users || []);
                break;
            case 'me':
                me = String(event.name || '');
                break;
            case 'connection':
                connected = event.connected === true;
                renderStatus();
                break;
            case 'socket':
                socketStatus = String(event.status || 'offline');
                if (socketStatus !== 'online') {
                    connected = false;
                }
                renderStatus();
                break;
            case 'error':
                appendNotice(String(event.text || ''), 'error');
                break;
            default:
                break;
        }
    }

    window.addEventListener('message', (message) => {
        const event = message.data;
        if (!event || typeof event.type !== 'string') {
            return;
        }
        if (event.type === 'reset') {
            clearLog();
            const snapshot = event.snapshot || {};
            me = String(snapshot.me || '');
            users = snapshot.users || [];
            connected = snapshot.connected === true;
            socketStatus = String(event.status || 'offline');
            renderRoster();
            renderStatus();
            renderTyping(snapshot.typing || []);
            for (const logged of event.log || []) {
                apply(logged);
            }
            scroll();
            return;
        }
        apply(event);
    });

    peopleEl.addEventListener('click', () => {
        rosterEl.hidden = !rosterEl.hidden;
    });

    composerEl.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
            keyEvent.preventDefault();
            const text = composerEl.value.trim();
            if (!text) {
                return;
            }
            vscode.postMessage({ type: 'send', text });
            composerEl.value = '';
        }
    });

    statusEl.addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));

    renderRoster();
    renderStatus();
    vscode.postMessage({ type: 'ready' });
})();
