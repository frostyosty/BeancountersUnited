// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as api from './services/apiService.js'; // Needed for the listener
import { supabase } from './supabaseClient.js'; // Import supabase client
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';

// Make supabase globally accessible for simplicity in other modules if needed
window.supabase = supabase;

function renderApp() {
    renderAuthStatus();
    renderMenuPage();
}

console.log("--- main.js script started ---");

const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <main id="main-content"></main>
    `;
}

// --- SETUP THE AUTH LISTENER HERE ---
// This is the core of the fix. The listener lives in main.js.
if (supabase) {
    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log(`Auth Event in main.js: ${event}`);
        let profile = null;
        if (session?.user) {
            try {
                profile = await api.getUserProfile();
            } catch (e) {
                console.error("Failed to fetch profile in main.js listener", e);
            }
        }
        // Call the simple setter action in our store
        useAppStore.getState()._setAuthState(session, profile);
    });
}
// --- END LISTENER SETUP ---

// Subscribe to ALL state changes.
useAppStore.subscribe(renderApp);

// Kick off the initial menu fetch.
useAppStore.getState().fetchMenu();

// Perform the initial render.
renderApp();

console.log("--- main.js script setup finished ---");