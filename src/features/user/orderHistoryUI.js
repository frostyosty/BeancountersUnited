// src/features/user/orderHistoryUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

// --- CSS for Stepper (Injected for simplicity, or move to style.css) ---
const STEPPER_CSS = `
<style>
    .stepper-container { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .stepper-btn {
        width: 32px; height: 32px; border-radius: 50%; border: none;
        background-color: #eee; color: #333; font-weight: bold; font-size: 1.2rem;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        line-height: 1; transition: background 0.2s;
    }
    .stepper-btn:active { background-color: #ddd; transform: scale(0.95); }
    .stepper-btn.plus { background-color: var(--primary-color); color: white; }
    .stepper-val { font-weight: 600; min-width: 20px; text-align: center; }
    .hidden { display: none !important; }
</style>
`;

export function renderOrderHistoryPage() {
    console.log("%c[OrderHistoryUI] render CALLED", "color: pink");
    
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 1. Safe State Access
    const store = useAppStore.getState();
    if (!store.orderHistory) {
        console.error("[OrderHistoryUI] Slice missing!");
        return;
    }

    const { orders, isLoading, error } = store.orderHistory;
    console.log("[OrderHistoryUI] State:", { count: orders?.length, isLoading, error });

    // 2. Loading State
    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading your orders...</div>`;
        return;
    }

    // 3. Error State
    if (error) {
        mainContent.innerHTML = `
            <div class="error-message">
                <h2>Error</h2>
                <p>${error}</p>
                <button class="button-primary" onclick="location.reload()">Retry</button>
            </div>`;
        return;
    }

    // 4. Empty State
    if (!orders || orders.length === 0) {
        mainContent.innerHTML = `
            <div class="empty-state">
                <h2>No Past Orders</h2>
                <p>You haven't ordered anything yet.</p>
                <a href="#menu" class="button-primary">Browse Menu</a>
            </div>`;
        return;
    }

    // 5. Render Orders
    try {
        const ordersHTML = orders.map(order => {
            const date = new Date(order.created_at).toLocaleDateString() + ' ' + new Date(order.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Handle missing order_items safely
            const items = order.order_items || [];
            const itemsList = items.map(i => `
                <li style="display:flex; justify-content:space-between; border-bottom:1px dashed #eee; padding:5px 0;">
                    <span>${i.quantity}x ${i.menu_items?.name || 'Unknown Item'}</span>
                    <span>$${(i.price_at_time * i.quantity).toFixed(2)}</span>
                </li>
            `).join('');

            return `
                <div class="order-history-card" style="margin-bottom: 20px;">
                    <div class="order-card-header">
                        <div>
                            <h4>Order #${order.id.slice(0, 4)}</h4>
                            <small style="color:#666;">${date}</small>
                        </div>
                        <div style="text-align:right;">
                            <span class="status-badge ${order.status}" style="display:inline-block; padding:4px 8px; background:#eee; border-radius:4px; font-size:0.8rem;">${order.status.toUpperCase()}</span>
                            <div style="font-weight:bold; margin-top:5px;">$${order.total_amount.toFixed(2)}</div>
                        </div>
                    </div>
                    <ul class="order-card-items" style="list-style:none; padding:0; margin:10px 0;">
                        ${itemsList}
                    </ul>
                </div>
            `;
        }).join('');

        mainContent.innerHTML = `
            <h2>Order History</h2>
            <div class="order-history-list">
                ${ordersHTML}
            </div>
        `;
    } catch (e) {
        console.error("[OrderHistoryUI] Render Crash:", e);
        mainContent.innerHTML = `<div class="error-message">Error displaying orders.</div>`;
    }
}

function renderAdminOrderTable(container, orders) {
    const sortedOrders = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const rows = sortedOrders.map(order => {
        const date = new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const customerName = order.profiles?.full_name || order.profiles?.email || 'Guest / Walk-in';
        
        const itemsSummary = order.order_items && order.order_items.length > 0 
            ? order.order_items.map(i => `${i.quantity}x ${i.menu_items?.name || 'Item'}`).join(', ') 
            : '<span style="color:#999; font-style:italic">No items data</span>';
        
        let statusClass = 'status-pending';
        if (order.status === 'completed') statusClass = 'status-completed';
        if (order.status === 'cancelled') statusClass = 'status-cancelled';

        return `
            <tr class="${statusClass}" data-order-id="${order.id}">
                <td>#${order.id.slice(0,6)}</td>
                <td>${date}</td>
                <td>${customerName}</td>
                <td style="max-width: 300px;">${itemsSummary}</td>
                <td>$${parseFloat(order.total_amount).toFixed(2)}</td>
                <td><span class="badge ${statusClass}">${order.status.toUpperCase()}</span></td>
                <td><button class="delete-icon-btn dismiss-order-btn" title="Dismiss/Archive">×</button></td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="dashboard-container">
            <h2>Incoming Orders (Live)</h2>
            <div style="margin-bottom: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; border: 1px solid #eee;">
                <button id="btn-manual-order" class="button-secondary" style="font-weight: 600;">+ New Walk-in Order</button>
            </div>
            <div class="table-wrapper">
                <table class="admin-orders-table">
                    <thead>
                        <tr><th>ID</th><th>Time</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Dismiss</th></tr>
                    </thead>
                    <tbody>${rows.length > 0 ? rows : '<tr><td colspan="7" style="text-align:center; padding:20px;">No active orders.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;

    document.getElementById('btn-manual-order')?.addEventListener('click', showManualOrderModal);
    
    container.querySelectorAll('.dismiss-order-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const orderId = e.target.closest('tr').dataset.orderId;
            if(confirm("Dismiss this order?")) useAppStore.getState().orderHistory.dismissOrder(orderId);
        });
    });
}

function showManualOrderModal() {
    const { items: menuItems } = useAppStore.getState().menu;
    
    const itemRows = menuItems.map(item => `
        <div class="manual-order-row" data-item-id="${item.id}" data-price="${item.price}" style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid #eee;">
            <div style="flex:2; font-weight:500;">${item.name} <span style="color:#666; font-size:0.9rem; font-weight:normal;">($${item.price})</span></div>
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
        ${STEPPER_CSS}
        <div class="modal-form-container">
            <h3>Create Walk-in Order</h3>
            <div style="max-height: 400px; overflow-y: auto; margin-bottom: 15px; border: 1px solid #ddd; padding: 10px; border-radius: 6px; background:#fff;">
                ${itemRows}
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-top:10px; border-top:2px solid #eee;">
                <span style="font-size:1.1rem;">Total Amount:</span>
                <span style="font-size:1.5rem; font-weight:bold;">$<span id="manual-order-total">0.00</span></span>
            </div>
            <div class="form-actions">
                <button id="submit-manual-order" class="button-primary" style="width:100%; padding:12px;" disabled>Create Order</button>
            </div>
        </div>
    `;
    
    uiUtils.showModal(modalHTML);

    const container = document.querySelector('.modal-form-container');
    const totalEl = document.getElementById('manual-order-total');
    const submitBtn = document.getElementById('submit-manual-order');
    const selections = {}; // { itemId: quantity }

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
        
        // Update submit button text for feedback
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

        // Update UI elements
        const minusBtn = row.querySelector('.minus');
        const valSpan = row.querySelector('.stepper-val');
        
        valSpan.textContent = qty;
        
        if (qty > 0) {
            minusBtn.classList.remove('hidden');
            valSpan.classList.remove('hidden');
            row.style.backgroundColor = '#f0f8ff'; // Light highlight
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
                items.push({
                    id: item.id,
                    price: parseFloat(item.price),
                    quantity: qty
                });
                total += qty * parseFloat(item.price);
            }
        });

        submitBtn.textContent = "Processing...";
        submitBtn.disabled = true;
        
        const success = await useAppStore.getState().orderHistory.createManualOrder({
            customerName: "Walk-in",
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
        <div class="order-history-card">
            <div class="order-card-header"><h4>${new Date(order.created_at).toLocaleDateString()}</h4><span class="status-badge ${order.status}">${order.status}</span></div>
            <ul class="order-card-items">${order.order_items.map(i => `<li>${i.quantity} x ${i.menu_items?.name}</li>`).join('')}</ul>
            <div class="order-card-footer"><strong>Total: $${parseFloat(order.total_amount).toFixed(2)}</strong></div>
        </div>
    `).join('');
    container.innerHTML = `<div class="dashboard-container"><h2>Your Order History</h2><div class="order-history-list">${ordersHTML}</div></div>`;
}