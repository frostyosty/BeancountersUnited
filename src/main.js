// src/main.js
import './utils/debugLogger.js';
import './assets/css/style.css';
import './assets/css/static.css';

import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from './utils/uiUtils.js';

// Core Imports
import { renderShell, renderPersistentUI, setupHamburgerMenu } from './core/layout.js';
import { renderPageContent } from './core/router.js';
import { setupGlobalListeners, setupGodModeTrigger } from './core/events.js';
import { initializeImpersonationToolbar } from './features/admin/godTaskbarUI.js';
import { renderStaticSite } from './features/static/staticUI.js';

let isAppInitialized = false;

async function main() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    console.log("[App] Main initialization started.");

    // --- 0. STATIC MODE CHECK ---
    const urlParams = new URLSearchParams(window.location.search);
    const forceAdmin = urlParams.get('mode') === 'admin';
    let isStaticMode = false;
    try {
        const cachedSettings = localStorage.getItem('cached_site_settings'); 
        if (cachedSettings) {
            const parsed = JSON.parse(cachedSettings);
            isStaticMode = parsed.staticMode === true;
        }
    } catch(e) {}

    if (isStaticMode && !forceAdmin) {
        renderStaticSite();
        return; 
    }

    // 1. Render Shell
    uiUtils.initGlobalSpinner();
    renderShell();

    // 2. Setup Logic
    setupHamburgerMenu();
    setupGlobalListeners();
    setupGodModeTrigger();
    initializeImpersonationToolbar();

    // 3. Router Subscription
    window.addEventListener('hashchange', renderPageContent);

    // 4. Store Subscriptions
    const getPersistentUIState = () => {
        const state = useAppStore.getState();
        return {
            isAuthLoading: state.auth.isAuthLoading,
            isAuthenticated: state.auth.isAuthenticated,
            profile: state.auth.profile, 
            cartItemCount: state.cart.items.length,
            aboutEnabled: state.siteSettings.settings?.aboutUs?.enabled
        };
    };
    
    let previousUIState = getPersistentUIState();
    useAppStore.subscribe(() => {
        const currentUIState = getPersistentUIState();
        if (JSON.stringify(currentUIState) !== JSON.stringify(previousUIState)) {
            renderPersistentUI();
            previousUIState = currentUIState;
        }
    });

    // Page Refresh Subscription
    useAppStore.subscribe(
        // FIX: Added state.auth.isAuthenticated to the key string
        // This ensures the router runs immediately when you log in OR out
        (state) => `${state.ui._reRenderTrigger}-${state.ui.activeMenuCategory}-${state.auth.isAuthLoading}-${state.auth.isAuthenticated}`,
        
        (keyString) => {
            console.log(`%c[App Sub] Page re-render triggered. Key: ${keyString}`, "color: green;");
            renderPageContent();
        }
    );
    
    // Urgency Check Interval
    setInterval(() => {
        const state = useAppStore.getState();
        if (state.auth.isAuthenticated && state.orderHistory.hasLoaded) {
            state.orderHistory.checkUrgency();
        }
    }, 60 * 1000);

    // Default Route
    if (!window.location.hash) {
        window.location.hash = '#menu';
    }

    // 5. Initial Data Fetch
    await Promise.all([
        useAppStore.getState().auth.listenToAuthChanges(),
        useAppStore.getState().menu.fetchMenu().then(() => {
            const items = useAppStore.getState().menu.items;
            localStorage.setItem('backup_menu_items', JSON.stringify(items));
        }),
        useAppStore.getState().siteSettings.fetchSiteSettings().then(() => {
            const current = useAppStore.getState().siteSettings.settings;
            localStorage.setItem('cached_site_settings', JSON.stringify(current));
        })
    ]);

    if (useAppStore.getState().auth.isAuthenticated) {
        useAppStore.getState().orderHistory.fetchOrderHistory(true); 
    }
    
    // 6. Apply Hydrated Settings
    const settings = useAppStore.getState().siteSettings.settings;
    if (settings) {
        if (settings.themeVariables) {
            Object.entries(settings.themeVariables).forEach(([key, value]) => {
                document.documentElement.style.setProperty(key, value);
            });
            if (settings.themeVariables['--font-family-main-name']) {
                uiUtils.applySiteFont(settings.themeVariables['--font-family-main-name']);
            }
        }
        if (settings.headerSettings) uiUtils.applyHeaderLayout(settings.headerSettings);
        if (settings.websiteName || settings.logoUrl) uiUtils.updateSiteTitles(settings.websiteName, settings.logoUrl);
        if (settings.headerLogoConfig) uiUtils.applyHeaderLogo(settings.headerLogoConfig);
        uiUtils.applyGlobalBackground(settings);
    }

    console.log("[App] Initial data loaded. Performing first full render...");
    renderPersistentUI();
    renderPageContent();

    setTimeout(() => {
        console.log("[App] Hiding initial loader.");
        uiUtils.hideInitialLoader();
    }, 100);
}

main();