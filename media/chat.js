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
    /**
     * @type {never[]}
     */
    let users = [];
    /** @type {Record<string, string>} */
    let statuses = {};
    /** @type {string[]} */
    let voiceUsers = [];
    /** @type {string[]} */
    let typingUsers = [];
    /** Lower-cased name → time of their latest message, as the server printed it. */
    const lastSpoke = new Map();
    /** Lower-cased names that just came online; highlighted briefly in the roster. */
    const arrivals = new Set();
    let connected = false;
    let socketStatus = 'connecting';
    /**
     * @type {string | null}
     */
    let lastSender = null;
    let mentionSound = 'chime';

    const CURATED_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥', '🤡'];

    /**
     * @type {Map<number, Record<string, string[]>>}
     */
    const reactionState = new Map();

    function playMentionSound() {
        if (mentionSound === 'none') return;
        vscode.postMessage({ type: 'mention' });
    }

    /**
     * @param {string} text
     */
    function textMentionsMe(text) {
        if (!me) return false;
        const pattern = new RegExp('@' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        return pattern.test(text);
    }

    const userColors = [
        'var(--vscode-charts-red, #f14c4c)',
        'var(--vscode-charts-blue, #3794ff)',
        'var(--vscode-charts-yellow, #cca700)',
        'var(--vscode-charts-orange, #d18616)',
        'var(--vscode-charts-green, #89d185)',
        'var(--vscode-charts-purple, #b180d7)',
    ];

    const nickAliases = new Map();

    /**
     * @param {string} name
     */
    function resolveOriginalNick(name) {
        return nickAliases.get(name.toLowerCase()) || name.toLowerCase();
    }

    /**
     * @param {string} text
     */
    function trackNickChange(text) {
        const m = text.match(/^(\S+) is now known as (\S+)$/);
        if (!m) return;
        const oldNick = m[1];
        const newNick = m[2];
        const original = nickAliases.get(oldNick.toLowerCase()) || oldNick.toLowerCase();
        nickAliases.delete(oldNick.toLowerCase());
        nickAliases.set(newNick.toLowerCase(), original);
    }

    // FNV-1a hash for deterministic per-user visual flair.
    /**
     * @param {string} name
     */
    function nameFprint(name) {
        let h = 0x811c9dc5;
        for (let i = 0; i < name.length; i++) {
            h ^= name.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    /**
     * @param {string} name
     */
    function nameColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = (hash * 31 + name.charCodeAt(i)) | 0;
        }
        return userColors[((hash % userColors.length) + userColors.length) % userColors.length];
    }

    // Easter egg: some users randomly get a rainbow name each session.
    const flairSeed = Math.floor(Date.now() / 86400000);
    /**
     * @param {number} fp
     */
    function hasRainbowFlair(fp) {
        const mix = Math.imul(fp ^ flairSeed, 0x45d9f3b) >>> 0;
        const cap = fp === 0x664bd8f4 ? 7 : 3;
        return mix % 17 < cap;
    }

    /**
     * @param {HTMLSpanElement} el
     * @param {any} name
     */
    function styleName(el, name) {
        const original = resolveOriginalNick(name);
        const fp = nameFprint(original);
        if (fp === 0x664bd8f4) {
            el.style.color = '#ff69b4';
        }
        if (hasRainbowFlair(fp)) {
            el.style.background = 'linear-gradient(90deg, #f14c4c, #d18616, #cca700, #89d185, #3794ff, #b180d7)';
            el.style.webkitBackgroundClip = 'text';
            el.style.backgroundClip = 'text';
            el.style.color = 'transparent';
        } else if (fp !== 0x664bd8f4) {
            el.style.color = nameColor(name);
        }
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
        reactionState.clear();
    }

    const imageExts = /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?[^\s]*)?$/i;

    /**
     * Inline markup: links,
     * @mentions , bold, italic, strikethrough, inline code.
     * @param {string} text
     */
    function withInlineMarkup(text) {
        const fragment = document.createDocumentFragment();
        const pattern = /https?:\/\/[^\s"'<>)\]]+|@([\w-]+)|`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~/g;
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
                const url = match[0];
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.textContent = url;
                fragment.append(anchor);
                if (imageExts.test(url)) {
                    const br = document.createElement('br');
                    fragment.append(br);
                    const img = document.createElement('img');
                    img.src = url;
                    img.className = 'media-preview';
                    img.loading = 'lazy';
                    img.alt = '';
                    img.addEventListener('click', () => {
                        img.classList.toggle('media-expanded');
                    });
                    fragment.append(img);
                }
            }
            index = match.index + match[0].length;
        }
        if (index < text.length) {
            fragment.append(text.slice(index));
        }
        return fragment;
    }

    /**
     * @param {string} kind
     * @param {string | undefined} [extraClass]
     */
    function entry(kind, extraClass) {
        const el = document.createElement('div');
        el.className = 'entry ' + kind + (extraClass ? ' ' + extraClass : '');
        return el;
    }

    /**
     * @param {HTMLDivElement} el
     * @param {string | null} name
     * @param {string | null} time
     */
    function header(el, name, time) {
        const who = document.createElement('div');
        who.className = 'who';
        if (name) {
            const nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.textContent = name;
            styleName(nameEl, name);
            who.append(nameEl);
        }
        if (time) {
            const timeEl = document.createElement('span');
            timeEl.className = 'time';
            timeEl.textContent = time;
            who.append(timeEl);
        }
        if (name || time) {
            el.append(who);
        }
    }

    /**
     * @param {HTMLDivElement} el
     * @param {string | null} text
     * @param {boolean} isCode
     * @param {string | undefined} lang
     */
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

    /**
     * @param {{ sender: any; history: any; time: any; text: any; code: boolean; lang: any; id?: any; }} event
     */
    function appendMessage(event) {
        const stick = atBottom();
        const sender = String(event.sender || '');
        const mine = !!me && sender.toLowerCase() === me.toLowerCase();
        const el = entry('message', (mine ? 'mine ' : '') + (event.history ? 'history' : ''));
        const text = String(event.text || '');
        const time = String(event.time || '');
        const isJoinOrPart = / has joined\b| has left\b/i.test(text);
        const isServerJoinOrPart = sender.toUpperCase() === 'SERVER' && isJoinOrPart;
        if (isServerJoinOrPart) {
            el.classList.add('notice', 'join');
            body(el, time ? text + ' ' + time : text, false, '');
            logEl.append(el);
            lastSender = null;
            if (stick) {
                scroll();
            }
            return;
        }
        const id = Number(event.id || 0);
        if (id > 0) {
            el.dataset.msgId = String(id);
        }
        if (sender && time) {
            lastSpoke.set(sender.toLowerCase(), time);
        }
        const forceHeader = event.history || isJoinOrPart;
        // Consecutive lines from one sender read as a block, like a chat app.
        if (sender !== lastSender || forceHeader) {
            header(el, sender, time);
        }
        body(el, text, event.code === true, String(event.lang || ''));
        if (id > 0) {
            renderReactions(el, id, reactionState.get(id) || {});
        }
        logEl.append(el);
        lastSender = sender;
        if (!event.history && textMentionsMe(text)) {
            playMentionSound();
        }
        if (stick) {
            scroll();
        }
    }

    /**
     * @param {HTMLDivElement} el
     * @param {number} msgId
     * @param {Record<string, string[]>} counts
     */
    function renderReactions(el, msgId, counts) {
        let row = /** @type {HTMLDivElement | null} */ (el.querySelector('.reactions'));
        if (!row) {
            row = document.createElement('div');
            row.className = 'reactions';
            el.append(row);
        }
        row.textContent = '';
        for (const emoji of Object.keys(counts)) {
            const users = counts[emoji];
            if (!users || !users.length) continue;
            const mine = !!me && users.some((u) => u.toLowerCase() === me.toLowerCase());
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'reaction-pill' + (mine ? ' mine' : '');
            pill.textContent = emoji + ' ' + users.length;
            pill.title = users.join(', ');
            pill.addEventListener('click', () => toggleReaction(msgId, emoji, mine));
            row.append(pill);
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'reaction-add';
        add.textContent = '+';
        add.title = 'Add reaction';
        add.addEventListener('click', () => showEmojiMenu(add, msgId));
        row.append(add);
    }

    /**
     * @param {number} msgId
     * @param {string} emoji
     * @param {boolean} isMine
     */
    function toggleReaction(msgId, emoji, isMine) {
        vscode.postMessage({ type: isMine ? 'unreact' : 'react', id: msgId, emoji });
    }

    /**
     * @param {HTMLElement} anchorEl
     * @param {number} msgId
     */
    function showEmojiMenu(anchorEl, msgId) {
        for (const stale of document.querySelectorAll('.reaction-menu')) {
            stale.remove();
        }
        const menu = document.createElement('div');
        menu.className = 'reaction-menu';
        for (const emoji of CURATED_EMOJI) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = emoji;
            btn.addEventListener('click', () => {
                vscode.postMessage({ type: 'react', id: msgId, emoji });
                menu.remove();
            });
            menu.append(btn);
        }
        anchorEl.insertAdjacentElement('afterend', menu);
        setTimeout(() => {
            document.addEventListener('click', function onDocClick(e) {
                if (!menu.contains(/** @type {Node} */ (e.target))) {
                    menu.remove();
                    document.removeEventListener('click', onDocClick);
                }
            });
        }, 0);
    }

    /**
     * @param {{ id: any; emoji: any; user: any; added: any; }} event
     */
    function applyReaction(event) {
        const id = Number(event.id || 0);
        if (id <= 0) return;
        const counts = reactionState.get(id) || {};
        const users = new Set(counts[event.emoji] || []);
        const user = String(event.user || '');
        if (event.added) {
            users.add(user);
        } else {
            users.delete(user);
        }
        counts[event.emoji] = Array.from(users);
        reactionState.set(id, counts);
        const el = /** @type {HTMLDivElement | null} */ (logEl.querySelector(`[data-msg-id="${id}"]`));
        if (el) {
            renderReactions(el, id, counts);
        }
    }

    /**
     * @param {{ id: any; counts: any; }} event
     */
    function applyReactionsSnapshot(event) {
        const id = Number(event.id || 0);
        if (id <= 0) return;
        const counts = /** @type {Record<string, string[]>} */ (event.counts || {});
        reactionState.set(id, counts);
        const el = /** @type {HTMLDivElement | null} */ (logEl.querySelector(`[data-msg-id="${id}"]`));
        if (el) {
            renderReactions(el, id, counts);
        }
    }

    /**
     * @param {{ peer: any; incoming: any; time: any; text: any; }} event
     */
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

    /**
     * @param {string} text
     * @param {string | undefined} [kind]
     * @param {string | null} [time]
     */
    function appendNotice(text, kind, time) {
        const stick = atBottom();
        const el = entry(kind || 'notice');
        if (/has joined/i.test(text)) {
            el.classList.add('join');
        }
        header(el, null, time || null);
        body(el, text, false, '');
        logEl.append(el);
        lastSender = null;
        if (stick) {
            scroll();
        }
    }

    /**
     * @param {string[]} list
     * @param {string} name
     */
    function includesName(list, name) {
        const lower = name.toLowerCase();
        return list.some((u) => u.toLowerCase() === lower);
    }

    /**
     * Adds text to the composer, keeping any draft, and focuses it. `atStart` turns the draft into
     * e.g. a whisper; otherwise the text is appended (a mention mid-sentence).
     * @param {string} text
     * @param {boolean} atStart
     */
    function prefillComposer(text, atStart) {
        if (composerEl.disabled) return;
        const draft = composerEl.value;
        if (atStart) {
            composerEl.value = text + draft.replace(/^\/w @\S+ /, '');
        } else {
            composerEl.value = draft + (draft && !/\s$/.test(draft) ? ' ' : '') + text;
        }
        composerEl.focus();
        composerEl.selectionStart = composerEl.selectionEnd = composerEl.value.length;
    }

    /**
     * @param {string} label
     * @param {string} title
     * @param {() => void} onClick
     */
    function rosterAction(label, title, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'roster-action';
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    /**
     * Me first, then whoever is in voice, then everyone else alphabetically.
     * @param {string} a
     * @param {string} b
     */
    function rosterOrder(a, b) {
        const rank = (/** @type {string} */ u) =>
            me && u.toLowerCase() === me.toLowerCase() ? 0 : includesName(voiceUsers, u) ? 1 : 2;
        return rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: 'base' });
    }

    function renderRoster() {
        const inVoice = users.filter((u) => includesName(voiceUsers, u)).length;
        peopleEl.textContent = (rosterEl.hidden ? '▸ ' : '▾ ') + 'Online ' + users.length + (inVoice ? ' · 🎙 ' + inVoice : '');
        rosterEl.textContent = '';
        for (const user of [...users].sort(rosterOrder)) {
            const isMe = !!me && user.toLowerCase() === me.toLowerCase();
            const li = document.createElement('li');
            li.classList.toggle('me', isMe);
            li.classList.toggle('arrived', arrivals.has(user.toLowerCase()));

            const dot = document.createElement('span');
            dot.className = 'dot';
            const main = document.createElement('div');
            main.className = 'roster-main';
            const line = document.createElement('div');
            line.className = 'roster-line';
            const name = document.createElement('span');
            name.className = 'roster-name';
            name.textContent = user;
            styleName(name, user);
            line.append(name);
            if (isMe) {
                const you = document.createElement('span');
                you.className = 'roster-tag';
                you.textContent = 'you';
                line.append(you);
            }
            if (includesName(voiceUsers, user)) {
                const mic = document.createElement('span');
                mic.className = 'roster-icon';
                mic.textContent = '🎙';
                mic.title = 'In voice chat';
                line.append(mic);
            }
            if (includesName(typingUsers, user)) {
                const typing = document.createElement('span');
                typing.className = 'roster-typing';
                typing.textContent = '✎';
                typing.title = 'Typing…';
                line.append(typing);
            }
            main.append(line);
            const status = statuses[user];
            if (status) {
                const statusEl = document.createElement('div');
                statusEl.className = 'roster-status';
                statusEl.textContent = status;
                statusEl.title = status;
                main.append(statusEl);
            }
            li.append(dot, main);

            const spoke = lastSpoke.get(user.toLowerCase());
            li.title = spoke ? 'Last message at ' + spoke : 'No messages seen yet';
            if (!isMe) {
                li.classList.add('clickable');
                li.addEventListener('click', () => prefillComposer('@' + user + ' ', false));
                const actions = document.createElement('span');
                actions.className = 'roster-actions';
                actions.append(
                    rosterAction('✉', 'Whisper to ' + user, () => prefillComposer('/w @' + user + ' ', true)),
                    rosterAction('🔔', 'Send ' + user + ' a desktop ping', () =>
                        vscode.postMessage({ type: 'send', text: '!ping @' + user })
                    )
                );
                li.append(actions);
            }
            rosterEl.append(li);
        }
    }

    /**
     * Highlights users who just came online, but not on the initial list after (re)connecting.
     * @param {string[]} next
     */
    function noteArrivals(next) {
        if (!users.length) return;
        for (const user of next) {
            if (!includesName(users, user)) {
                const key = user.toLowerCase();
                arrivals.add(key);
                setTimeout(() => {
                    arrivals.delete(key);
                    renderRoster();
                }, 4000);
            }
        }
    }

    /**
     * @param {any} snapshot
     */
    function loadPresence(snapshot) {
        users = snapshot.users || [];
        statuses = snapshot.statuses || {};
        voiceUsers = snapshot.voice || [];
        arrivals.clear();
    }

    function renderStatus() {
        let text = '';
        if (socketStatus !== 'online') {
            text = 'waiting for the Bugge client…';
        } else if (!connected) {
            text = 'client offline — reconnecting…';
        }
        statusEl.textContent = text;
        statusEl.classList.toggle('warn', text !== '');
        composerEl.disabled = socketStatus !== 'online' || !connected;
    }

    /**
     * @param {any[]} list
     */
    function renderTyping(list) {
        typingUsers = list;
        renderRoster();
        if (!list.length) {
            typingEl.textContent = '';
        } else if (list.length === 1) {
            typingEl.textContent = list[0] + ' is typing…';
        } else {
            typingEl.textContent = list.join(', ') + ' are typing…';
        }
    }

    /**
     * @param {{ type: any; me: any; users: never[]; connected: boolean; typing: any; text: any; name: any; time: any; status: any; mentionSound: any; }} event
     */
    function apply(event) {
        switch (event.type) {
            case 'hello':
                clearLog();
                me = String(event.me || '');
                loadPresence(event);
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
                trackNickChange(String(event.text || ''));
                appendNotice(String(event.text || ''), undefined, String(event.time || ''));
                break;
            case 'reaction':
                applyReaction(event);
                break;
            case 'reactions':
                applyReactionsSnapshot(event);
                break;
            case 'users':
                noteArrivals(event.users || []);
                users = event.users || [];
                renderRoster();
                break;
            case 'status': {
                const name = String(event.name || '');
                const text = String(event.text || '');
                if (text) {
                    statuses[name] = text;
                } else {
                    delete statuses[name];
                }
                renderRoster();
                break;
            }
            case 'voice':
                voiceUsers = event.users || [];
                renderRoster();
                break;
            case 'typing':
                renderTyping(event.users || []);
                break;
            case 'me':
                me = String(event.name || '');
                renderRoster();
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
                appendNotice(String(event.text || ''), 'error', String(event.time || ''));
                break;
            case 'settings':
                mentionSound = String(event.mentionSound || 'chime');
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
            loadPresence(snapshot);
            connected = snapshot.connected === true;
            socketStatus = String(event.status || 'offline');
            renderRoster();
            renderStatus();
            renderTyping(snapshot.typing || []);
            for (const logged of event.log || []) {
                apply(logged);
            }
            renderRoster();
            scroll();
            return;
        }
        apply(event);
    });

    // The roster's open/closed state survives the webview being hidden and restored.
    rosterEl.hidden = !(vscode.getState() || {}).rosterOpen;
    peopleEl.addEventListener('click', () => {
        rosterEl.hidden = !rosterEl.hidden;
        vscode.setState({ ...(vscode.getState() || {}), rosterOpen: !rosterEl.hidden });
        renderRoster();
    });

    // ── Autocomplete ──
    const completionsEl = document.getElementById('completions');
    const slashCommands = [
        { label: '/help', description: 'Show this help' },
        { label: '/quit', description: 'Leave the chat (client-side)' },
        { label: '!list', description: 'List users online (real name behind a nickname)' },
        { label: '/admins', description: 'List server admins (online/offline)' },
        { label: '/w', description: '@user <message> – Send a private whisper' },
        { label: '/r', description: '<message> – Reply to your most recent whisper' },
        { label: '!ping', description: '@user [count] – Send desktop pings to a user' },
        { label: '!remind', description: '[@user] HH:MM <text> – Set a same-day reminder' },
        { label: '!reminders', description: 'List your pending reminders' },
        { label: '!remind cancel', description: '<id> – Cancel one of your reminders' },
        { label: '!note', description: '<subject>: <text> – Save a private note' },
        { label: '!notes', description: 'List your notes (id, time, subject)' },
        { label: '!note show', description: '<id> – Show one note in full' },
        { label: '!note delete', description: '<id|all> – Delete a note (or all of them)' },
        { label: '/sendfile', description: '@user <path> – Offer a file to a user' },
        { label: '/acceptfile', description: '<id> – Accept an incoming file offer' },
        { label: '/rejectfile', description: '<id> – Reject an incoming file offer' },
        { label: '/voice', description: 'Join/leave voice chat' },
        { label: '/voicetest', description: 'Local mic+speaker self-test' },
        { label: '/mute', description: 'Toggle your microphone while in voice' },
        { label: '/nick', description: '<name> – Set your nickname (/nick reset to clear)' },
        { label: '/status', description: '<text> – Set a status (/status to clear)' },
        { label: '/me', description: 'Action message' },
        { label: '/clear', description: 'Clear chat log' },
    ];
    /**
     * @type {string | any[]}
     */
    let acItems = [];
    let acSelected = -1;
    let acPrefix = '';
    let acTrigger = ''; // '@' or '/'

    function closeAutocomplete() {
        acItems = [];
        acSelected = -1;
        acPrefix = '';
        acTrigger = '';
        completionsEl.hidden = true;
        completionsEl.textContent = '';
    }

    function renderAutocomplete() {
        completionsEl.textContent = '';
        for (let i = 0; i < acItems.length; i++) {
            const li = document.createElement('li');
            li.textContent = acItems[i].label;
            if (acItems[i].description) {
                const desc = document.createElement('span');
                desc.className = 'ac-desc';
                desc.textContent = acItems[i].description;
                li.append(desc);
            }
            if (i === acSelected) {
                li.classList.add('selected');
            }
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                acceptCompletion(i);
            });
            completionsEl.append(li);
        }
        completionsEl.hidden = acItems.length === 0;
    }

    /**
     * @param {number} idx
     */
    function acceptCompletion(idx) {
        const item = acItems[idx];
        if (!item) return;
        const val = composerEl.value;
        const cursor = composerEl.selectionStart;
        const before = val.slice(0, cursor);
        const triggerIdx = before.lastIndexOf(acTrigger);
        if (triggerIdx === -1) {
            closeAutocomplete();
            return;
        }
        const replacement = item.label + ' ';
        const after = val.slice(cursor);
        composerEl.value = val.slice(0, triggerIdx) + replacement + after;
        composerEl.selectionStart = composerEl.selectionEnd = triggerIdx + replacement.length;
        closeAutocomplete();
        composerEl.focus();
    }

    function updateAutocomplete() {
        const val = composerEl.value;
        const cursor = composerEl.selectionStart;
        const before = val.slice(0, cursor);

        // Detect @mention trigger
        const atMatch = before.match(/@([\w-]*)$/);
        if (atMatch) {
            acTrigger = '@';
            acPrefix = atMatch[1].toLowerCase();
            acItems = users
                .filter((u) => u.toLowerCase().startsWith(acPrefix))
                .slice(0, 8)
                .map((u) => ({ label: '@' + u, description: '' }));
            acSelected = acItems.length > 0 ? 0 : -1;
            renderAutocomplete();
            return;
        }

        // Detect /command or !command trigger (only at start of line)
        const cmdMatch = before.match(/^([/!])(\w*)$/);
        if (cmdMatch) {
            acTrigger = cmdMatch[1];
            acPrefix = cmdMatch[2].toLowerCase();
            acItems = slashCommands.filter(
                (c) => c.label.startsWith(acTrigger) && c.label.slice(acTrigger.length).toLowerCase().startsWith(acPrefix)
            );
            acSelected = acItems.length > 0 ? 0 : -1;
            renderAutocomplete();
            return;
        }

        closeAutocomplete();
    }

    composerEl.addEventListener('input', updateAutocomplete);
    composerEl.addEventListener('blur', () => {
        setTimeout(closeAutocomplete, 150);
    });

    composerEl.addEventListener('keydown', (keyEvent) => {
        if (acItems.length > 0) {
            if (keyEvent.key === 'ArrowDown') {
                keyEvent.preventDefault();
                acSelected = (acSelected + 1) % acItems.length;
                renderAutocomplete();
                return;
            }
            if (keyEvent.key === 'ArrowUp') {
                keyEvent.preventDefault();
                acSelected = (acSelected - 1 + acItems.length) % acItems.length;
                renderAutocomplete();
                return;
            }
            if (keyEvent.key === 'Tab' || (keyEvent.key === 'Enter' && !keyEvent.shiftKey)) {
                if (acSelected >= 0) {
                    keyEvent.preventDefault();
                    acceptCompletion(acSelected);
                    return;
                }
            }
            if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                closeAutocomplete();
                return;
            }
        }
        if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
            keyEvent.preventDefault();
            const text = composerEl.value.trim();
            if (!text) {
                return;
            }
            vscode.postMessage({ type: 'send', text });
            composerEl.value = '';
            closeAutocomplete();
        }
    });

    statusEl.addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));

    // ── Message search ──
    const searchToggle = document.getElementById('search-toggle');
    const searchBar = document.getElementById('search-bar');
    const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
    const searchCount = document.getElementById('search-count');
    const searchPrev = document.getElementById('search-prev');
    const searchNext = document.getElementById('search-next');
    const searchClose = document.getElementById('search-close');
    /**
     * @type {{ scrollIntoView: (arg0: { block: string; }) => void; }[] | Element[]}
     */
    let searchMatches = [];
    let searchIdx = -1;

    function clearSearchHighlights() {
        for (const el of logEl.querySelectorAll('.search-hit')) {
            el.classList.remove('search-hit', 'search-current');
        }
        searchMatches = [];
        searchIdx = -1;
        searchCount.textContent = '';
    }

    function runSearch() {
        clearSearchHighlights();
        const query = searchInput.value.trim().toLowerCase();
        if (!query) return;
        const entries = logEl.querySelectorAll('.entry');
        for (const entry of entries) {
            const bodyEl = entry.querySelector('.body');
            if (bodyEl && bodyEl.textContent.toLowerCase().includes(query)) {
                entry.classList.add('search-hit');
                searchMatches.push(entry);
            }
        }
        if (searchMatches.length > 0) {
            searchIdx = searchMatches.length - 1;
            searchMatches[searchIdx].classList.add('search-current');
            searchMatches[searchIdx].scrollIntoView({ block: 'center' });
        }
        searchCount.textContent = searchMatches.length ? searchIdx + 1 + '/' + searchMatches.length : 'No results';
    }

    /**
     * @param {number} delta
     */
    function searchNavigate(delta) {
        if (!searchMatches.length) return;
        searchMatches[searchIdx].classList.remove('search-current');
        searchIdx = (searchIdx + delta + searchMatches.length) % searchMatches.length;
        searchMatches[searchIdx].classList.add('search-current');
        searchMatches[searchIdx].scrollIntoView({ block: 'center' });
        searchCount.textContent = searchIdx + 1 + '/' + searchMatches.length;
    }

    function openSearch() {
        searchBar.hidden = false;
        searchInput.focus();
    }

    function closeSearch() {
        searchBar.hidden = true;
        searchInput.value = '';
        clearSearchHighlights();
    }

    searchToggle.addEventListener('click', () => {
        if (searchBar.hidden) openSearch();
        else closeSearch();
    });
    searchClose.addEventListener('click', closeSearch);
    searchPrev.addEventListener('click', () => searchNavigate(-1));
    searchNext.addEventListener('click', () => searchNavigate(1));
    searchInput.addEventListener('input', runSearch);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchNavigate(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            closeSearch();
        }
    });

    renderRoster();
    renderStatus();
    vscode.postMessage({ type: 'ready' });
})();
