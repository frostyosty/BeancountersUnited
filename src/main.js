// src/main.js - LEVEL 0: The Baseline Test

console.log("--- main.js: SCRIPT STARTED ---");

import './assets/css/style.css';
console.log("--- main.js: CSS imported.");
import { useAppStore } from './store/appStore.js';
console.log("--- main.js: appStore imported.");
import * as uiUtils from './utils/uiUtils.js';
console.log("--- main.js: uiUtils imported.");
// We are not importing any other modules yet.
import { renderMenuPage } from './features/menu/menuUI.js';
console.log("--- main.js: renderMenuPage imported.");

import { renderOrderHistoryPage } from './features/user/orderHistoryUI.js'; // <-- Import
console.log("--- main.js: renderOrderHistoryPage imported.");
import { renderCartPage } from './features/cart/cartUI.js';
console.log("--- main.js: renderCartPage imported.");
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
console.log("--- main.js: renderAuthStatus imported.");
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';
console.log("--- main.js: initializeImpersonationToolbar imported.");
import { renderManagerDashboard } from './features/admin/managerDashboardUI.js'; // <-- Import
console.log("--- main.js: renderManagerDashboard imported.");
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
console.log("--- main.js: renderOwnerDashboard imported.");


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