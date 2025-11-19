import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

export function renderOrderHistoryPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    useAppStore.getState().orderHistory.fetchOrderHistory();
    useAppStore.getState().menu.fetchMenu(); // Ensure menu is loaded for manual orders

    const { orders, isLoading, error } = useAppStore.getState().orderHistory;
    const { getUserRole } = useAppStore.getState().auth;
    const role = getUserRole();

    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading orders...</div>`;
        return;
    }

    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h3>Error</h3><p>${error}</p></div>`;
        return;
    }

    if (role === 'manager' || role === 'owner') {
        renderAdminOrderTable(mainContent, orders);
    } else {
        renderCustomerOrderList(mainContent, orders);
    }
}

function renderAdminOrderTable(container, orders) {
    const sortedOrders = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const rows = sortedOrders.map(order => {
        const date = new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const customerName = order.profiles?.full_name || order.profiles?.email || 'Guest / Walk-in';
        
        // Handle empty/manual items gracefully
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
                <td>
                    <button class="delete-icon-btn dismiss-order-btn" title="Dismiss/Archive (Stops Alarm)">×</button>
                </td>
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

    // Attach Listeners
    document.getElementById('btn-manual-order')?.addEventListener('click', showManualOrderModal);
    
    container.querySelectorAll('.dismiss-order-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const orderId = e.target.closest('tr').dataset.orderId;
            if(confirm("Dismiss this order? It will be marked as cancelled and removed from alarms.")) {
                useAppStore.getState().orderHistory.dismissOrder(orderId);
            }
        });
    });
}


// --- MANUAL ORDER MODAL ---
function showManualOrderModal() {
    const { items: menuItems } = useAppStore.getState().menu;
    
    // Generate item rows for selection
    const itemRows = menuItems.map(item => `
        <div class="manual-order-row" style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #eee;">
            <div style="flex:2;">${item.name} ($${item.price})</div>
            <div style="flex:1; text-align:right;">
                <input type="number" min="0" class="manual-qty-input" data-id="${item.id}" data-price="${item.price}" value="0" style="width:50px; padding:5px;">
            </div>
        </div>
    `).join('');

    const modalHTML = `
        <div class="modal-form-container">
            <h3>Create Walk-in Order</h3>
            <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px; border: 1px solid #ddd; padding: 10px; border-radius: 4px;">
                ${itemRows}
            </div>
            <div style="text-align:right; font-weight:bold; font-size:1.2rem; margin-bottom:15px;">
                Total: $<span id="manual-order-total">0.00</span>
            </div>
            <div class="form-actions">
                <button id="submit-manual-order" class="button-primary" disabled>Create Order</button>
            </div>
        </div>
    `;
    
    uiUtils.showModal(modalHTML);

    // Logic for Modal
    const inputs = document.querySelectorAll('.manual-qty-input');
    const totalEl = document.getElementById('manual-order-total');
    const submitBtn = document.getElementById('submit-manual-order');

    const updateTotal = () => {
        let total = 0;
        let hasItems = false;
        inputs.forEach(input => {
            const qty = parseInt(input.value) || 0;
            if (qty > 0) hasItems = true;
            total += qty * parseFloat(input.dataset.price);
        });
        totalEl.textContent = total.toFixed(2);
        submitBtn.disabled = !hasItems;
    };

    inputs.forEach(input => input.addEventListener('input', updateTotal));

    submitBtn.addEventListener('click', async () => {
        const items = [];
        let total = 0;
        inputs.forEach(input => {
            const qty = parseInt(input.value) || 0;
            if (qty > 0) {
                items.push({
                    id: input.dataset.id,
                    price: parseFloat(input.dataset.price),
                    quantity: qty
                });
                total += qty * parseFloat(input.dataset.price);
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
            submitBtn.textContent = "Create Order";
            submitBtn.disabled = false;
        }
    });
}

function renderCustomerOrderList(container, orders) {
    // ... (Same as before, no changes needed here) ...
    if (orders.length === 0) {
        container.innerHTML = `
            <div class="empty-state"><h2>No Past Orders</h2><p>You haven't placed any orders yet.</p><a href="#menu" class="button-primary">Browse Menu</a></div>`;
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