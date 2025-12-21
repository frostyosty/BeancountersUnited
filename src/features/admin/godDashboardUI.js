import { useAppStore } from '@/store/appStore.js';
import * as components from './dashboardComponents.js';
import * as uiUtils from '@/utils/uiUtils.js';
// FIX: Imported adminState
import { attachOwnerDashboardListeners, initializeSortable, currentSort, adminState } from './listeners/index.js';

// --- Helpers ---
function getCategoryColor(categoryName) {
    let hash = 0;
    for (let i = 0; i < categoryName.length; i++) hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${180 + (Math.abs(hash) % 50)}, 85%, 96%)`; 
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
    if (!categories || categories.length === 0) return `<div id="category-manager"><div class="add-category-row"><input type="text" id="new-category-name" placeholder="New Category"><button id="add-category-btn" class="button-primary small">Add</button></div><p>No categories defined.</p></div>`;
    return `<div id="category-manager"><div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;"><input type="text" id="new-category-name" placeholder="New Category Name"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list">${categories.map(cat => `<li class="category-list-item" data-category-name="${cat}"><div class="drag-handle-wrapper"><span class="drag-handle">☰</span></div><span class="category-name">${cat}</span><button class="button-danger small delete-category-btn">Delete</button></li>`).join('')}</ul></div>`;
}

export function renderOwnerDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Fetch Data
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    useAppStore.getState().orderHistory.fetchOrderHistory(); 
    
    const adminStateData = useAppStore.getState().admin;
    if (!adminStateData.clients || adminStateData.clients.length === 0) useAppStore.getState().admin.fetchClients();

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    const { orders } = useAppStore.getState().orderHistory;
    const { clients } = useAppStore.getState().admin;
    const role = useAppStore.getState().auth.getUserRole();

    if (isLoadingMenu || isLoadingSettings) {
        mainContent.innerHTML = uiUtils.getLoaderHTML("Loading Dashboard...");
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`;
        return;
    }

    const ownerPermissions = settings.ownerPermissions || { canEditTheme: true, canEditCategories: true };
    
    try {
        // --- Sync Config ---
        const dbConfig = settings.dashboardConfig;
        if (dbConfig) {
            adminState.tabsEnabled = dbConfig.enabled;
            adminState.tabPosition = dbConfig.position;
            if (dbConfig.layout && dbConfig.layout.length > 0) {
                adminState.layout = dbConfig.layout;
            }
        }

        // --- Prepare Sections ---
        // Filter layout based on permissions if needed (e.g. if can't edit theme, don't show Appearance tab)
        // For now, we render string empty if permission denied
        
        const sections = {
            'active_orders': components.renderActiveOrdersSection(orders, role, settings),
            'clients': components.renderClientRelationshipsSection(clients || []),
            'menu': components.renderMenuSection(
                menuItems, currentSort, getCategoryColor, getAllergenBadges, getSortIcon, settings.showAllergens, settings
            ),
            'categories': ownerPermissions.canEditCategories 
                ? `<section class="dashboard-section"><h3>Menu Categories</h3>${getMenuLayoutHTML()}</section>` 
                : '',
            'header': components.renderHeaderSection(settings.headerSettings || {}),
            'appearance': ownerPermissions.canEditTheme 
                ? components.renderAppearanceSection(settings) 
                : '',
            'global': components.renderGlobalSettingsSection(settings) // Available to owner? Usually yes for Logo/Name
        };

        // --- Build View ---
        let viewHTML = '';
        
        if (adminState.tabsEnabled) {
            const tabBar = components.renderTabBar(adminState.layout, adminState.activeTab, adminState.tabPosition);
            const activeContent = sections[adminState.activeTab] || '<p style="padding:20px; color:#666;">Section hidden or restricted.</p>';
            
            viewHTML = (adminState.tabPosition === 'top') ? tabBar + activeContent : activeContent + tabBar;
        } else {
            viewHTML = adminState.layout.map(item => {
                if (item.hidden) return '';
                return sections[item.id] || '';
            }).join('');
        }

        // --- Static Footer ---
        const layoutConfigHTML = components.renderLayoutConfig(adminState.layout, adminState.tabPosition, adminState.tabsEnabled);
        const paymentHTML = components.renderPaymentSection(settings.paymentConfig || {});
        const aboutHTML = components.renderAboutConfigSection(settings);

        mainContent.innerHTML = `
            <div class="dashboard-container">
                <h2>Owner Dashboard</h2>
                
                ${viewHTML}

                ${aboutHTML}
                ${layoutConfigHTML}
                ${paymentHTML}
            </div>
        `;

        attachOwnerDashboardListeners();
        if (ownerPermissions.canEditCategories) initializeSortable();
        uiUtils.startLiveTimers();

    } catch (e) {
        console.error("Owner Dashboard Crash:", e);
        mainContent.innerHTML = `<div class="error-message"><h3>Dashboard Error</h3><p>${e.message}</p></div>`;
    }
}