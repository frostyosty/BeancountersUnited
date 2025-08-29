// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { supabase, supabaseError } from './supabaseClient.js'; // Import the error state
import { renderMenuPage } from './features/menu/menuUI.js';

function renderApp() {
    renderMenuPage();
    // ... other render calls
}

console.log("--- main.js script started ---");

const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

// --- CRITICAL CHECK ---
if (supabaseError) {
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
        mainContent.innerHTML = `
            <div class="error-message">
                <h2>Application Configuration Error</h2>
                <p>The application could not start due to a configuration issue.</p>
                <p><strong>Details:</strong> ${supabaseError}</p>
                <p>Please contact the site administrator.</p>
            </div>
        `;
    }
} else {
    // Only set up the rest of the app if Supabase initialized correctly.
    useAppStore.subscribe(renderApp);
    window.addEventListener('hashchange', renderApp);

    useAppStore.getState().menu.fetchMenu();
    // useAppStore.getState().auth.listenToAuthChanges(); // We'll add this back next

    renderApp();
}

console.log("--- main.js script setup finished ---");