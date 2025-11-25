// src/features/admin/ownerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import { attachOwnerDashboardListeners, initializeSortable, currentSort } from './adminListeners.js';
import * as components from './dashboardComponents.js';

// Helpers (Only needed for passing data)
function getCategoryColor(categoryName) {
    let hash = 0;
    for (let i = 0; i < categoryName.length; i++) hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${hash % 360}, 70%, 95%)`; 
}
function getAllergenBadges(allergens = []) {
    if (!allergens || allergens.length === 0) return '';
    const map = { 'GF': '#2ecc71', 'V': '#27ae60', 'DF': '#3498db', 'VG': '#9b59b6' };
    return allergens.map(tag => `<span style="font-size:0.7rem; background:${map[tag]||'#999'}; color:white; padding:1px 4px; border-radius:3px; margin-right:2px;">${tag}</span>`).join('');
}
function getSortIcon(col) {
    if (currentSort.column !== col) return '↕';
    return currentSort.direction === 'asc' ? '↑' : '↓';
}

function getMenuLayoutHTML() {
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();
    if (!categories || categories.length === 0) return `<div id="category-manager"><p>No categories.</p><div class="add-category-row"><input type="text" id="new-category-name" placeholder="New Category"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list"></ul></div>`;
    return `<div id="category-manager"><div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;"><input type="text" id="new-category-name" placeholder="New Category Name"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list">${categories.map(cat => `<li class="category-list-item" data-category-name="${cat}"><div class="drag-handle-wrapper"><span class="drag-handle">☰</span></div><span class="category-name">${cat}</span><button class="button-danger small delete-category-btn">x</button></li>`).join('')}</ul></div>`;
}

export function renderOwnerDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    useAppStore.getState().orderHistory.fetchOrderHistory(); 

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    const { orders } = useAppStore.getState().orderHistory;

    if (isLoadingMenu || isLoadingSettings) { mainContent.innerHTML = `<div class="loading-spinner">Loading Dashboard...</div>`; return; }
    if (error) { mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`; return; }

    const ownerPermissions = settings.ownerPermissions || { canEditTheme: true, canEditCategories: true };
    
    // Assemble Sections
    const activeOrdersHTML = components.renderActiveOrdersSection(orders);
    
    const menuSectionHTML = components.renderMenuSection(
        menuItems, currentSort, getCategoryColor, getAllergenBadges, getSortIcon, settings.showAllergens
    );

    const categoriesHTML = ownerPermissions.canEditCategories 
        ? `<section class="dashboard-section"><h3>Menu Categories</h3>${getMenuLayoutHTML()}</section>` 
        : '';

    const appearanceHTML = ownerPermissions.canEditTheme 
        ? components.renderAppearanceSection(settings) 
        : '';

    const headerHTML = components.renderHeaderSection(settings.headerSettings || {});
    
    const paymentHTML = components.renderPaymentSection(settings.paymentConfig || {});

    // Render
    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>Owner Dashboard</h2>
            ${activeOrdersHTML}
            ${menuSectionHTML}
            ${categoriesHTML}
            ${headerHTML}
            ${appearanceHTML}
            ${paymentHTML}
        </div>
    `;

    attachOwnerDashboardListeners();
    if (ownerPermissions.canEditCategories) initializeSortable();
}