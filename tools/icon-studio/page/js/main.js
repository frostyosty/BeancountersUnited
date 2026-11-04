// Starts the page once every part is loaded.
api('/registry').then(data => {
    applyRegistry(data);
    MAX_PICK = data.maxPick || MAX_PICK;
    shortPrefix = data.shortPrefix || '';
    renderRegistry();
}).catch(e => setStatus('Could not load the icon registry: ' + e.message, true));
loadTray().catch(e => setStatus('Could not load the drop tray: ' + e.message, true));
