// src/features/user/orderHistoryUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';
import { TABLES } from '@/config/tenancy.js';


const STEPPER_CSS = `
<style>
    .stepper-container { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .stepper-btn { width: 32px; height: 32px; border-radius: 50%; border: none; background-color: #eee; color: #333; font-weight: bold; font-size: 1.2rem; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; transition: background 0.2s; }
    .stepper-btn:active { background-color: #ddd; transform: scale(0.95); }
    .stepper-btn.plus { background-color: var(--primary-color); color: white; }
    .stepper-val { font-weight: 600; min-width: 20px; text-align: center; }
    .hidden { display: none !important; }
    
    /* Archive Table Styles */
 .archive-section { background-color: #f0f0f0; border-top: 4px solid #ccc; padding: 20px; margin-top: 40px; border-radius: 8px; }
    
    /* FIX: Added flex-wrap and gap */
    .archive-header { 
        display: flex; 
        justify-content: space-between; 
        align-items: center; 
        flex-wrap: wrap; /* Allows stacking on mobile */
        gap: 10px;       /* Spacing when stacked */
        margin-bottom: 15px; 
        color: #666; 
    }
    
    .archive-table { width: 100%; border-collapse: collapse; opacity: 0.8; }
    .archive-table th { text-align: left; padding: 8px; border-bottom: 2px solid #ccc; font-size: 0.85rem; }
    .archive-table td { padding: 8px; border-bottom: 1px solid #ddd; font-size: 0.85rem; color: #555; }
    .archive-table tr:hover { background-color: #e9e9e9; opacity: 1; }

    /* Modal Tabs */
    .modal-tabs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid #eee; }
    .modal-tab { padding: 6px 12px; border-radius: 20px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
    .modal-tab.active { background: var(--primary-color); color: white; border-color: var(--primary-color); }
</style>
`;

// --- STATE ---
let timerInterval = null;
let isArchiveOpen = false;


export function renderOrderHistoryPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    if (timerInterval) clearInterval(timerInterval);

    useAppStore.getState().orderHistory.fetchOrderHistory();
    useAppStore.getState().orderHistory.subscribeToOrders();
    useAppStore.getState().menu.fetchMenu(); 
    useAppStore.getState().siteSettings.fetchSiteSettings(); // Need settings for archive logic

    const { orders, isLoading, error } = useAppStore.getState().orderHistory;
    const { settings } = useAppStore.getState().siteSettings;
    const { getUserRole } = useAppStore.getState().auth;
    const role = getUserRole();

if (isLoading) {

        mainContent.innerHTML = uiUtils.getLoaderHTML("Loading orders...");
        return;
    }
    if (error) { mainContent.innerHTML = `<div class="error-message"><h3>Error</h3><p>${error}</p></div>`; return; }

    if (role === 'god' || role === 'owner') {
        renderAdminOrderViews(mainContent, orders || [], role, settings);
    } else {
        renderCustomerOrderList(mainContent, orders || []);
    }
}

// --- ADMIN VIEW (Live + Archive) ---
function renderAdminOrderViews(container, orders, role, settings) {
// 1. Get Archive Settings (Defensive Parsing)
    let archiveConfig = settings.archiveSettings;
    
    // Safety: If API sent a string (legacy data), parse it manually
    if (typeof archiveConfig === 'string') {
        try { archiveConfig = JSON.parse(archiveConfig); } catch (e) { archiveConfig = {}; }
    }

    // Default to 48 if missing
    archiveConfig = archiveConfig || { autoArchiveHours: 48 };
    const archiveHours = archiveConfig.autoArchiveHours || 48; // Fallback if property missing
    
    const maxAgeMs = archiveHours * 60 * 60 * 1000;
    const now = Date.now();

 const { highlightOrderId, setHighlightOrderId } = useAppStore.getState().ui;
 
    // 2. Split Orders (With Time Logic)
    const liveOrders = [];
    const archivedOrders = [];

    orders.forEach(o => {
        const orderTime = new Date(o.created_at).getTime();
        const age = now - orderTime;
        const isOld = age > maxAgeMs;

        if ((o.status === 'pending' || o.status === 'preparing') && !isOld) {
            liveOrders.push(o);
        } else {
            archivedOrders.push(o);
        }
    });
    
    // Sort
    liveOrders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    archivedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // --- Helper: Row Generator ---
    const createRow = (order, isLive) => {
        const time = new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(order.created_at).toLocaleDateString();
        const displayTime = isLive ? time : `${date} ${time}`;

        let dueDisplay = '';
        if (isLive) {
            const dueTimeStr = order.pickup_time || order.created_at;
            dueDisplay = `<span class="live-timer" data-due="${dueTimeStr}">...</span>`;
        } else {
            // ARCHIVE DATE LOGIC
            const dueD = new Date(order.pickup_time || order.created_at);
            const timeStr = dueD.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            
            // Calculate Day Diff
            const now = new Date();
            // Reset to midnight for clean day comparison
            const d1 = new Date(dueD.getFullYear(), dueD.getMonth(), dueD.getDate());
            const d2 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const diffDays = Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
            
            let dayLabel = '';
            if (diffDays === 0) dayLabel = ''; // Today
            else if (diffDays === 1) dayLabel = ' <span style="font-size:0.8em; color:#888;">(Yest)</span>';
            else if (diffDays < 7) dayLabel = ` <span style="font-size:0.8em; color:#888;">(${diffDays}d)</span>`;
            else dayLabel = ` <span style="font-size:0.8em; color:#888;">(${dueD.getDate()}/${dueD.getMonth()+1})</span>`;

            dueDisplay = `${timeStr}${dayLabel}`;
        }

        const customerName = order.customer_name || order.profiles?.full_name || order.profiles?.email || 'Guest';
        const safeName = customerName.replace(/'/g, "");
        const clickName = customerName.replace(/'/g, "\\'"); 

        const itemsSummary = (order.order_items || []).map(i => {
            const opts = (i.selected_options && i.selected_options.length > 0) 
                ? ` <span style="color:#d63384; font-size:0.85em;">(${i.selected_options.join(', ')})</span>` 
                : '';
            return `${i.quantity}x ${i.menu_items?.name || 'Item'}${opts}`;
        }).join(', ') || 'No items';

        const totalFormatted = `$${parseFloat(order.total_amount).toFixed(2)}`;
        const statusClass = `status-${order.status}`;
        
        const dismissBtn = `<button class="delete-icon-btn action-btn" data-action="dismiss" data-name="${safeName}" data-total="${totalFormatted}" title="Archive">×</button>`;
        const deleteBtn = (role === 'god') 
            ? `<button class="delete-icon-btn action-btn" data-action="delete" title="Permanent Delete" style="color:#d00;">🗑</button>` 
            : '';
        const actionCell = isLive ? `<td>${dismissBtn}</td>` : (role === 'god' ? `<td>${deleteBtn}</td>` : '<td></td>');
        
        const customerCell = `<td style="padding:12px;"><span class="client-name-btn" onclick="window.handleOrderRowClick('${order.user_id}', '${clickName}')">${customerName}</span></td>`;


// FIX: Calculate if this row should flash
        const highlightClass = (order.id === highlightOrderId) ? 'flash-highlight' : '';

        return `
            <tr class="${statusClass} ${highlightClass}" data-order-id="${order.id}">
                <td style="padding:12px; font-weight:bold; white-space:nowrap;">${dueDisplay}</td>
                <td style="padding:12px; font-size:0.9rem;">${itemsSummary}</td>
                ${customerCell}
                <td style="padding:12px; font-weight:bold;">${totalFormatted}</td>
                <td style="padding:12px;"><span class="badge ${statusClass}">${order.status.toUpperCase()}</span></td>
                <td style="padding:12px; color:#666; font-size:0.85rem; white-space:nowrap;">${displayTime}</td>
                ${actionCell}
            </tr>
        `;
    };

    const liveRows = liveOrders.map(o => createRow(o, true)).join('');
    const archiveRows = archivedOrders.map(o => createRow(o, false)).join('');

    const headersHTML = `
        <tr>
            <th style="padding:12px; text-align:left;">Due</th>
            <th style="padding:12px; text-align:left;">Items</th>
            <th style="padding:12px; text-align:left;">Customer</th>
            <th style="padding:12px; text-align:left;">Total</th>
            <th style="padding:12px; text-align:left;">Status</th>
            <th style="padding:12px; text-align:left;">Filed At</th>
            <th style="padding:12px; text-align:left;">Action</th>
        </tr>
    `;

    // Format Hours Text
    const hoursText = archiveHours === 1 ? '1 hour' : `${archiveHours} hours`;

    container.innerHTML = `
        ${STEPPER_CSS}
        <div class="dashboard-container">
            <!-- LIVE ORDERS -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h2 style="color: var(--primary-color);">Live Orders</h2>
                <button id="btn-manual-order" class="button-secondary small" style="font-weight: 600;">+ Phone Order</button>
            </div>

            <div class="table-wrapper" style="margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <table class="admin-orders-table" style="width:100%; border-collapse:collapse;">
                    <thead style="background:var(--surface-color); border-bottom: 2px solid var(--primary-color);">
                        ${headersHTML}
                    </thead>
                    <tbody style="background:white;">
                        ${liveRows.length > 0 ? liveRows : '<tr><td colspan="7" style="text-align:center; padding:30px; color:#999;">No live orders.</td></tr>'}
                    </tbody>
                </table>
            </div>

            <!-- ARCHIVE -->
            <div class="archive-section">
                <div class="archive-header">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <h3 style="margin:0;">Archived Orders (Log)</h3>
                        <button id="btn-archive-settings" class="button-secondary small" style="padding:2px 8px; font-size:0.75rem;">⚙️ Settings</button>
                    </div>
                    
                    <!-- Button Text Update -->
                    <button id="toggle-archive-btn" class="button-secondary small" style="margin-left: 15px;">
                        ${isArchiveOpen ? 'Hide Archive' : 'Show Archive'}
                    </button>
                </div>
                
                <!-- NEW: Info Text -->
                <p style="margin-top:-10px; margin-bottom:15px; color:#888; font-style:italic; font-size:0.85rem;">
                    Orders moved here automatically after ${hoursText}.
                </p>
                
                <!-- FIX: Use isArchiveOpen to determine display -->
                <div id="archive-table-container" style="display:${isArchiveOpen ? 'block' : 'none'};">
                    <input type="text" id="archive-search" placeholder="Search archive..." style="width:100%; padding:8px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px;">
                    <div style="max-height: 400px; overflow-y: auto;">
                        <table class="archive-table">
                            <thead>${headersHTML}</thead>
                            <tbody id="archive-tbody">
                                ${archiveRows.length > 0 ? archiveRows : '<tr><td colspan="7">No history found.</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    `;

    // --- Listeners ---
    
// FIX: Clear the highlight ID after render so it doesn't persist
    if (highlightOrderId) {
        setTimeout(() => {
            setHighlightOrderId(null);
            
            // Optional: Scroll to it
            const row = container.querySelector(`tr[data-order-id="${highlightOrderId}"]`);
            if(row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 500); // Wait for DOM
    }

    startLiveTimers();

    document.getElementById('btn-manual-order')?.addEventListener('click', showManualOrderModal);
    
    document.getElementById('btn-archive-settings')?.addEventListener('click', () => {
        showArchiveSettingsModal(settings.archiveSettings || {});
    });

    const archiveContainer = document.getElementById('archive-table-container');
    const toggleBtn = document.getElementById('toggle-archive-btn');
    if (toggleBtn) {
        toggleBtn.onclick = () => {
            const isHidden = archiveContainer.style.display === 'none';
            archiveContainer.style.display = isHidden ? 'block' : 'none';
            toggleBtn.textContent = isHidden ? 'Hide Archive' : 'Show Archive';
        };
    }

    const searchInput = document.getElementById('archive-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('#archive-tbody tr').forEach(row => {
                row.style.display = row.innerText.toLowerCase().includes(term) ? '' : 'none';
            });
        });
    }
    
    container.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation(); 
            const orderId = e.target.closest('tr').dataset.orderId;
            const action = e.target.dataset.action;
            const name = e.target.dataset.name;
            const total = e.target.dataset.total;

            if (action === 'dismiss') {
                useAppStore.getState().orderHistory.dismissOrder(orderId);
                uiUtils.showToast(`Dismissed ${name}'s ${total} Order`, "info");
            } 
            else if (action === 'delete') {
                // Optimistic UI Removal
                const row = e.target.closest('tr');
                if (row) {
                    row.style.transition = "opacity 0.3s";
                    row.style.opacity = "0";
                    setTimeout(() => row.remove(), 300);
                }

                // FIX: Use TABLES.ORDERS
                const { error } = await supabase.from(TABLES.ORDERS).delete().eq('id', orderId);
                
                if (!error) {
                    uiUtils.showToast("Record deleted.", "success");
                    useAppStore.getState().orderHistory.fetchOrderHistory(true);
                } else {
                    console.error("Delete DB Error:", error);
                    uiUtils.showToast("Delete failed.", "error");
                    // Reload to restore row if failed
                    useAppStore.getState().orderHistory.fetchOrderHistory();
                }
            }
        });
    });
}

// --- NEW: Archive Settings Modal ---
function showArchiveSettingsModal(currentConfig) {
    const hours = currentConfig.autoArchiveHours || 48;

    const modalHTML = `
        <div class="modal-form-container">
            <h3>Archive Settings</h3>
            <p>Automatically move "Live" orders to "Archive" if they are older than:</p>
            
            <form id="archive-config-form">
                <div class="form-group">
                    <label>Age Limit</label>
                    <select name="autoArchiveHours" style="width:100%; padding:8px;">
                        <option value="1" ${hours==1?'selected':''}>1 Hour</option>
                        <option value="4" ${hours==4?'selected':''}>4 Hours</option>
                        <option value="12" ${hours==12?'selected':''}>12 Hours</option>
                        <option value="24" ${hours==24?'selected':''}>24 Hours</option>
                        <option value="48" ${hours==48?'selected':''}>48 Hours (2 Days)</option>
                        <option value="168" ${hours==168?'selected':''}>1 Week</option>
                        <option value="336" ${hours==336?'selected':''}>2 Weeks</option>
                    </select>
                </div>
                <div style="text-align:right; margin-top:15px;">
                    <button type="submit" class="button-primary">Save Settings</button>
                </div>
            </form>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    document.getElementById('archive-config-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const newConfig = {
            autoArchiveHours: parseInt(formData.get('autoArchiveHours'))
        };
        
        const { data: { session } } = await supabase.auth.getSession();
        
        try {
            await api.updateSiteSettings({ archiveSettings: newConfig }, session.access_token);
            uiUtils.showToast("Archive settings saved.", "success");
            uiUtils.closeModal();
            // Refresh to apply new filter immediately
            useAppStore.getState().siteSettings.fetchSiteSettings(true); 
            useAppStore.getState().ui.triggerPageRender(); 
        } catch(err) {
            uiUtils.showToast("Failed to save.", "error");
        }
    });
}




// --- MANUAL ORDER MODAL ---
function showManualOrderModal() {
    const { items: menuItems } = useAppStore.getState().menu;
    const { orders } = useAppStore.getState().orderHistory; // Need orders for stats
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = ['All', ...getMenuCategories()];
    
    // --- 0. Calculate Popularity ---
    const popularityMap = {};
    if (orders) {
        orders.forEach(order => {
            if (order.status !== 'cancelled' && order.order_items) {
                order.order_items.forEach(oi => {
                    // Count frequency of menu_item_id
                    const id = oi.menu_item_id;
                    popularityMap[id] = (popularityMap[id] || 0) + (oi.quantity || 1);
                });
            }
        });
    }

    // Sort items: High popularity -> Low popularity, then Alphabetical
    const sortedItems = [...menuItems].sort((a, b) => {
        const countA = popularityMap[a.id] || 0;
        const countB = popularityMap[b.id] || 0;
        if (countB !== countA) return countB - countA; // Most popular first
        return a.name.localeCompare(b.name); // Fallback to A-Z
    });

    // --- 1. Category Tabs HTML ---
    const tabsHtml = categories.map(cat => 
        `<button class="modal-tab ${cat === 'All' ? 'active' : ''}" data-category="${cat}">${cat}</button>`
    ).join('');

    // --- 2. Items HTML (Using SORTED items) ---
    const itemRows = sortedItems.map(item => `
        <div class="manual-order-row" data-category="${item.category || 'Uncategorized'}" data-item-id="${item.id}" data-price="${item.price}" style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid #eee;">
            <div style="flex:2; font-weight:500;">
                ${item.name} 
                <span style="color:#666; font-size:0.9rem; font-weight:normal;">($${parseFloat(item.price).toFixed(2)})</span>
                ${(popularityMap[item.id] > 5) ? '<span style="font-size:0.7rem; color:orange; margin-left:5px;">★</span>' : ''} 
            </div>
            <div style="flex:1;">
                <div class="stepper-container">
                    <button class="stepper-btn minus hidden" data-action="minus">-</button>
                    <span class="stepper-val hidden">0</span>
                    <button class="stepper-btn plus" data-action="plus">+</button>
                </div>
            </div>
        </div>
    `).join('');

    // ... (Rest of the function: modalHTML, listeners, submit logic remains exactly the same) ...
    // Copy the rest of showManualOrderModal from your current file here.
    // The key change was sorting the 'sortedItems' array before mapping 'itemRows'.
    
    // For completeness of the function logic structure:
    const modalHTML = `
        <div class="modal-form-container">
            <h3>Create Phone Order</h3>
            <!-- ... inputs for name/time ... -->
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:15px;">
                <div>
                    <label style="font-weight:600; display:block; margin-bottom:5px;">Customer Name</label>
                    <input type="text" id="manual-customer-name" placeholder="e.g. Steve" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                </div>
                <div>
                    <label style="font-weight:600; display:block; margin-bottom:5px;">Due Time</label>
                    <select id="manual-due-select" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
                        <option value="0">Now (ASAP)</option>
                        <option value="10">10 Mins</option>
                        <option value="15">15 Mins</option>
                        <option value="30">30 Mins</option>
                        <option value="60">1 Hour</option>
                        <option value="other">Other...</option>
                    </select>
                    <input type="time" id="manual-due-time-input" style="display:none; width:100%; margin-top:5px; padding:8px; border:1px solid #ccc; border-radius:4px;">
                </div>
            </div>

            <div class="modal-tabs" id="manual-order-tabs">${tabsHtml}</div>

            <div id="manual-items-list" style="max-height: 300px; overflow-y: auto; margin-bottom: 15px; border: 1px solid #ddd; padding: 10px; border-radius: 6px; background:#fff;">
                ${itemRows}
            </div>
            
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-top:10px; border-top:2px solid #eee;">
                <span style="font-size:1.1rem;">Total Amount:</span>
                <span style="font-size:1.5rem; font-weight:bold;">$<span id="manual-order-total">0.00</span></span>
            </div>
            <div class="form-actions">
                <button id="submit-manual-order" class="button-primary" style="width:100%; padding:12px;" disabled>Add Items to Order</button>
            </div>
        </div>
    `;

    uiUtils.showModal(modalHTML);
    // ... attach listeners (copy from previous implementation) ...
    // Note: The rest of the logic (tabs, stepper, submit) is identical to before.
    
    // Quick refresher on the Tab Logic to ensure it works with sorted items:
    const tabsContainer = document.getElementById('manual-order-tabs');
    if(tabsContainer) {
        tabsContainer.addEventListener('click', (e) => {
            if (!e.target.classList.contains('modal-tab')) return;
            tabsContainer.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            const cat = e.target.dataset.category;
            document.querySelectorAll('.manual-order-row').forEach(row => {
                if (cat === 'All' || row.dataset.category === cat) row.style.display = 'flex';
                else row.style.display = 'none';
            });
        });
    }
    
    // ... (Keep existing stepper/submit logic) ...
    // Setup variables for listeners
    const container = document.querySelector('.modal-form-container');
    const totalEl = document.getElementById('manual-order-total');
    const submitBtn = document.getElementById('submit-manual-order');
    const nameInput = document.getElementById('manual-customer-name');
    const dueSelect = document.getElementById('manual-due-select');
    const dueTimeInput = document.getElementById('manual-due-time-input');
    const selections = {}; 

    // Due Time Toggle
    dueSelect.addEventListener('change', (e) => {
        if (e.target.value === 'other') {
            dueTimeInput.style.display = 'block';
            const now = new Date();
            dueTimeInput.value = now.toTimeString().substring(0,5);
        } else {
            dueTimeInput.style.display = 'none';
        }
    });

    const updateTotal = () => {
        let total = 0;
        let count = 0;
        // Iterate over sortedItems to ensure we catch everything
        sortedItems.forEach(item => {
            const qty = selections[item.id] || 0;
            if (qty > 0) {
                total += qty * parseFloat(item.price);
                count++;
            }
        });
        totalEl.textContent = total.toFixed(2);
        submitBtn.disabled = count === 0;
        submitBtn.textContent = count === 0 ? "Add Items to Order" : `Create Order ($${total.toFixed(2)})`;
    };

    container.addEventListener('click', (e) => {
        if (!e.target.classList.contains('stepper-btn')) return;
        const row = e.target.closest('.manual-order-row');
        const itemId = row.dataset.itemId;
        const action = e.target.dataset.action;
        let qty = selections[itemId] || 0;
        if (action === 'plus') qty++;
        if (action === 'minus') qty = Math.max(0, qty - 1);
        selections[itemId] = qty;

        const minusBtn = row.querySelector('.minus');
        const valSpan = row.querySelector('.stepper-val');
        valSpan.textContent = qty;
        
        if (qty > 0) {
            minusBtn.classList.remove('hidden');
            valSpan.classList.remove('hidden');
            row.style.backgroundColor = '#f0f8ff';
        } else {
            minusBtn.classList.add('hidden');
            valSpan.classList.add('hidden');
            row.style.backgroundColor = 'transparent';
        }
        updateTotal();
    });

    submitBtn.addEventListener('click', async () => {
        const items = [];
        let total = 0;
        sortedItems.forEach(item => {
            const qty = selections[item.id] || 0;
            if (qty > 0) {
                items.push({ id: item.id, price: parseFloat(item.price), quantity: qty });
                total += qty * parseFloat(item.price);
            }
        });

        let dueTimestamp = new Date();
        const dueOption = dueSelect.value;
        if (dueOption === 'other') {
            const [hours, minutes] = dueTimeInput.value.split(':');
            dueTimestamp.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        } else {
            dueTimestamp = new Date(dueTimestamp.getTime() + parseInt(dueOption) * 60000);
        }

        submitBtn.textContent = "Processing...";
        submitBtn.disabled = true;
        
        const success = await useAppStore.getState().orderHistory.createManualOrder({
            customerName: nameInput.value.trim() || "Phone Order",
            dueTime: dueTimestamp.toISOString(),
            items,
            total
        });

        if (success) {
            uiUtils.showToast("Order created!", "success");
            uiUtils.closeModal();
        } else {
            submitBtn.textContent = "Retry";
            submitBtn.disabled = false;
        }
    });
}


function renderCustomerOrderList(container, orders) {
    if (orders.length === 0) {
        container.innerHTML = `<div class="empty-state"><h2>No Past Orders</h2><p>You haven't placed any orders yet.</p><a href="#menu" class="button-primary">Browse Menu</a></div>`;
        return;
    }
    const ordersHTML = orders.map(order => `
        <div class="order-history-card" style="margin-bottom:15px; padding:15px; border:1px solid #eee; border-radius:8px;">
            <div class="order-card-header" style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:10px;">
                <div><h4 style="margin:0;">Order #${order.id.slice(0,4)}</h4><small style="color:#666;">${new Date(order.created_at).toLocaleDateString()}</small></div>
                <div style="text-align:right;"><span class="status-badge ${order.status}" style="font-weight:bold; color:var(--primary-color);">${order.status.toUpperCase()}</span><div style="font-weight:bold;">$${parseFloat(order.total_amount).toFixed(2)}</div></div>
            </div>
            <ul class="order-card-items" style="list-style:none; padding:0;">${(order.order_items||[]).map(i => `<li style="margin-bottom:5px;">${i.quantity} x ${i.menu_items?.name || 'Item'}</li>`).join('')}</ul>
        </div>
    `).join('');
    container.innerHTML = `<div class="dashboard-container"><h2>Your Order History</h2><div class="order-history-list">${ordersHTML}</div></div>`;
}

// Ensure timer logic is present
function startLiveTimers() {
    const update = () => {
        const now = new Date();
        document.querySelectorAll('.live-timer').forEach(el => {
            const dueStr = el.dataset.due;
            if (!dueStr) return;
            
            const due = new Date(dueStr);
            const diffMs = due - now;
            const diffMins = Math.ceil(diffMs / 60000); // Negative = Past, Positive = Future
            const absMins = Math.abs(diffMins);

            // 1. Update Colors
            el.classList.remove('overdue', 'due-soon', 'okay');
            if (diffMins < 0) el.classList.add('overdue');      // Late
            else if (diffMins <= 10) el.classList.add('due-soon'); // <10 mins left
            else el.classList.add('okay');                      // Plenty of time

            // 2. Format Text
            if (diffMins < 0) {
                // --- PAST (Overdue) ---
                if (absMins < 60) {
                    el.textContent = `${absMins}m ago`;
                } else if (absMins < 1440) { // Less than 24 hours
                    const hours = Math.floor(absMins / 60);
                    el.textContent = `${hours}h ago`;
                } else {
                    const days = Math.floor(absMins / 1440);
                    el.textContent = `${days}d ago`;
                }
            } else {
                // --- FUTURE (Due In) ---
                if (diffMins === 0) {
                    el.textContent = "Due Now";
                } else if (diffMins < 60) {
                    el.textContent = `${diffMins}m`;
                } else if (diffMins < 1440) {
                    const hours = Math.floor(diffMins / 60);
                    const mins = diffMins % 60;
                    el.textContent = `${hours}h ${mins}m`;
                } else {
                    const days = Math.floor(diffMins / 1440);
                    el.textContent = `In ${days}d`;
                }
            }
        });
    };

    update(); 
    // Clear previous interval if this function is called multiple times
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(update, 60000); 
}