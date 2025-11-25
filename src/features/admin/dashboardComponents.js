// src/features/admin/dashboardComponents.js
import * as uiUtils from '@/utils/uiUtils.js';

// --- 1. ACTIVE ORDERS ---
export function renderActiveOrdersSection(orders) {
    const activeOrders = orders.filter(o => o.status === 'pending' || o.status === 'preparing');
    
    const content = activeOrders.length === 0 ? '<p>No active orders.</p>' : activeOrders.map(order => {
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

    return `
        <section class="dashboard-section" style="background:#f0f8ff; border:1px solid #d0e8ff;">
            <h3>Active Orders</h3>
            ${content}
        </section>
    `;
}

// --- 2. MENU ITEMS TABLE ---
export function renderMenuSection(menuItems, sortConfig, getCategoryColor, getAllergenBadges, getSortIcon, showAllergens) {
    const sortedItems = [...menuItems].sort((a, b) => {
        const col = sortConfig.column;
        const valA = col === 'price' ? parseFloat(a[col]) : (a[col] || '').toLowerCase();
        const valB = col === 'price' ? parseFloat(b[col]) : (b[col] || '').toLowerCase();
        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    const rows = sortedItems.map(item => `
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

    return `
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
                    <tbody>${rows}</tbody>
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
    `;
}

// --- 3. NEW: APPEARANCE & ANIMATIONS ---
export function renderAppearanceSection(settings) {
    const bgImage = settings.themeVariables?.['--body-background-image'] || '';
    const bgColor = settings.themeVariables?.['--background-color'] || '#ffffff';
    const uiConfig = settings.uiConfig || {}; // New config object for animations
    
    const transitionType = uiConfig.pageTransition || 'none';
    const staggerEnabled = uiConfig.staggerMenu || false;

    return `
        <section class="dashboard-section">
            <h3>Appearance & Animations</h3>
            
            <!-- Visual Theme Controls (Colors/Fonts) -->
            <div style="margin-bottom:20px;">
                ${uiUtils.getThemeControlsHTML(settings.themeVariables || {})}
            </div>

            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

            <form id="appearance-settings-form">
                <h4>Site Background</h4>
                <div class="form-group">
                    <label>Background Color</label>
                    <input type="color" data-css-var="--background-color" value="${bgColor}" style="width:100%; height:40px;">
                </div>
                <div class="form-group">
                    <label>Background Image</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img id="bg-preview" src="${bgImage}" style="width:40px; height:40px; object-fit:cover; border:1px solid #ddd; display:${bgImage?'block':'none'}; background:#eee;">
                        <label for="bg-upload" class="button-secondary small" style="cursor:pointer;">Upload Image</label>
                        <input type="file" id="bg-upload" accept="image/*" style="display:none;">
                        <button type="button" id="clear-bg-btn" class="button-danger small" style="display:${bgImage?'block':'none'};">Remove</button>
                    </div>
                    <!-- Hidden input to store URL for autosave logic if needed, though we handle upload separately -->
                    <input type="hidden" name="bgUrl" id="bg-url-input" value="${bgImage}">
                </div>

                <h4 style="margin-top:20px;">Animations</h4>
                <div class="form-group">
                    <label>Page Transition Style</label>
                    <select name="pageTransition">
                        <option value="none" ${transitionType==='none'?'selected':''}>None (Instant)</option>
                        <option value="fade" ${transitionType==='fade'?'selected':''}>Fade In</option>
                        <option value="slide" ${transitionType==='slide'?'selected':''}>Slide Up</option>
                        <option value="zoom" ${transitionType==='zoom'?'selected':''}>Zoom In</option>
                    </select>
                </div>
                <div class="form-group">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="staggerMenu" ${staggerEnabled ? 'checked' : ''}> 
                        Gradual Menu Item Reveal (Waterfall)
                    </label>
                </div>
            </form>
        </section>
    `;
}

// --- 4. PAYMENT SETTINGS ---
export function renderPaymentSection(paymentConfig) {
    const enableStripe = paymentConfig.enableStripe !== false;
    return `
        <section class="dashboard-section" style="border: 2px solid #dc3545;">
            <h3 style="color: #dc3545;">Payment & Emergency Controls</h3>
            <form id="payment-settings-form">
                <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                    <label style="font-weight:bold; display:block; margin-bottom:10px;">Online Payments</label>
                    <label style="display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="enableStripe" ${enableStripe ? 'checked' : ''}> 
                        Enable Stripe (Credit Cards)
                    </label>
                    <p style="font-size:0.85rem; color:#666; margin-top:5px;">Uncheck to disable card payments immediately.</p>
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
    `;
}

// --- 5. HEADER SETTINGS ---
export function renderHeaderSection(headerSettings) {
    return `
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
    `;
}