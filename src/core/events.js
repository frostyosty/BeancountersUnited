// src/core/events.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

export function setupGlobalListeners() {
    document.body.addEventListener('click', async (e) => {
        // Login
        if (e.target.matches('#login-signup-btn')) {
            import('@/features/auth/authUI.js').then(m => m.showLoginSignupModal());
            return;
        }

        // Logout
        if (e.target.matches('#logout-btn')) {
            const { logout } = useAppStore.getState().auth;
            
            uiUtils.showToast("Logged out successfully.", "success");
            await logout();
            
            if (window.location.hash !== '#menu') {
                window.location.hash = '#menu';
            }
            return;
        }

        // Nav Links (Updating Active State)
        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            const categoryFilter = navLink.dataset.categoryFilter;
            if (categoryFilter) {
                useAppStore.getState().ui.setActiveMenuCategory(categoryFilter);
            }
            const newHash = navLink.getAttribute('href');
            if (window.location.hash !== newHash) {
                window.location.hash = newHash;
            }
        }
    });
}

export function setupGodModeTrigger() {
    const triggerElement = document.getElementById('main-header');
    if (!triggerElement) return;

    let clickCount = 0;
    let clickTimer = null;
    let longPressTimer = null;
    const longPressDuration = 3000;

    const toggleGodMode = async () => {
        clearTimeout(clickTimer);
        clearTimeout(longPressTimer);
        clickCount = 0;

        const { login, logout, user } = useAppStore.getState().auth;
        const godUserEmail = 'manager@beancountersunited.dev'; 

        if (user?.email === godUserEmail) {
            await logout();
            uiUtils.showToast("God Mode Deactivated", "info");
        } else {
            if (user) {
                await logout();
                await new Promise(res => setTimeout(res, 500));
            }
            const { error } = await login(godUserEmail, 'password123');
            if (error) uiUtils.showToast(`Login Failed: ${error.message}`, "error");
            else uiUtils.showToast("God Mode Activated!", "success");
        }
    };

    triggerElement.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        clickCount++;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickCount = 0; }, 1000);
        if (clickCount === 3) toggleGodMode();
    });

    triggerElement.addEventListener('touchstart', (e) => {
        if (!e.target.closest('button') && !e.target.closest('a')) {
            longPressTimer = setTimeout(toggleGodMode, longPressDuration);
        }
    });
    triggerElement.addEventListener('touchend', () => clearTimeout(longPressTimer));
    triggerElement.addEventListener('touchcancel', () => clearTimeout(longPressTimer));
}