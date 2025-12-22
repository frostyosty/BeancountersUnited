import { useAppStore } from '@/store/appStore.js';
import * as components from './dashboardComponents.js';
import * as uiUtils from '@/utils/uiUtils.js';
// FIX: Imported adminState
import { attachOwnerDashboardListeners, initializeSortable, currentSort, adminState } from './listeners/handlers/index.js';

// --- Helpers ---
function getCategoryColor(categoryName) {
    let hash = 0;
    for (let i = 0; i < categoryName.length; i++) hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${180 + (Math.abs(hash) % 50)}, 85%, 96%)`;
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
    if (!categories || categories.length === 0) return `<div id="category-manager"><div class="add-category-row"><input type="text" id="new-category-name" placeholder="New Category"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list"></ul></div>`;
    return `<div id="category-manager"><div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;"><input type="text" id="new-category-name" placeholder="New Category Name"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list">${categories.map(cat => `<li class="category-list-item" data-category-name="${cat}"><div class="drag-handle-wrapper"><span class="drag-handle">☰</span></div><span class="category-name">${cat}</span><button class="button-danger small delete-category-btn">Delete</button></li>`).join('')}</ul></div>`;
}

export function renderGodDashboard() {
    console.log("--- [GodDashboard] Render START ---");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 1. Fetch Data
    const adminStateData = useAppStore.getState().admin; // Rename to avoid conflict with adminState import
    if (!adminStateData.users || adminStateData.users.length === 0) useAppStore.getState().admin.fetchAllUsers();
    if (!adminStateData.clients || adminStateData.clients.length === 0) useAppStore.getState().admin.fetchClients();



    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    useAppStore.getState().orderHistory.fetchOrderHistory();
    useAppStore.getState().admin.fetchSiteLogs(); // Ensure this exists in adminSlice

    // 2. Retrieve State
    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    const { orders } = useAppStore.getState().orderHistory;
    const { users, clients } = useAppStore.getState().admin;
    const role = useAppStore.getState().auth.getUserRole();
    const { siteLogs } = useAppStore.getState().admin;

    if (isLoadingMenu || isLoadingSettings) {
        mainContent.innerHTML = uiUtils.getLoaderHTML("Loading God Dashboard...");
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`;
        return;
    }

    try {
        // --- 3. Sync Layout Config from DB ---
        const dbConfig = settings.dashboardConfig;
        if (dbConfig) {
            adminState.tabsEnabled = dbConfig.enabled;
            adminState.tabPosition = dbConfig.position;
            if (dbConfig.layout && dbConfig.layout.length > 0) {
                adminState.layout = dbConfig.layout;
            }
        }

        // --- 4. Generate Section HTML ---

        // User Management
        let userManagementHTML = '';
        if (users) {
            const userRows = users.map(user => `
                <tr data-user-id="${user.id}">
                    <td>${user.email}</td>
                    <td>${user.full_name || 'N/A'}</td>
                    <td><span class="role-badge role-${user.role}">${user.role}</span></td>
                    <td>${user.is_verified_buyer ? 'Yes' : 'No'}</td>
                    <td>${user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A'}</td>
                    <td><button class="button-secondary small edit-user-btn">Edit</button></td>
                </tr>`).join('');
            userManagementHTML = `
                <section class="dashboard-section" style="border-color: #7b2cbf;">
                    <h3 style="color:#7b2cbf;">User Management</h3>
                    <div class="table-wrapper">
                        <table style="width:100%; border-collapse:collapse;">
                            <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Verified</th><th>Joined</th><th>Actions</th></tr></thead>
                            <tbody>${userRows}</tbody>
                        </table>
                    </div>
                </section>`;
        }

        // Menu Section
        const menuSectionHTML = components.renderMenuSection(
            menuItems, currentSort, getCategoryColor, getAllergenBadges, getSortIcon, settings.showAllergens
        );

        // --- 5. Map Sections ---
        // This maps the IDs from adminState.layout to the HTML strings
        const sections = {
            'active_orders': components.renderActiveOrdersSection(orders, role, settings),
            'clients': components.renderClientRelationshipsSection(clients || []),
            'menu': menuSectionHTML,
            'categories': `<section class="dashboard-section"><h3>Menu Categories</h3>${getMenuLayoutHTML()}</section>`,
            'header': components.renderHeaderSection(settings.headerSettings || {}),
            'appearance': components.renderAppearanceSection(settings),
            'global': components.renderGlobalSettingsSection(settings),
            'operations': components.renderOperationsSection(settings), // New
            'history': components.renderHistorySection(siteLogs || [])
        };

        // Note: User Management is exclusive to God, usually not part of the reorderable layout, 
        // but we can prepend it or add it to the map if you want it sortable.
        // For now, we render it at the top.

        // --- 6. Build View (Tabs vs List) ---
        let viewHTML = '';

        if (adminState.tabsEnabled) {
            const tabBar = components.renderTabBar(adminState.layout, adminState.activeTab, adminState.tabPosition);
            const activeContent = sections[adminState.activeTab] || '<p style="padding:20px;">Section not found or hidden.</p>';

            viewHTML = (adminState.tabPosition === 'top')
                ? tabBar + activeContent
                : activeContent + tabBar;
        } else {
            // List Mode: Render in order
            viewHTML = adminState.layout.map(item => {
                if (item.hidden) return '';
                return sections[item.id] || '';
            }).join('');
        }

        // --- 7. Static Footer Sections ---
        const layoutConfigHTML = components.renderLayoutConfig(adminState.layout, adminState.tabPosition, adminState.tabsEnabled);
        const paymentHTML = components.renderPaymentSection(settings.paymentConfig || {});
        const aboutHTML = components.renderAboutConfigSection(settings);

        // --- 8. Final Assembly ---
        mainContent.innerHTML = `
            <div class="dashboard-container">
                <h2>God Mode Dashboard</h2>
                ${userManagementHTML} <!-- Fixed at top -->
                
                ${viewHTML} <!-- Dynamic Area -->

                <!-- Static Footer -->
                ${layoutConfigHTML}
                ${aboutHTML}
                ${paymentHTML}
            </div>
        `;

        attachOwnerDashboardListeners();
        initializeSortable();
        uiUtils.startLiveTimers();

        console.log("--- [GodDashboard] Render COMPLETE ---");

    } catch (e) {
        console.error("CRITICAL DASHBOARD CRASH:", e);
        mainContent.innerHTML = `<div class="error-message"><h3>Dashboard Crash</h3><p>${e.message}</p></div>`;
    }
}