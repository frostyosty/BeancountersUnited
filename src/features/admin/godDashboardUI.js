// src/features/admin/godDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { attachOwnerDashboardListeners, initializeSortable, currentSort } from './adminListeners.js';

// --- Helpers ---
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

// --- MAIN RENDER FUNCTION (God Mode) ---
export function renderGodDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Fetch Everything
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    useAppStore.getState().orderHistory.fetchOrderHistory();
    
    // FIX: Removed 'true'. This stops the infinite recursion loop.
    useAppStore.getState().admin.fetchAllUsers(); 

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    const { orders } = useAppStore.getState().orderHistory;
    const { users } = useAppStore.getState().admin;

    if (isLoadingMenu || isLoadingSettings) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading God Dashboard...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`;
        return;
    }

    // --- 1. User Management (Exclusive) ---
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

    // --- 2. Global Settings ---
    const currentLogo = settings.logoUrl || '';
    const hamburgerConfig = settings.hamburgerMenuContent || 'main-nav';
    const showAllergens = settings.showAllergens || false;
    const ownerPermissions = settings.ownerPermissions || { canEditTheme: true, canEditCategories: true };
    
    const globalSettingsHTML = `
        <section class="dashboard-section" style="border-color: #7b2cbf;">
            <h3 style="color:#7b2cbf;">Global Site Settings</h3>
            <form id="global-settings-form">
                <div class="form-group">
                    <label>Website Name</label>
                    <input type="text" name="websiteName" value="${settings.websiteName || 'Mealmates'}" required>
                </div>
                <div class="form-group">
                    <label>Website Logo</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img id="logo-preview" src="${currentLogo}" style="max-height:40px; display:${currentLogo?'block':'none'}; border:1px solid #ddd;">
                        <label for="logo-upload" class="button-secondary small" style="cursor:pointer;">Upload</label>
                        <input type="file" id="logo-upload" name="logoFile" accept="image/*" style="display:none;">
                        <button type="button" id="clear-logo-btn" class="button-danger small" style="display:${currentLogo?'block':'none'};">Remove</button>
                        <input type="hidden" name="logoUrl" value="${currentLogo}">
                        <p id="no-logo-text" style="display:${currentLogo?'none':'block'}; font-size:0.8rem; margin:0;">No logo</p>
                    </div>
                </div>
                <div class="form-group">
                    <label>Mobile Menu Content</label>
                    <div style="display:flex; gap:15px;">
                        <label><input type="radio" name="hamburgerMenuContent" value="main-nav" ${hamburgerConfig==='main-nav'?'checked':''}> Main Links</label>
                        <label><input type="radio" name="hamburgerMenuContent" value="categories" ${hamburgerConfig==='categories'?'checked':''}> Categories</label>
                    </div>
                </div>
                <div class="form-group">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="showAllergens" ${showAllergens ? 'checked' : ''}> 
                        Enable Dietary Filters (GF, V, etc) on Menu
                    </label>
                </div>
            </form>
            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">
            <h4>Owner Permissions</h4>
            <form id="owner-permissions-form">
                <div style="display:flex; gap:15px;">
                    <label><input type="checkbox" name="canEditTheme" ${ownerPermissions.canEditTheme?'checked':''}> Edit Theme</label>
                    <label><input type="checkbox" name="canEditCategories" ${ownerPermissions.canEditCategories?'checked':''}> Edit Categories</label>
                </div>
            </form>
        </section>
    `;

    // --- 3. Active Orders ---
    const activeOrders = orders.filter(o => o.status === 'pending' || o.status === 'preparing');
    const activeOrdersHTML = activeOrders.length === 0 ? '<p>No active orders.</p>' : activeOrders.map(order => {
        const profile = order.profiles || {}; 
        const displayName = profile.internal_nickname || profile.full_name || profile.email || 'Guest';
        let noteIcon = '';
        if (profile.staff_note) {
            noteIcon = profile.staff_note_urgency === 'alert' ? `<span title="Important">🔴</span>` : `<span title="Info">🔵</span>`;
        }
        return `
        <div class="order-card" style="background:white; border:1px solid #eee; padding:10px; margin-bottom:10px; border-radius:4px;">
            <div class="order-header" style="cursor:pointer; display:flex; justify-content:space-between; font-weight:bold;" 
                 onclick="window.handleOrderRowClick('${order.user_id}')">
                <span>#${order.id.slice(0, 4)} - ${displayName} ${noteIcon}</span>
                <span>$${order.total_amount.toFixed(2)}</span>
            </div>
            <div style="font-size:0.9rem; color:#666; margin-top:5px;">
                ${order.order_items.map(i => `${i.quantity}x ${i.menu_items?.name}`).join(', ')}
            </div>
        </div>`;
    }).join('');

    // --- 4. Menu Table ---
    const sortedItems = [...menuItems].sort((a, b) => {
        const col = currentSort.column;
        const valA = col === 'price' ? parseFloat(a[col]) : (a[col] || '').toLowerCase();
        const valB = col === 'price' ? parseFloat(b[col]) : (b[col] || '').toLowerCase();
        if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
        if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
        return 0;
    });

    const menuItemsTableRows = sortedItems.map(item => `
        <tr data-item-id="${item.id}" style="background-color: ${getCategoryColor(item.category||'')}; border-bottom:1px solid #fff;">
            <td style="padding:10px;">
                <div style="font-weight:500;">${item.name}</div>
                <div style="margin-top:2px;">${getAllergenBadges(item.allergens)}</div>
            </td>
            <td style="padding:10px;">${item.category || 'None'}</td>
            <td style="padding:10px;">$${parseFloat(item.price).toFixed(2)}</td>
            <td style="padding:10px;">
                <button class="button-secondary small edit-item-btn-table">Edit</button>
                <button class="delete-icon-btn">×</button>
            </td>
        </tr>
    `).join('');

    // --- 5. Configs ---
    const headerSettings = settings.headerSettings || { logoAlignment: 'center', hamburgerPosition: 'right' };
    const paymentConfig = settings.paymentConfig || { enableCash: true, maxCashAmount: 100, maxCashItems: 10 };
    const enableStripe = paymentConfig.enableStripe !== false;

    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>God Mode Dashboard</h2>
            ${userManagementHTML}
            ${globalSettingsHTML}
            
            <section class="dashboard-section" style="background:#f0f8ff; border:1px solid #d0e8ff;">
                <h3>Active Orders</h3>
                ${activeOrdersHTML}
            </section>

            <section class="dashboard-section">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <h3>Menu Items</h3>
                    <button id="add-new-item-btn" class="button-primary">+ Add New Item</button>
                </div>
                <div class="table-wrapper">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead style="background:white; border-bottom:2px solid #ddd;">
                            <tr>
                                <th class="sortable" data-sort-col="name" style="padding:10px; cursor:pointer;">Name ${getSortIcon('name')}</th>
                                <th class="sortable" data-sort-col="category" style="padding:10px; cursor:pointer;">Category ${getSortIcon('category')}</th>
                                <th class="sortable" data-sort-col="price" style="padding:10px; cursor:pointer;">Price ${getSortIcon('price')}</th>
                                <th style="padding:10px;">Actions</th>
                            </tr>
                        </thead>
                        <tbody>${menuItemsTableRows}</tbody>
                    </table>
                </div>
            </section>

            <section class="dashboard-section">
                <h3>Menu Categories</h3>
                ${getMenuLayoutHTML()}
            </section>

            <section class="dashboard-section">
                <h3>Payment Settings</h3>
                <form id="payment-settings-form">
                    <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                        <label style="font-weight:bold; display:block; margin-bottom:10px;">Online Payments</label>
                        <label style="display:flex; gap:10px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="enableStripe" ${enableStripe ? 'checked' : ''}> 
                            Enable Stripe (Credit Cards)
                        </label>
                    </div>

                    <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                        <label style="font-weight:bold; display:block; margin-bottom:10px;">Pay on Pickup (Cash)</label>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                            <div>
                                <label>Restrict to Order Value ($)</label>
                                <input type="number" name="maxCashAmount" value="${paymentConfig.maxCashAmount}">
                            </div>
                            <div>
                                <label>Restrict to Item Count</label>
                                <input type="number" name="maxCashItems" value="${paymentConfig.maxCashItems}">
                            </div>
                        </div>
                    </div>
                </form>
            </section>

            <section class="dashboard-section">
                <h3>Header Layout</h3>
                <form id="header-settings-form">
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                        <div>
                            <label>Logo Alignment</label>
                            <select name="logoAlignment">
                                <option value="center" ${headerSettings.logoAlignment === 'center' ? 'selected' : ''}>Center</option>
                                <option value="left" ${headerSettings.logoAlignment === 'left' ? 'selected' : ''}>Left</option>
                            </select>
                        </div>
                        <div>
                            <label>Burger Position</label>
                            <select name="hamburgerPosition">
                                <option value="right" ${headerSettings.hamburgerPosition === 'right' ? 'selected' : ''}>Right</option>
                                <option value="left" ${headerSettings.hamburgerPosition === 'left' ? 'selected' : ''}>Left</option>
                            </select>
                        </div>
                    </div>
                </form>
            </section>

            <section class="dashboard-section">
                <h3>Visual Customization</h3>
                ${uiUtils.getThemeControlsHTML(settings.themeVariables || {})}
            </section>
        </div>
    `;

    attachOwnerDashboardListeners();
    initializeSortable();
}

function getMenuLayoutHTML() {
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();
    if (!categories || categories.length === 0) return `<div id="category-manager"><div class="add-category-row"><input type="text" id="new-category-name" placeholder="New Category"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list"></ul></div>`;
    return `<div id="category-manager"><div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;"><input type="text" id="new-category-name" placeholder="New Category Name"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list">${categories.map(cat => `<li class="category-list-item" data-category-name="${cat}"><div class="drag-handle-wrapper"><span class="drag-handle">☰</span></div><span class="category-name">${cat}</span><button class="button-danger small delete-category-btn">Delete</button></li>`).join('')}</ul></div>`;
}