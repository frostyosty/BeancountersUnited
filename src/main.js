// src/main.js (FINAL & CORRECTED)
import './utils/debugLogger.js';
import './assets/css/style.css';
import './assets/css/static.css';

import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { applyHeaderLogo } from '@/utils/ui/header.js'; // Ensure correct import path based on your splits

// Core Imports
import { renderAppShell, renderPersistentUI, setupHamburgerMenu } from './core/layout.js';
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
    renderAppShell();

    // 2. Setup Logic
    setupHamburgerMenu();
    setupGlobalListeners();
    setupGodModeTrigger();
    initializeImpersonationToolbar();

    // 3. Router Subscription
    window.addEventListener('hashchange', renderPageContent);

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

    setInterval(() => {
        const state = useAppStore.getState();
        if (state.auth.isAuthenticated && state.orderHistory.hasLoaded) {
            state.orderHistory.checkUrgency();
        }
    }, 60 * 1000);

    useAppStore.subscribe(
        (state) => `${state.ui._reRenderTrigger}-${state.ui.activeMenuCategory}-${state.auth.isAuthLoading}-${state.auth.isAuthenticated}`,
        (keyString) => {
            // console.log(`%c[App Sub] Page re-render triggered. Key: ${keyString}`, "color: green;");
            renderPageContent();
        }
    );

    if (!window.location.hash) {
        window.location.hash = '#menu';
    }

    // 5. Initial Data Fetch (Protected)
    try {
        console.log("[App] Attempting to fetch initial data...");
        
        await Promise.all([
            useAppStore.getState().auth.listenToAuthChanges(),
            
            useAppStore.getState().menu.fetchMenu().then(() => {
                const items = useAppStore.getState().menu.items;
                localStorage.setItem('backup_menu_items', JSON.stringify(items));
            }),
            
            useAppStore.getState().siteSettings.fetchSiteSettings().then(() => {
                const current = useAppStore.getState().siteSettings.settings;
                localStorage.setItem('cached_site_settings', JSON.stringify(current));
                
                // Hydration
                if (current) {
                    if (current.themeVariables) {
                        Object.entries(current.themeVariables).forEach(([key, value]) => {
                            document.documentElement.style.setProperty(key, value);
                        });
                        if (current.themeVariables['--font-family-main-name']) {
                            uiUtils.applySiteFont(current.themeVariables['--font-family-main-name']);
                        }
                    }
                    if (current.headerSettings) uiUtils.applyHeaderLayout(current.headerSettings);
                    if (current.websiteName || current.logoUrl) uiUtils.updateSiteTitles(current.websiteName, current.logoUrl);
                    if (current.headerLogoConfig) applyHeaderLogo(current.headerLogoConfig);
                    uiUtils.applyGlobalBackground(current);
                }
            })
        ]);

        if (useAppStore.getState().auth.isAuthenticated) {
            useAppStore.getState().orderHistory.fetchOrderHistory(true).catch(e => console.warn("Order history fetch failed", e));
        }

        console.log("[App] Initial data loaded. Performing first full render...");
        renderPersistentUI();
        renderPageContent();

        setTimeout(() => {
            console.log("[App] Hiding initial loader.");
            uiUtils.hideInitialLoader();
        }, 100);

    } catch (criticalError) {
        console.error("🔥 CRITICAL STARTUP FAILURE:", criticalError);
        
        // --- FALLBACK TRIGGER ---
        uiUtils.hideInitialLoader();
        renderStaticSite(); 
        
        // Show a discrete toast
        const timeLeft = parseInt(localStorage.getItem('simulated_outage_end')) - Date.now();
        if (timeLeft > 0) {
            uiUtils.showToast(`Simulated Outage Active (${Math.ceil(timeLeft/1000)}s remaining)`, 'error');
        } else {
            uiUtils.showToast("Cannot connect to server. Loaded offline mode.", 'error');
        }
    }
}

main();