// Shows the images Icon Studio saved for emoji wherever that emoji is text on a page.
//
//   <script src="icon_registry.js"></script>
//   <script src="icon_swap.js"></script>
//
// The registry script goes first. If the registry's variable is not window.OS_ICON_REGISTRY, name it
// on this tag: <script src="icon_swap.js" data-registry="window.MyIcons"></script>.
// Emoji in attributes (title, placeholder), <option>s and <textarea>s stay emoji. Put
// data-keep-emoji on an element to leave it alone.
(function () {
    const script = document.currentScript;
    const name = (script && script.getAttribute('data-registry')) || 'window.OS_ICON_REGISTRY';
    const registry = name.split('.').filter(part => part !== 'window').reduce((o, part) => o && o[part], window);
    const group = registry && registry.emoji;
    if (!group) return;
    // Registry image paths are relative to the folder this script sits in (the registry's web root).
    const root = script && script.src ? new URL('.', script.src).href : '';
    const images = new Map();
    for (const [key, entry] of Object.entries(group)) {
        if (entry && entry.type === 'image' && entry.value) {
            const emoji = String.fromCodePoint(...key.split('_').map(h => parseInt(h, 16)));
            images.set(emoji, /^(https?|data):/.test(entry.value) ? entry.value : root + entry.value);
        }
    }
    if (!images.size) return;

    // U+FE0F may follow any character in the source. A skin tone or ZWJ after the match means a
    // longer emoji that has no image of its own, so leave it whole.
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = '(?:' + [...images.keys()].sort((a, b) => b.length - a.length)
        .map(e => [...e].map(ch => escape(ch) + '\\uFE0F?').join('')).join('|') +
        ')(?![\\uFE0F\\u200D\\u{1F3FB}-\\u{1F3FF}])';
    const test = new RegExp(pattern, 'u');
    const find = new RegExp(pattern, 'gu');
    const SKIP = 'script,style,textarea,input,select,option,title,noscript,svg,[contenteditable],[data-keep-emoji],.os-emoji-icon';

    function skinTextNode(node) {
        const parent = node.parentElement;
        const text = node.nodeValue;
        if (!parent || !test.test(text) || parent.closest(SKIP)) return;
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const m of text.matchAll(find)) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const icon = document.createElement('span');
            icon.className = 'os-emoji-icon';
            icon.style.backgroundImage = 'url("' + images.get(m[0].replace(/️/g, '')) + '")';
            // The emoji stays in the DOM (invisible), so textContent checks and copy/paste still see it.
            const hidden = document.createElement('span');
            hidden.textContent = m[0];
            icon.appendChild(hidden);
            frag.appendChild(icon);
            last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        parent.replaceChild(frag, node);
    }

    function skin(node) {
        if (node.nodeType === Node.TEXT_NODE) return skinTextNode(node);
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const hits = [];
        while (walker.nextNode()) if (test.test(walker.currentNode.nodeValue)) hits.push(walker.currentNode);
        hits.forEach(skinTextNode);
    }

    function start() {
        const style = document.createElement('style');
        style.textContent = '.os-emoji-icon{display:inline-block;position:relative;width:1em;height:1em;vertical-align:-0.125em;' +
            'font-size:inherit!important;' +
            'background-position:center;background-size:contain;background-repeat:no-repeat;overflow:hidden}' +
            '.os-emoji-icon>span{position:absolute;inset:0;opacity:0}';
        document.head.appendChild(style);
        skin(document.body);
        new MutationObserver(records => {
            for (const r of records) {
                if (r.type === 'characterData') skin(r.target);
                else r.addedNodes.forEach(skin);
            }
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
