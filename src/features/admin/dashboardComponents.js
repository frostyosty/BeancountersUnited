// src/features/admin/dashboardComponents.js
import * as uiUtils from '@/utils/uiUtils.js';

// --- 1. ACTIVE ORDERS ---
export function renderActiveOrdersSection(orders) {
    // Safety check for input
    if (!Array.isArray(orders)) return '<p>Loading orders...</p>';

    const activeOrders = orders.filter(o => o.status === 'pending' || o.status === 'preparing');
    
    const content = activeOrders.length === 0 ? '<p>No active orders.</p>' : activeOrders.map(order => {
        const profile = order.profiles || {}; 
        const displayName = order.customer_name || profile.internal_nickname || profile.full_name || profile.email || 'Guest';
        const clickName = displayName.replace(/'/g, "\\'");

        let noteIcon = '';
        if (profile.staff_note) {
            noteIcon = profile.staff_note_urgency === 'alert' ? `<span title="Important">🔴</span>` : `<span title="Info">🔵</span>`;
        }

        const orderId = order.id ? order.id.slice(0, 4) : '????';
        const total = parseFloat(order.total_amount || 0).toFixed(2);

        return `
        <div class="order-card" style="background:white; border:1px solid #eee; padding:10px; margin-bottom:10px; border-radius:4px;">
            <div class="order-header" style="cursor:pointer; display:flex; justify-content:space-between; font-weight:bold;" 
                 onclick="window.handleOrderRowClick('${order.user_id}', '${clickName}')">
                <span>#${orderId} - ${displayName} ${noteIcon}</span>
                <span>$${total}</span>
            </div>
            <div style="font-size:0.9rem; color:#666; margin-top:5px;">
                ${(order.order_items || []).map(i => `${i.quantity}x ${i.menu_items?.name || 'Item'}`).join(', ')}
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
        <tr data-item-id="${item.id}" 
            style="background-color: ${getCategoryColor(item.category||'')}; border-bottom:1px solid #fff; cursor:pointer;"
            onclick="window.handleItemRowClick('${item.id}')"> <!-- Row Click triggers Edit Details -->
            
            <!-- Image Column: Stop Propagation so it doesn't trigger row click -->
            <td style="padding:10px; width:60px;" onclick="event.stopPropagation()">
                <div style="position:relative; width:40px; height:40px;">
                    <img src="${item.image_url || '/placeholder-coffee.jpg'}" 
                         class="admin-item-thumb" 
                         style="width:100%; height:100%; object-fit:cover; border-radius:4px; cursor:pointer; border:1px solid #ccc;" 
                         onclick="window.handleItemPhotoClick('${item.id}')" 
                         title="Click to Edit Photo">
                </div>
            </td>
            
            <td style="padding:10px;">
                <div style="font-weight:500;">${item.name}</div>
                <div style="margin-top:2px;">${getAllergenBadges(item.allergens)}</div>
            </td>
            <td style="padding:10px;">${item.category || 'None'}</td>
            <td style="padding:10px;">$${parseFloat(item.price).toFixed(2)}</td>
            
            <!-- Actions: Stop Propagation so buttons work -->
            <td style="padding:10px;" onclick="event.stopPropagation()">
                <button class="button-secondary small edit-item-btn-table">Edit</button>
                <button class="delete-icon-btn" title="Delete">×</button>
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
                            <th style="padding:10px;">Img</th>
                            <th class="sortable" data-sort-col="name" style="padding:10px; cursor:pointer;">Name ${getSortIcon('name')}</th>
                            <th class="sortable" data-sort-col="category" style="padding:10px; cursor:pointer;">Category ${getSortIcon('category')}</th>
                            <th class="sortable" data-sort-col="price" style="padding:10px; cursor:pointer;">Price ${getSortIcon('price')}</th>
                            <th style="padding:10px;">Actions</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>

            <!-- Allergen Toggle -->
            <div style="margin-top:20px; padding-top:15px; border-top:1px solid #eee;">
                <form id="menu-config-form">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="showAllergens" ${showAllergens === true ? 'checked' : ''}> 
                        Enable Dietary Filters on Menu
                    </label>
                </form>
            </div>
        </section>
    `;
}

// --- 3. GLOBAL SETTINGS ---
export function renderGlobalSettingsSection(settings) {
    const currentLogo = settings.logoUrl || '';
    const hamburgerConfig = settings.hamburgerMenuContent || 'main-nav';
    // Removed aboutEnabled logic from here

    return `
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
                    <label>Features & Content</label>
                    <div style="display:flex; flex-direction:column; gap:10px; margin-top:5px;">
                        <div style="display:flex; gap:15px;">
                            <label><input type="radio" name="hamburgerMenuContent" value="main-nav" ${hamburgerConfig==='main-nav'?'checked':''}> Simple Menu</label>
                            <label><input type="radio" name="hamburgerMenuContent" value="categories" ${hamburgerConfig==='categories'?'checked':''}> Category List</label>
                        </div>
                    </div>
                </div>
            </form>
        </section>
    `;
}

// --- 4. ABOUT CONFIG (NEW) ---
export function renderAboutConfigSection(settings) {
    const aboutEnabled = settings.aboutUs?.enabled || false;
    
    return `
        <section class="dashboard-section">
            <h3>About Page Configuration</h3>
            <form id="about-config-form">
                <div class="form-group">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="enableAboutUs" ${aboutEnabled ? 'checked' : ''}> 
                        Enable "About Us" Page
                    </label>
                    <p style="font-size:0.85rem; color:#666; margin-top:5px; margin-left: 24px;">
                        When enabled, an "About" link appears in the bottom of the menu. 
                        <br>To edit the content, navigate to the About page and click "Edit Content".
                    </p>
                    <div style="margin-top:10px; margin-left:24px;">
                        <a href="#about-us" class="button-secondary small">Go to About Page</a>
                    </div>
                </div>
            </form>
        </section>
    `;
}

// --- 5. APPEARANCE ---
export function renderAppearanceSection(settings) {
    // ... (No changes here, keep existing code from previous response) ...
    const bgImage = settings.themeVariables?.['--body-background-image']?.replace(/url\(['"]?|['"]?\)/g, '') || '';
    const bgColor = settings.themeVariables?.['--background-color'] || '#ffffff';
    const uiConfig = settings.uiConfig || {}; 
    const transitionType = uiConfig.pageTransition || 'none';
    const staggerEnabled = uiConfig.staggerMenu || false;
    const bgType = uiConfig.backgroundType || 'color'; 
    const bgParallax = uiConfig.bgParallax || false;
    const bgAnimation = uiConfig.bgAnimation || false;

    return `
        <section class="dashboard-section">
            <h3>Appearance & Animations</h3>
            <div style="margin-bottom:20px;">
                ${uiUtils.getThemeControlsHTML(settings.themeVariables || {})}
            </div>
            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">
            <form id="appearance-settings-form">
                <h4>Site Background</h4>
                <div class="form-group" style="display:flex; gap:15px; margin-bottom:15px;">
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="backgroundType" value="color" ${bgType==='color'?'checked':''}> Solid Color</label>
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="backgroundType" value="image" ${bgType==='image'?'checked':''}> Custom Image</label>
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="backgroundType" value="pattern" ${bgType==='pattern'?'checked':''}> Name Pattern</label>
                </div>
                <div class="form-group bg-control-group" id="bg-ctrl-color" style="display:${bgType==='color'?'block':'none'}">
                    <label>Background Color</label>
                    <input type="color" data-css-var="--background-color" value="${bgColor}" style="width:100%; height:40px;">
                </div>
                <div class="form-group bg-control-group" id="bg-ctrl-image" style="display:${bgType==='image'?'block':'none'}">
                    <label>Upload Image</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img id="bg-preview" src="${bgImage}" style="width:40px; height:40px; object-fit:cover; border:1px solid #ddd; background:#eee;">
                        <label for="bg-upload" class="button-secondary small" style="cursor:pointer;">Upload</label>
                        <input type="file" id="bg-upload" accept="image/*" style="display:none;">
                        <button type="button" id="clear-bg-btn" class="button-danger small">Remove</button>
                    </div>
                    <div style="margin-top:10px;">
                        <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="bgParallax" ${bgParallax ? 'checked' : ''}> Enable Parallax
                        </label>
                    </div>
                </div>
                <div class="form-group bg-control-group" id="bg-ctrl-pattern" style="display:${bgType==='pattern'?'block':'none'}">
                    <p style="font-size:0.9rem; color:#666;">Generates a diagonal pattern using your Website Name.</p>
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="bgAnimation" ${bgAnimation ? 'checked' : ''}> Animate (Slow Scroll)
                    </label>
                </div>
                <h4 style="margin-top:20px;">UI Transitions</h4>
                <div class="form-group">
                    <label>Page Transition</label>
                    <select name="pageTransition">
                        <option value="none" ${transitionType==='none'?'selected':''}>None</option>
                        <option value="fade" ${transitionType==='fade'?'selected':''}>Fade In</option>
                        <option value="slide" ${transitionType==='slide'?'selected':''}>Slide Up</option>
                        <option value="zoom" ${transitionType==='zoom'?'selected':''}>Zoom In</option>
                    </select>
                </div>
                <div class="form-group">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="staggerMenu" ${staggerEnabled ? 'checked' : ''}> Gradual Menu Item Reveal
                    </label>
                </div>
            </form>
        </section>
    `;
}

// --- 6. PAYMENT SETTINGS ---
export function renderPaymentSection(paymentConfig) {
    const enableStripe = paymentConfig.enableStripe !== false;
    return `
        <section class="dashboard-section" style="border: 2px solid #dc3545;">
            <h3 style="color: #dc3545;">Payment & Emergency Controls</h3>
            <p style="font-size:0.9rem; color:#666; margin-bottom:15px;">
                These settings control what <strong>Customers</strong> see. 
            </p>
            <form id="payment-settings-form">
                <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                    <label style="font-weight:bold; display:block; margin-bottom:10px;">Stripe (Credit Cards)</label>
                    <label style="display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="enableStripe" ${enableStripe ? 'checked' : ''}> 
                        Enable Online Card Payments
                    </label>
                </div>
                <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                    <label style="font-weight:bold; display:block; margin-bottom:10px;">Customer "Pay on Pickup" Rules</label>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                        <div><label>Max Order Value ($)</label><input type="number" name="maxCashAmount" value="${paymentConfig.maxCashAmount}"></div>
                        <div><label>Max Item Count</label><input type="number" name="maxCashItems" value="${paymentConfig.maxCashItems}"></div>
                    </div>
                </div>
            </form>
        </section>
    `;
}

// --- 7. HEADER SETTINGS ---
export function renderHeaderSection(headerSettings) {
    const height = headerSettings.height || 60;
    const bgColor = headerSettings.bgColor || '#ffffff'; 

    return `
        <section class="dashboard-section">
            <h3>Header Layout</h3>
            <form id="header-settings-form">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
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

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div class="form-group">
                        <label>Height: <span id="header-height-val">${height}px</span></label>
                        <input type="range" name="headerHeight" min="50" max="150" value="${height}" 
                               oninput="document.getElementById('header-height-val').textContent = this.value + 'px'; document.documentElement.style.setProperty('--header-height', this.value + 'px');">
                    </div>
                    <div class="form-group">
                        <label>Header Background</label>
                        <div style="display:flex; align-items:center; gap:10px; border:1px solid #ccc; padding:4px; border-radius:4px;">
                            <input type="color" name="headerBgColor" value="${bgColor}" 
                                   style="width:40px; height:30px; border:none; background:none; cursor:pointer;"
                                   oninput="document.getElementById('main-header').style.backgroundColor = this.value;">
                            <span style="font-size:0.8rem; color:#666;">Pick Color</span>
                        </div>
                    </div>
                </div>

                <div style="padding-top:15px; border-top:1px solid #eee;">
                    <label style="display:block; margin-bottom:5px;">Custom Vector Banner</label>
                    <button type="button" id="open-header-creator-btn" class="button-secondary" style="width:100%;">
                        🎨 Create/Edit Header Logo
                    </button>
                </div>
            </form>
        </section>
    `;
}

// --- 8. CLIENT RELATIONSHIPS (Owner) ---
export function renderClientRelationshipsSection(clients) {
    if (!clients) return '<p>Loading clients...</p>';
    
    const rows = clients.map(client => {
        const lastOrderDate = client.lastOrder ? new Date(client.lastOrder).toLocaleDateString() : '-';
        const displayName = client.internal_nickname || client.full_name || client.email || 'Unknown';
        const noteIcon = client.staff_note ? '📝' : '';
        const spend = parseFloat(client.totalSpend || 0).toFixed(2);

        return `
            <tr onclick="window.handleOrderRowClick('${client.id}')" style="cursor:pointer; border-bottom:1px solid #eee;">
                <td style="padding:10px; font-weight:500;">
                    ${displayName} ${noteIcon}
                    <div style="font-size:0.8rem; color:#888;">${client.email}</div>
                </td>
                <td style="padding:10px;">${client.orderCount}</td>
                <td style="padding:10px; color:var(--primary-color); font-weight:bold;">$${spend}</td>
                <td style="padding:10px;">${lastOrderDate}</td>
                <td style="padding:10px;">
                    <button class="button-secondary small" onclick="event.stopPropagation(); window.handleMergeClick('${client.id}')">Merge</button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <section class="dashboard-section">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h3>Client Relationships</h3>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="client-search" placeholder="Search..." style="padding:5px; border:1px solid #ccc; border-radius:4px;">
                    <button class="button-primary small" onclick="window.showAddPastOrderModal()">+ Past Order</button>
                </div>
            </div>
            <div class="table-wrapper" style="max-height: 400px; overflow-y: auto;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead style="background:#f9f9f9; position:sticky; top:0; z-index:1;">
                        <tr>
                            <th style="padding:10px;">Name / Email</th>
                            <th style="padding:10px;">Orders</th>
                            <th style="padding:10px;">Total Spend</th>
                            <th style="padding:10px;">Last Seen</th>
                            <th style="padding:10px;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="client-table-body">${rows}</tbody>
                </table>
            </div>
        </section>
    `;
}