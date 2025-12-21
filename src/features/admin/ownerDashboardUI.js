// src/features/admin/ownerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js'; // Needed for startLiveTimers
import { attachOwnerDashboardListeners, initializeSortable, currentSort, adminState } from './listeners/index.js';
import * as components from './dashboardComponents.js';

// Helpers (Only needed for passing data)
function getCategoryColor(categoryName) {
    let hash = 0;
    for (let i = 0; i < categoryName.length; i++) {
        hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Math: 180 is Cyan. We allow a variance of 50 degrees (180 to 230).
    // Math.abs ensures the hash is positive.
    const h = 180 + (Math.abs(hash) % 50);

    // Result: 85% Saturation, 96% Lightness (Very pale blue)
    return `hsl(${h}, 85%, 96%)`;
}

function getAllergenBadges(allergens = []) {
    if (!allergens || allergens.length === 0) return '';
    const map = { 'GF': '#2ecc71', 'V': '#27ae60', 'DF': '#3498db', 'VG': '#9b59b6' };
    return allergens.map(tag => `<span style="font-size:0.7rem; background:${map[tag] || '#999'}; color:white; padding:1px 4px; border-radius:3px; margin-right:2px;">${tag}</span>`).join('');
}
function getSortIcon(col) {
    if (currentSort.column !== col) return '↕';
    return currentSort.direction === 'asc' ? '↑' : '↓';
}

function getMenuLayoutHTML() {
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();

    if (!categories || categories.length === 0) {
        return `<div id="category-manager"><div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;"><input type="text" id="new-category-name" placeholder="New Category"><button id="add-category-btn" class="button-primary small">Add</button></div><p>No categories defined.</p></div>`;
    }

    const listItems = categories.map(cat => `
        <li class="category-list-item" data-category-name="${cat}" style="display:flex; align-items:center; padding:8px; border-bottom:1px solid #eee; background:white;">
            <div class="drag-handle-wrapper" style="margin-right:10px; cursor:grab; color:#999;">
                <span class="drag-handle">☰</span>
            </div>
            <span class="category-name" style="flex-grow:1;">${cat}</span>
            <button class="delete-icon-btn delete-category-btn" style="margin-left:15px;" title="Delete Category">×</button>
        </li>
    `).join('');

    return `
        <div id="category-manager">
            <div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;">
                <input type="text" id="new-category-name" placeholder="New Category Name" style="flex:1; padding:5px;">
                <button id="add-category-btn" class="button-primary small">Add</button>
            </div>
            <ul id="category-list" style="list-style:none; padding:0; border:1px solid #ddd; border-radius:4px;">
                ${listItems}
            </ul>
        </div>`;
}

// --- MAIN RENDER FUNCTION ---
export function renderOwnerDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 1. Fetch Data
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    useAppStore.getState().orderHistory.fetchOrderHistory();

    const { clients } = useAppStore.getState().admin;
    if (!clients || clients.length === 0) {
        useAppStore.getState().admin.fetchClients();
    }

    // 2. Retrieve State
    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    const { orders } = useAppStore.getState().orderHistory;

    // 3. Loading / Error Checks
    if (isLoadingMenu || isLoadingSettings) {
        // Use the new graphical loader if available, else simple text
        if (uiUtils.getLoaderHTML) {
            mainContent.innerHTML = uiUtils.getLoaderHTML("Loading Dashboard...");
        } else {
            mainContent.innerHTML = `<div class="loading-spinner">Loading Dashboard...</div>`;
        }
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`;
        return;
    }

    const ownerPermissions = settings.ownerPermissions || { canEditTheme: true, canEditCategories: true };

    // 4. Sync Tab/Layout Configuration
    const dbConfig = settings.dashboardConfig;
    if (dbConfig) {
        adminState.tabsEnabled = dbConfig.enabled;
        adminState.tabPosition = dbConfig.position;
        if (dbConfig.layout && dbConfig.layout.length > 0) {
            adminState.layout = dbConfig.layout;
        }
    }

    // 5. Prepare Sections Map
    // This maps the IDs in adminState.layout to actual HTML generators
    const sections = {
        'active_orders': components.renderActiveOrdersSection(orders), 
        'clients': components.renderClientRelationshipsSection(clients || []),
        
        // Pass 'settings' here for the Color Theme logic we added
        'menu': components.renderMenuSection(
            menuItems, 
            currentSort, 
            getCategoryColor, 
            getAllergenBadges, 
            getSortIcon, 
            settings.showAllergens, 
            settings 
        ),
        
        'categories': ownerPermissions.canEditCategories 
            ? `<section class="dashboard-section"><h3>Menu Categories</h3>${getMenuLayoutHTML()}</section>` 
            : '',
            
        'header': components.renderHeaderSection(settings.headerSettings || {}),
        
        'appearance': ownerPermissions.canEditTheme 
            ? components.renderAppearanceSection(settings) 
            : '',
            
        'global': components.renderGlobalSettingsSection(settings)
    };

    // 6. Build Main Content View (Tabs vs List)
    let viewHTML = '';
    
    if (adminState.tabsEnabled) {
        const tabBar = components.renderTabBar(adminState.layout, adminState.activeTab, adminState.tabPosition);
        const activeContent = sections[adminState.activeTab] || '<p style="padding:20px; color:#666;">Section hidden or not found.</p>';
        
        if (adminState.tabPosition === 'top') {
            viewHTML = tabBar + activeContent;
        } else {
            viewHTML = activeContent + tabBar;
        }
    } else {
        // List View: Sort by layout order
        viewHTML = adminState.layout.map(item => {
            if (item.hidden) return '';
            return sections[item.id] || '';
        }).join('');
    }

    // 7. Prepare Static Bottom Sections
    const layoutConfigHTML = components.renderLayoutConfig(adminState.layout, adminState.tabPosition, adminState.tabsEnabled);
    const paymentHTML = components.renderPaymentSection(settings.paymentConfig || {});
    const aboutHTML = components.renderAboutConfigSection(settings);

    // 8. Final Render
    mainContent.innerHTML = `
        <div class="dashboard-container" style="display:flex; flex-direction:column;">
            <h2 style="margin-bottom:20px;">Owner Dashboard</h2>
            
            <!-- Dynamic Content (Tabs or List) -->
            ${viewHTML}

            <!-- Static Footer Configs -->
            ${aboutHTML}
            ${layoutConfigHTML}
            ${paymentHTML}
        </div>
    `;

    attachOwnerDashboardListeners();
    uiUtils.startLiveTimers();
    if (ownerPermissions.canEditCategories) initializeSortable();
}