// src/utils/debugLogger.js
console.log("--- [DebugLogger] Initializing... ---");

window.__LOG_HISTORY__ = [];
const MAX_LOGS = 200;

// Capture the original console methods
const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info
};

// Helper to intercept logs
function captureLog(type, args) {
    try {
        const timestamp = new Date().toLocaleTimeString('en-NZ', { hour12: false });
        const processedArgs = args.map(arg => {
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg); } catch (e) { return '[Object]'; }
            }
            return String(arg);
        }).join(' ');

        const entry = { id: Date.now() + Math.random(), timestamp, type, message: processedArgs };
        
        // Add to start of array (newest first)
        window.__LOG_HISTORY__.unshift(entry);
        if (window.__LOG_HISTORY__.length > MAX_LOGS) window.__LOG_HISTORY__.pop();
    } catch (e) { /* Ignore logger errors */ }
}

// Override console
['log', 'error', 'warn', 'info'].forEach(method => {
    console[method] = (...args) => {
        captureLog(method, args);
        originalConsole[method].apply(console, args);
    };
});

// Log the injected timestamp
if (typeof __BUILD_TIMESTAMP__ !== 'undefined') {
    console.log(`%c[Build Info] Last Commit (NZST): ${__BUILD_TIMESTAMP__}`, "color: cyan; background: #333; padding: 4px;");
}