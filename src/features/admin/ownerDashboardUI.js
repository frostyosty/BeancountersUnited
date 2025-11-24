// src/features/admin/ownerDashboardUI.js
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

    // --- Payment Config Logic ---
    // Defaults: Cash allowed, Stripe allowed, Limits set as requested
    const paymentConfig = settings.paymentConfig || {};
    const enableCash = paymentConfig.enableCash !== false; // Default True
    const enableStripe = paymentConfig.enableStripe !== false; // Default True
    const maxCashAmount = paymentConfig.maxCashAmount || 25;
    const maxCashItems = paymentConfig.maxCashItems || 5;
    const showAllergens = settings.showAllergens || false;

    // 1. Active Orders HTML
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

    // 2. Menu Items HTML
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
                
                <!-- NEW: Allergen Toggle in Menu Section -->
                <div style="margin-top:20px; padding-top:15px; border-top:1px solid #eee;">
                    <form id="global-settings-form"> 
                    <!-- Note: Using global-settings-form ID reusing the listener for ease -->
                        <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="showAllergens" ${showAllergens ? 'checked' : ''}> 
                            Enable Dietary Filters (GF, V, etc) on Client Menu
                        </label>
                        <button type="submit" class="button-secondary small" style="margin-top:10px;">Save Filter Setting</button>
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
                            Enable Stripe (Credit Cards)
                        </label>
                        <p style="font-size:0.85rem; color:#666; margin-top:5px;">Uncheck to disable card payments (e.g. during banking outages).</p>
                    </div>

                    <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                        <label style="font-weight:bold; display:block; margin-bottom:10px;">Pay on Pickup (Cash)</label>
                        
                        <!-- Hidden field to force 'enableCash' true unless we want to add a toggle for it too -->
                        <input type="hidden" name="enableCash" value="on"> 

                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                            <div>
                                <label>Restrict to Order Value ($)</label>
                                <input type="number" name="maxCashAmount" value="${maxCashAmount}">
                            </div>
                            <div>
                                <label>Restrict to Item Count</label>
                                <input type="number" name="maxCashItems" value="${maxCashItems}">
                            </div>
                        </div>
                        <p style="font-size:0.85rem; color:#666; margin-top:10px;">Orders exceeding these limits must pay online.</p>
                    </div>
                    
                    <button type="submit" class="button-primary">Save Payment Rules</button>
                </form>
            </section>

            ${ownerPermissions.canEditTheme ? `
            <section class="dashboard-section">
                <h3>Visual Customization</h3>
                ${uiUtils.getThemeControlsHTML(settings.themeVariables || {})}
                <!-- Button removed (uiUtils usually adds one, or auto-saves on input) -->
            </section>` : ''}
        </div>
    `;

    attachOwnerDashboardListeners();
    if (ownerPermissions.canEditCategories) initializeSortable();
}

// ... (getMenuLayoutHTML and window handler remain the same) ...
function getMenuLayoutHTML() {
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();
    if (!categories || categories.length === 0) return `<div id="category-manager"><p>No categories.</p><div class="add-category-row"><input type="text" id="new-category-name" placeholder="New Category"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list"></ul></div>`;
    return `<div id="category-manager"><div class="add-category-row" style="margin-bottom:10px; display:flex; gap:10px;"><input type="text" id="new-category-name" placeholder="New Category Name"><button id="add-category-btn" class="button-primary small">Add</button></div><ul id="category-list">${categories.map(cat => `<li class="category-list-item" data-category-name="${cat}"><div class="drag-handle-wrapper"><span class="drag-handle">☰</span></div><span class="category-name">${cat}</span><button class="button-danger small delete-category-btn">Delete</button></li>`).join('')}</ul></div>`;
}

window.handleOrderRowClick = (userId, orderId) => {
    const event = window.event; 
    const target = event.target;
    if (target.closest('button')) return;
    if (!userId || userId === 'null' || userId === 'undefined') { uiUtils.showToast("Guest order - no history available.", "info"); return; }
    import('./adminModals.js').then(m => m.showCustomerCRMModal(userId));
};