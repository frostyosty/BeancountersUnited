// src/main.js - LEVEL 0: The Baseline Test

console.log("--- main.js: SCRIPT STARTED ---");

import './assets/css/style.css';
console.log("--- main.js: CSS imported.");
import { useAppStore } from './store/appStore.js';
console.log("--- main.js: appStore imported.");
import * as uiUtils from './utils/uiUtils.js';
console.log("--- main.js: uiUtils imported.");
// We are not importing any other modules yet.

function main() {
    console.log("--- main.js: main() CALLED ---");

    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header"><h1>Mealmates</h1></header>
            <main id="main-content">
                <p>If you see this, main.js is running correctly.</p>
            </main>
            <footer id="main-footer"><p>&copy; 2024</p></footer>
        `;
    }

    console.log("--- main.js: main() finished ---");
}

main();