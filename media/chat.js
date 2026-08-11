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
    let mentionSound = 'chime';

    function playMentionSound() {
        if (mentionSound === 'none') return;
        vscode.postMessage({ type: 'mention' });
    }

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

    const imageExts = /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?[^\s]*)?$/i;

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
        const text = String(event.text || '');
        body(el, text, event.code === true, String(event.lang || ''));
        logEl.append(el);
        lastSender = sender;
        if (!event.history && textMentionsMe(text)) {
            playMentionSound();
        }
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

    // ── Autocomplete ──
    const completionsEl = document.getElementById('completions');
    const slashCommands = [
        { label: '/help', description: 'Show available commands' },
        { label: '/me', description: 'Action message' },
        { label: '/nick', description: 'Change nickname' },
        { label: '/msg', description: 'Send a whisper' },
        { label: '/quit', description: 'Disconnect' },
        { label: '/clear', description: 'Clear chat log' },
    ];
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
        const atMatch = before.match(/@(\w*)$/);
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

        // Detect /command trigger (only at start of line)
        const slashMatch = before.match(/^\/(\w*)$/);
        if (slashMatch) {
            acTrigger = '/';
            acPrefix = slashMatch[1].toLowerCase();
            acItems = slashCommands.filter((c) => c.label.slice(1).toLowerCase().startsWith(acPrefix));
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
