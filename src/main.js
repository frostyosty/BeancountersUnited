
// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';
// We will add back other renderers and features AFTER this works.

async function main() {
    console.log("--- main.js started (Final Simple Version) ---");

    // 1. Render the static shell
    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header"><h1>Mealmates</h1></header>
            <main id="main-content"></main>
            <footer id="main-footer"><p>&copy; 2024</p></footer>
        `;
    }
    
    // 2. Render the initial loading state
    renderMenuPage(); // This will show "Loading..."

    // 3. AWAIT the initial data fetches to complete.
    console.log("main: Awaiting menu.fetchMenu()...");
    await useAppStore.getState().menu.fetchMenu();
    console.log("main: FINISHED menu.fetchMenu().");
    
    // We will add auth back after this works.

    // 4. Now that all data is loaded, do the final render.
    console.log("main: Performing final render.");
    renderMenuPage();
}

main();