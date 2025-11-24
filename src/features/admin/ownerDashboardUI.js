// src/features/admin/ownerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { attachOwnerDashboardListeners, initializeSortable, currentSort } from './adminListeners.js';

// --- Helpers (Same as God Dashboard) ---
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

export function renderOwnerDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Fetch Data
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    useAppStore.getState().orderHistory.fetchOrderHistory(); 

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    const { orders } = useAppStore.getState().orderHistory;

    if (isLoadingMenu || isLoadingSettings) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading Dashboard...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`;
        return;
    }

    const ownerPermissions = settings.ownerPermissions || { canEditTheme: true, canEditCategories: true };
    const activeOrders = orders.filter(o => o.status === 'pending' || o.status === 'preparing');

    // --- Active Orders HTML ---
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
                 onclick="window.handleOrderRowClick('${order.user_id}', '${order.id}')">
                <span>#${order.id.slice(0, 4)} - ${displayName} ${noteIcon}</span>
                <span>$${order.total_amount.toFixed(2)}</span>
            </div>
            <div style="font-size:0.9rem; color:#666; margin-top:5px;">
                ${order.order_items.map(i => `${i.quantity}x ${i.menu_items?.name}`).join(', ')}
            </div>
        </div>`;
    }).join('');

    // --- Menu Items HTML ---
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

    // --- Configs ---
    const headerSettings = settings.headerSettings || { logoAlignment: 'center', hamburgerPosition: 'right' };
    const paymentConfig = settings.paymentConfig || { enableCash: true, maxCashAmount: 100, maxCashItems: 10 };
    const enableStripe = paymentConfig.enableStripe !== false;
    const showAllergens = settings.showAllergens || false;

    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>Owner Dashboard</h2>
            
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
                
                <div style="margin-top:20px; padding-top:15px; border-top:1px solid #eee;">
                    <form id="global-settings-form">
                        <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="showAllergens" ${showAllergens ? 'checked' : ''}> 
                            Enable Dietary Filters on Menu
                        </label>
                    </form>
                </div>
            </section>

            ${ownerPermissions.canEditCategories ? `
            <section class="dashboard-section">
                <h3>Menu Categories</h3>
                ${getMenuLayoutHTML()}
            </section>` : ''}

            <section class="dashboard-section">
                <h3>Payment Settings</h3>
                <form id="payment-settings-form">
                    <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                        <label style="font-weight:bold; display:block; margin-bottom:10px;">Online Payments</label>
                        <label style="display:flex; gap:10px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="enableStripe" ${enableStripe ? 'checked' : ''}> 
                            Enable Stripe
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

            ${ownerPermissions.canEditTheme ? `
            <section class="dashboard-section">
                <h3>Visual Customization</h3>
                ${uiUtils.getThemeControlsHTML(settings.themeVariables || {})}
            </section>` : ''}
        </div>
    `;

    attachOwnerDashboardListeners();
    if (ownerPermissions.canEditCategories) initializeSortable();
}

function getMenuLayoutHTML() {
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();
    if (!categories || categories.length === 0) return `<div id="category-manager"><div class="add-category-row"><input type="text" id="new-category-name" placeholder="New Category"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list"></ul></div>`;
    return `<div id="category-manager"><div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;"><input type="text" id="new-category-name" placeholder="New Category Name"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list">${categories.map(cat => `<li class="category-list-item" data-category-name="${cat}"><div class="drag-handle-wrapper"><span class="drag-handle">☰</span></div><span class="category-name">${cat}</span><button class="button-danger small delete-category-btn">Delete</button></li>`).join('')}</ul></div>`;
}

window.handleOrderRowClick = (userId, orderId) => {
    const event = window.event; 
    const target = event.target;
    if (target.closest('button')) return;
    if (!userId || userId === 'null' || userId === 'undefined') { uiUtils.showToast("Guest order - no history available.", "info"); return; }
    import('./adminModals.js').then(m => m.showCustomerCRMModal(userId));
};