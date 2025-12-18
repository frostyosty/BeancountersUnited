// src/core/router.js
import { useAppStore } from '@/store/appStore.js';
import { renderDesktopNav } from './layout.js';

// Feature Imports
import { renderMenuPage } from '@/features/menu/menuUI.js';
import { renderCartPage } from '@/features/cart/index.js';
import { renderOwnerDashboard } from '@/features/admin/ownerDashboardUI.js';
import { renderGodDashboard } from '@/features/admin/godDashboardUI.js';
import { renderOrderHistoryPage } from '@/features/user/orderHistoryUI.js';
import { renderAboutUsPage } from '@/features/about/aboutUsUI.js';

export function renderPageContent() {
    console.log("%c[Router] renderPageContent() CALLED", "font-weight: bold;");
    const hash = window.location.hash || '#menu';
    
    const { getUserRole, isAuthLoading, isAuthenticated } = useAppStore.getState().auth; 
    
    if (isAuthLoading) {
        console.log("[Router] Auth loading... waiting.");
        return; 
    }
    
    const userRole = getUserRole();

    // Sync Desktop Nav Active State
    renderDesktopNav();

    switch (hash) {
        case '#menu': 
            renderMenuPage(); 
            break;
        case '#about-us': 
            renderAboutUsPage(); 
            break;
        case '#cart': 
        case '#checkout': 
            renderCartPage(); 
            break;
        case '#order-confirmation':
            const mainContent = document.getElementById('main-content');
            const { lastSuccessfulOrderId } = useAppStore.getState().checkout;
            if (mainContent) mainContent.innerHTML = lastSuccessfulOrderId ? `...` : `...`; 
            break;
        case '#order-history':
            if (isAuthenticated) {
                renderOrderHistoryPage();
            } else {
                window.location.hash = '#menu';
            }
            break;
        case '#my-account':
            if (isAuthenticated) {
                import('@/features/user/userProfileUI.js').then(m => m.renderUserProfilePage());
            } else {
                window.location.hash = '#menu';
            }
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'god') {
                renderOwnerDashboard();
            } else {
                window.location.hash = '#menu';
            }
            break;
        case '#god-dashboard':
            if (userRole === 'god') {
                renderGodDashboard();
            } else {
                console.warn(`[Router] Access Denied. Role is ${userRole}`);
                window.location.hash = '#menu';
            }
            break;
        default: 
            renderMenuPage(); 
            break;
    }
}