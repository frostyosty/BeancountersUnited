// src/features/admin/godDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as components from './dashboardComponents.js';
import { attachOwnerDashboardListeners, initializeSortable, currentSort } from './adminListeners.js';

// --- Helpers (Color/Badge/Sort logic is inside components or listeners now, or kept here if needed for sorting state) ---
// We keep sort/color helpers here if they are used for local logic, 
// but the HTML generation is now in components.js.

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
    return allergens.map(tag => `<span style="font-size:0.7rem; background:${map[tag]||'#999'}; color:white; padding:1px 4px; border-radius:3px; margin-right:2px;">${tag}</span>`).join('');
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
            
            <!-- FIX: Styled X Button with Margin -->
            <button class="delete-icon-btn delete-category-btn" style="margin-left:15px;" title="Delete Category">
                ×
            </button>
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

// src/features/admin/godDashboardUI.js


export function renderGodDashboard() {
    console.log("--- [GodDashboard] Render START ---");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Fetch Data (Safely)
    const { users } = useAppStore.getState().admin;
    if (!users || users.length === 0) {
        console.log("[GodDashboard] Fetching Users...");
        useAppStore.getState().admin.fetchAllUsers(); 
    }

    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    useAppStore.getState().orderHistory.fetchOrderHistory();

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    const { orders } = useAppStore.getState().orderHistory;

    if (isLoadingMenu || isLoadingSettings) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading God Dashboard...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`;
        return;
    }

    try {
        // --- 1. User Management ---
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

        // --- 2. Render Components (With Logging) ---
        console.log("1. Rendering Global Settings...");
        if (typeof components.renderGlobalSettingsSection !== 'function') throw new Error("renderGlobalSettingsSection is missing!");
        const globalSettingsHTML = components.renderGlobalSettingsSection(settings);

        console.log("2. Rendering Active Orders...");
        if (typeof components.renderClientRelationshipsSection !== 'function') {
            throw new Error("renderClientRelationshipsSection not found in dashboardComponents.js");
        }
        const activeOrdersHTML = components.renderClientRelationshipsSection(orders);

        console.log("3. Rendering Menu...");
        if (typeof components.renderMenuSection !== 'function') throw new Error("renderMenuSection is missing!");
        const menuSectionHTML = components.renderMenuSection(
            menuItems, 
            currentSort, 
            getCategoryColor, 
            getAllergenBadges, 
            getSortIcon, 
            settings.showAllergens
        );

        console.log("4. Rendering Appearance...");
        if (typeof components.renderAppearanceSection !== 'function') throw new Error("renderAppearanceSection is missing!");
        const appearanceHTML = components.renderAppearanceSection(settings);

        console.log("5. Rendering Header...");
        if (typeof components.renderHeaderSection !== 'function') throw new Error("renderHeaderSection is missing!");
        const headerHTML = components.renderHeaderSection(settings.headerSettings || {});

        console.log("6. Rendering Payment...");
        if (typeof components.renderPaymentSection !== 'function') throw new Error("renderPaymentSection is missing!");
        const paymentHTML = components.renderPaymentSection(settings.paymentConfig || {});

        // --- 3. Final Assembly ---
        console.log("7. Assembling HTML...");
        mainContent.innerHTML = `
            <div class="dashboard-container">
                <h2>God Mode Dashboard</h2>
                ${userManagementHTML}
                ${globalSettingsHTML}
                ${activeOrdersHTML}
                ${menuSectionHTML}
                
                <section class="dashboard-section">
                    <h3>Menu Categories</h3>
                    ${getMenuLayoutHTML()}
                </section>

                ${headerHTML}
                ${appearanceHTML}
                ${paymentHTML}
            </div>
        `;

        console.log("8. Attaching Listeners...");
        if (typeof attachOwnerDashboardListeners !== 'function') throw new Error("attachOwnerDashboardListeners is missing!");
        attachOwnerDashboardListeners();
        
        console.log("9. Initializing Sortable...");
        if (typeof initializeSortable !== 'function') throw new Error("initializeSortable is missing!");
        initializeSortable();

        console.log("--- [GodDashboard] Render COMPLETE ---");

    } catch (e) {
        console.error("CRITICAL DASHBOARD CRASH:", e);
        mainContent.innerHTML = `<div class="error-message">
            <h3>Dashboard Crash</h3>
            <p>${e.message}</p>
            <p>Check console for details.</p>
        </div>`;
    }
}