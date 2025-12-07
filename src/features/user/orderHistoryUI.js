// src/features/user/orderHistoryUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';

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
    .archive-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; color: #666; }
    .archive-table { width: 100%; border-collapse: collapse; opacity: 0.8; }
    .archive-table th { text-align: left; padding: 8px; border-bottom: 2px solid #ccc; font-size: 0.85rem; }
    .archive-table td { padding: 8px; border-bottom: 1px solid #ddd; font-size: 0.85rem; color: #555; }
    .archive-table tr:hover { background-color: #e9e9e9; opacity: 1; }
</style>
`;

export function renderOrderHistoryPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    useAppStore.getState().orderHistory.fetchOrderHistory();
    useAppStore.getState().menu.fetchMenu(); 

    const { orders, isLoading, error } = useAppStore.getState().orderHistory;
    const { getUserRole } = useAppStore.getState().auth;
    const role = getUserRole();

    if (isLoading) { mainContent.innerHTML = `<div class="loading-spinner">Loading orders...</div>`; return; }
    if (error) { mainContent.innerHTML = `<div class="error-message"><h3>Error</h3><p>${error}</p><button class="button-primary" onclick="location.reload()">Retry</button></div>`; return; }

    if (role === 'god' || role === 'owner') {
        renderAdminOrderViews(mainContent, orders || [], role);
    } else {
        renderCustomerOrderList(mainContent, orders || []);
    }
}

// --- ADMIN VIEW (Live + Archive) ---
function renderAdminOrderViews(container, orders, role) {
    // 1. Split Orders
    const liveOrders = orders.filter(o => o.status === 'pending' || o.status === 'preparing');
    // Archive = Everything else (Completed, Cancelled)
    const archivedOrders = orders.filter(o => o.status !== 'pending' && o.status !== 'preparing');
    
    // Sort
    liveOrders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); // Oldest first (urgent)
    archivedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // Newest first

    // 2. Live Table HTML
    const liveRows = liveOrders.map(order => createOrderRow(order, role, true)).join('');
    
    // 3. Archive Table HTML
    const archiveRows = archivedOrders.map(order => createOrderRow(order, role, false)).join('');

    container.innerHTML = `
        ${STEPPER_CSS}
        <div class="dashboard-container">
            
            <!-- LIVE ORDERS SECTION -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h2 style="color: var(--primary-color);">Live Orders</h2>
                <button id="btn-manual-order" class="button-secondary small" style="font-weight: 600;">+ Phone Order</button>
            </div>

            <div class="table-wrapper" style="margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <table class="admin-orders-table" style="width:100%; border-collapse:collapse;">
                    <thead style="background:var(--surface-color); border-bottom: 2px solid var(--primary-color);">
                        <tr>
                            <th style="padding:12px;">ID</th>
                            <th style="padding:12px;">Due / Time</th>
                            <th style="padding:12px;">Customer</th>
                            <th style="padding:12px;">Items</th>
                            <th style="padding:12px;">Total</th>
                            <th style="padding:12px;">Status</th>
                            <th style="padding:12px;">Action</th>
                        </tr>
                    </thead>
                    <tbody style="background:white;">
                        ${liveRows.length > 0 ? liveRows : '<tr><td colspan="7" style="text-align:center; padding:30px; color:#999;">No live orders. Good job!</td></tr>'}
                    </tbody>
                </table>
            </div>

            <!-- ARCHIVED ORDERS SECTION -->
            <div class="archive-section">
                <div class="archive-header">
                    <h3 style="margin:0;">Archived Orders (Log)</h3>
                    <button id="toggle-archive-btn" class="button-secondary small">Show/Hide</button>
                </div>
                
                <div id="archive-table-container" style="display:none;">
                    <input type="text" id="archive-search" placeholder="Search archive..." style="width:100%; padding:8px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px;">
                    
                    <div style="max-height: 400px; overflow-y: auto;">
                        <table class="archive-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>ID</th>
                                    <th>Customer</th>
                                    <th>Summary</th>
                                    <th>Total</th>
                                    <th>Status</th>
                                    ${role === 'god' ? '<th>Delete</th>' : ''}
                                </tr>
                            </thead>
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
    
    // Manual Order
    document.getElementById('btn-manual-order')?.addEventListener('click', showManualOrderModal);

    // Archive Toggle
    const archiveContainer = document.getElementById('archive-table-container');
    const toggleBtn = document.getElementById('toggle-archive-btn');
    if (toggleBtn) {
        toggleBtn.onclick = () => {
            const isHidden = archiveContainer.style.display === 'none';
            archiveContainer.style.display = isHidden ? 'block' : 'none';
            toggleBtn.textContent = isHidden ? 'Hide Archive' : 'Show Archive';
        };
    }

    // Archive Search
    const searchInput = document.getElementById('archive-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#archive-tbody tr');
            rows.forEach(row => {
                row.style.display = row.innerText.toLowerCase().includes(term) ? '' : 'none';
            });
        });
    }
    
    // Row Actions (Dismiss / Delete)
    container.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation(); // Stop row click
            const orderId = e.target.closest('tr').dataset.orderId;
            const action = e.target.dataset.action; // 'dismiss' or 'delete'

            if (action === 'dismiss') {
                if(confirm("Dismiss (Archive) this order?")) {
                    useAppStore.getState().orderHistory.dismissOrder(orderId);
                }
            } else if (action === 'delete') {
                if(confirm("PERMANENTLY DELETE this record? This cannot be undone.")) {
                    const { error } = await supabase.from('orders').delete().eq('id', orderId);
                    if (!error) {
                        uiUtils.showToast("Record deleted.", "success");
                        useAppStore.getState().orderHistory.fetchOrderHistory();
                    } else {
                        uiUtils.showToast("Delete failed.", "error");
                    }
                }
            }
        });
    });
}

// Helper to create HTML for rows
function createOrderRow(order, role, isLive) {
    const time = new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fullDate = new Date(order.created_at).toLocaleDateString() + ' ' + time;
    
    const customerName = order.customer_name || order.profiles?.full_name || order.profiles?.email || 'Guest';
    
    // Safe item mapping
    const itemsSummary = (order.order_items || []).map(i => 
        `${i.quantity}x ${i.menu_items?.name || 'Item'}`
    ).join(', ') || 'No items';

    const statusClass = `status-${order.status}`;
    const clickName = customerName.replace(/'/g, "\\'"); // Escape for JS

    if (isLive) {
        // LIVE ROW
        return `
            <tr class="${statusClass}" data-order-id="${order.id}" 
                style="cursor:pointer;" 
                onclick="window.handleOrderRowClick('${order.user_id}', '${clickName}')">
                
                <td>#${order.id.slice(0,4)}</td>
                <td>${time}</td>
                <td style="font-weight:600;">${customerName}</td>
                <td>${itemsSummary}</td>
                <td style="font-weight:bold;">$${parseFloat(order.total_amount).toFixed(2)}</td>
                <td><span class="badge ${statusClass}">${order.status.toUpperCase()}</span></td>
                <td><button class="delete-icon-btn action-btn" data-action="dismiss" title="Archive">×</button></td>
            </tr>
        `;
    } else {
        // ARCHIVE ROW
        const deleteBtn = role === 'god' 
            ? `<td><button class="delete-icon-btn action-btn" data-action="delete" title="Permanent Delete" style="color:#d00;">🗑</button></td>` 
            : '';

        return `
            <tr data-order-id="${order.id}" onclick="window.handleOrderRowClick('${order.user_id}', '${clickName}')" style="cursor:pointer;">
                <td>${fullDate}</td>
                <td>#${order.id.slice(0,4)}</td>
                <td>${customerName}</td>
                <td style="max-width:300px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${itemsSummary}</td>
                <td>$${parseFloat(order.total_amount).toFixed(2)}</td>
                <td>${order.status}</td>
                ${role === 'god' ? deleteBtn : ''}
            </tr>
        `;
    }
}
// --- CUSTOMER VIEW: Card List ---
function renderCustomerOrderList(container, orders) {
    if (orders.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h2>No Past Orders</h2>
                <p>You haven't placed any orders yet.</p>
                <a href="#menu" class="button-primary">Browse Menu</a>
            </div>`;
        return;
    }

    const ordersHTML = orders.map(order => {
        const date = new Date(order.created_at).toLocaleDateString();
        const items = order.order_items || [];
        
        return `
        <div class="order-history-card" style="margin-bottom:15px; padding:15px; border:1px solid #eee; border-radius:8px;">
            <div class="order-card-header" style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:10px;">
                <div>
                    <h4 style="margin:0;">Order #${order.id.slice(0,4)}</h4>
                    <small style="color:#666;">${date}</small>
                </div>
                <div style="text-align:right;">
                    <span class="status-badge ${order.status}" style="font-weight:bold; color:var(--primary-color);">${order.status.toUpperCase()}</span>
                    <div style="font-weight:bold;">$${parseFloat(order.total_amount).toFixed(2)}</div>
                </div>
            </div>
            <ul class="order-card-items" style="list-style:none; padding:0;">
                ${items.map(i => `<li style="margin-bottom:5px;">${i.quantity} x ${i.menu_items?.name || 'Item'}</li>`).join('')}
            </ul>
        </div>
    `;
    }).join('');

    container.innerHTML = `
        <div class="dashboard-container">
            <h2>Your Order History</h2>
            <div class="order-history-list">${ordersHTML}</div>
        </div>
    `;
}

// --- MANUAL ORDER MODAL (Copied from your snippet) ---
function showManualOrderModal() {
    const { items: menuItems } = useAppStore.getState().menu;
    
    const itemRows = menuItems.map(item => `
        <div class="manual-order-row" data-item-id="${item.id}" data-price="${item.price}" style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid #eee;">
            <div style="flex:2; font-weight:500;">${item.name} <span style="color:#666; font-size:0.9rem; font-weight:normal;">($${parseFloat(item.price).toFixed(2)})</span></div>
            <div style="flex:1;">
                <div class="stepper-container">
                    <button class="stepper-btn minus hidden" data-action="minus">-</button>
                    <span class="stepper-val hidden">0</span>
                    <button class="stepper-btn plus" data-action="plus">+</button>
                </div>
            </div>
        </div>
    `).join('');

    const modalHTML = `
        <style>
            .stepper-container { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
            .stepper-btn { width: 32px; height: 32px; border-radius: 50%; border: none; background-color: #eee; color: #333; font-weight: bold; font-size: 1.2rem; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; transition: background 0.2s; }
            .stepper-btn:active { background-color: #ddd; transform: scale(0.95); }
            .stepper-btn.plus { background-color: var(--primary-color); color: white; }
            .stepper-val { font-weight: 600; min-width: 20px; text-align: center; }
            .hidden { display: none !important; }
        </style>
        <div class="modal-form-container">
            <h3>Create Phone Order</h3>
            
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

            <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px; border: 1px solid #ddd; padding: 10px; border-radius: 6px; background:#fff;">
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

    const container = document.querySelector('.modal-form-container');
    const totalEl = document.getElementById('manual-order-total');
    const submitBtn = document.getElementById('submit-manual-order');
    const nameInput = document.getElementById('manual-customer-name');
    const dueSelect = document.getElementById('manual-due-select');
    const dueTimeInput = document.getElementById('manual-due-time-input');
    const selections = {}; 

    // --- Due Time Logic ---
    dueSelect.addEventListener('change', (e) => {
        if (e.target.value === 'other') {
            dueTimeInput.style.display = 'block';
            // Set default to now in HH:MM format
            const now = new Date();
            const timeString = now.toTimeString().substring(0,5);
            dueTimeInput.value = timeString;
        } else {
            dueTimeInput.style.display = 'none';
        }
    });

    // --- Stepper Logic ---
    const updateTotal = () => {
        let total = 0;
        let count = 0;
        menuItems.forEach(item => {
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

    // --- Submit Logic ---
    submitBtn.addEventListener('click', async () => {
        const items = [];
        let total = 0;
        
        menuItems.forEach(item => {
            const qty = selections[item.id] || 0;
            if (qty > 0) {
                items.push({ id: item.id, price: parseFloat(item.price), quantity: qty });
                total += qty * parseFloat(item.price);
            }
        });

        // Calculate Due Time
        let dueTimestamp = new Date();
        const dueOption = dueSelect.value;
        
        if (dueOption === 'other') {
            // Parse HH:MM from input and set it on today's date
            const [hours, minutes] = dueTimeInput.value.split(':');
            dueTimestamp.setHours(parseInt(hours), parseInt(minutes), 0, 0);
            // If time is in the past (e.g. entered 1AM at 9PM), assume tomorrow? 
            // For simplicity, let's assume today.
        } else {
            // Add minutes
            dueTimestamp = new Date(dueTimestamp.getTime() + parseInt(dueOption) * 60000);
        }

        submitBtn.textContent = "Processing...";
        submitBtn.disabled = true;
        
        const success = await useAppStore.getState().orderHistory.createManualOrder({
            customerName: nameInput.value.trim() || "Phone Order",
            dueTime: dueTimestamp.toISOString(), // Pass ISO string
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