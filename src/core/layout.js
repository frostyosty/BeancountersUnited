// src/core/layout.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

const SPINNER_SVG = `
<div class="auth-loading-spinner">
    <svg viewBox="0 0 100 100">
        <path d="M22 40 H 78 L 72 80 Q 50 90 28 80 Z" fill="transparent" stroke="currentColor" stroke-width="6" />
        <path d="M78 50 C 92 50, 92 70, 78 70" fill="transparent" stroke="currentColor" stroke-width="6" />
        <path class="mini-steam" d="M40 35 L 42 25" fill="none" stroke="currentColor" stroke-width="4" />
        <path class="mini-steam" d="M50 35 L 48 25" fill="none" stroke="currentColor" stroke-width="4" />
        <path class="mini-steam" d="M60 35 L 62 25" fill="none" stroke="currentColor" stroke-width="4" />
    </svg>
</div>`;

export function renderShell() {
    const appElement = document.getElementById('app');
    if (!appElement) return;

    // --- Pre-Calculate Header Styles (Anti-Jolt) ---
    let logoHTML = 'Mealmates';
    let logoStyle = '';
    let headerStyle = '';
    
    // 1. Height
    try {
        const cachedSettings = localStorage.getItem('cached_site_settings');
        if (cachedSettings) {
            const parsed = JSON.parse(cachedSettings);
            const h = parsed.headerSettings?.height;
            if (h) headerStyle += `--header-height: ${h}px; height: ${h}px; `;
        }
    } catch (e) {}

    // 2. Logo & Color
    const cachedHeader = localStorage.getItem('cached_header_config');
    if (cachedHeader) {
        try {
            const config = JSON.parse(cachedHeader);
            logoHTML = uiUtils.generateHeaderSVG(config);
            logoStyle = 'padding:0; line-height:0; display:flex; align-items:center; width:100%; height:100%; justify-content:center; overflow:hidden;';
            if (config.bgColor) headerStyle += `background-color: ${config.bgColor};`;
        } catch (e) { console.error("Cache load failed", e); }
    }

    appElement.innerHTML = `
        <header id="main-header" style="${headerStyle}">
            <h1 style="${logoStyle}">${logoHTML}</h1>
            <nav>
                <div id="desktop-nav-links" class="desktop-nav-group"></div>
                <div id="auth-status-container">${SPINNER_SVG}</div>
                <button id="hamburger-btn" class="hamburger-button"><span></span><span></span><span></span></button>
            </nav>
        </header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
        <div id="mobile-menu-panel" class="mobile-menu-panel"><nav id="mobile-nav-links"></nav></div>
    `;
}

export function renderDesktopNav() {
    const container = document.getElementById('desktop-nav-links');
    if (!container) return;

    const { isAuthenticated, profile } = useAppStore.getState().auth;
    const { settings } = useAppStore.getState().siteSettings;
    const cartCount = useAppStore.getState().cart.getTotalItemCount();
    const aboutEnabled = settings?.aboutUs?.enabled || false;
    const currentHash = window.location.hash || '#menu';

    const makeLink = (hash, label) => {
        const activeClass = currentHash === hash ? 'active' : '';
        return `<a href="${hash}" class="nav-link ${activeClass}">${label}</a>`;
    };

    let html = makeLink('#menu', 'Menu');

    if (aboutEnabled) html += makeLink('#about-us', 'About Us');

    if (isAuthenticated && profile) {
        if (profile.can_see_order_history) {
            const label = (profile.role === 'god' || profile.role === 'owner') ? 'Orders' : 'Order History';
            html += makeLink('#order-history', label);
        }
        if (profile.role === 'owner' || profile.role === 'god') html += makeLink('#owner-dashboard', 'Dashboard');
        if (profile.role === 'god') html += makeLink('#god-dashboard', 'God Mode');
    }

    html += `<a href="#cart" class="nav-link ${currentHash === '#cart' ? 'active' : ''}">Cart (<span id="cart-count">${cartCount}</span>)</a>`;
    container.innerHTML = html;
}

export function renderPersistentUI() {
    // Import dynamically to avoid circle, or rely on authUI being loaded. 
    // Since AuthStatus is self-contained DOM manipulation, we can just call it if available, 
    // or import it here.
    import('@/features/auth/authUI.js').then(m => m.renderAuthStatus());
    
    renderDesktopNav();
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
    
    // Refresh mobile menu
    if (window.buildMobileMenu) window.buildMobileMenu();
}

export function setupHamburgerMenu() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const mobileMenuPanel = document.getElementById('mobile-menu-panel');
    const mainContent = document.getElementById('main-content');
    const mobileNavContainer = document.getElementById('mobile-nav-links');

    if (!hamburgerBtn || !mobileMenuPanel || !mainContent || !mobileNavContainer) return;

    const buildMobileMenu = () => {
        const { isAuthenticated, profile } = useAppStore.getState().auth;
        const { settings } = useAppStore.getState().siteSettings;
        const aboutEnabled = settings?.aboutUs?.enabled || false;
        const siteName = settings?.websiteName || 'Mealmates';

        let navHTML = `<a href="#menu" class="nav-link">Menu</a>`;
        navHTML += `<a href="#cart" class="nav-link">Cart (${useAppStore.getState().cart.getTotalItemCount()})</a>`;

        if (isAuthenticated && profile) {
            const label = (profile.role === 'god' || profile.role === 'owner') ? 'Orders' : 'Order History';
            
            navHTML += `<a href="#my-account" class="nav-link">My ${siteName}</a>`;
            if (profile.can_see_order_history) navHTML += `<a href="#order-history" class="nav-link">${label}</a>`;
            if (profile.role === 'owner' || profile.role === 'god') navHTML += `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
            if (profile.role === 'god') navHTML += `<a href="#god-dashboard" class="nav-link">God Mode</a>`;
        }

        if (aboutEnabled) navHTML += `<a href="#about-us" class="nav-link">About Us</a>`;

        let authSectionHTML = isAuthenticated 
            ? `<div class="mobile-auth-section"><button id="logout-btn" class="button-secondary">Logout</button></div>`
            : `<div class="mobile-auth-section"><button id="login-signup-btn" class="button-primary">Login / Sign Up</button></div>`;

        mobileNavContainer.innerHTML = navHTML + authSectionHTML;
    };

    // Attach to window so renderPersistentUI can call it
    window.buildMobileMenu = buildMobileMenu;

    const toggleMenu = () => {
        hamburgerBtn.classList.toggle('open');
        mobileMenuPanel.classList.toggle('open');
    };

    hamburgerBtn.addEventListener('click', () => toggleMenu());
    mobileMenuPanel.addEventListener('click', (e) => {
        if (e.target.closest('a.nav-link') || e.target.closest('button')) toggleMenu();
    });
    mainContent.addEventListener('click', () => {
        if (mobileMenuPanel.classList.contains('open')) toggleMenu();
    });
}