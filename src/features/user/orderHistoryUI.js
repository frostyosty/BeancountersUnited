import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

export function renderOrderHistoryPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 1. Trigger Fetch (Store handles loop prevention)
    useAppStore.getState().orderHistory.fetchOrderHistory();

    // 2. Get Data & Role
    const { orders, isLoading, error } = useAppStore.getState().orderHistory;
    const { getUserRole } = useAppStore.getState().auth;
    const role = getUserRole();

    // 3. Render Loading
    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading orders...</div>`;
        return;
    }

    // 4. Render Error
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h3>Error</h3><p>${error}</p></div>`;
        return;
    }

    // 5. Branch Render Logic
    if (role === 'manager' || role === 'owner') {
        renderAdminOrderTable(mainContent, orders);
    } else {
        renderCustomerOrderList(mainContent, orders);
    }
}

// --- ADMIN VIEW (Table + Manual Order Button) ---
function renderAdminOrderTable(container, orders) {
    // Sort by date (newest first)
    const sortedOrders = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const rows = sortedOrders.map(order => {
        const date = new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Handle different data structures (some might be null if manual)
        const customerName = order.profiles?.full_name || order.profiles?.email || 'Walk-in / Guest';
        const itemsSummary = order.order_items ? order.order_items.map(i => `${i.quantity}x ${i.menu_items?.name || 'Item'}`).join(', ') : 'Manual Order';
        
        let statusClass = 'status-pending';
        if (order.status === 'completed') statusClass = 'status-completed';
        if (order.status === 'cancelled') statusClass = 'status-cancelled';

        return `
            <tr class="${statusClass}">
                <td>#${order.id.slice(0,6)}</td>
                <td>${date}</td>
                <td>${customerName}</td>
                <td>${itemsSummary}</td>
                <td>$${parseFloat(order.total_amount).toFixed(2)}</td>
                <td><span class="badge ${statusClass}">${order.status.toUpperCase()}</span></td>
                <td><button class="button-secondary small">Details</button></td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="dashboard-container">
            <h2>Incoming Orders (Live)</h2>
            
            <div style="margin-bottom: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; border: 1px solid #eee;">
                <button id="btn-manual-order" class="button-secondary" style="font-weight: 600;">
                    + Add Walk-in / Phone Order
                </button>
                <span style="margin-left: 10px; font-size: 0.9rem; color: #666;">(Adds a random order for testing/demo)</span>
            </div>

            <div class="table-wrapper">
                <table class="admin-orders-table">
                    <thead>
                        <tr><th>ID</th><th>Time</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Action</th></tr>
                    </thead>
                    <tbody>${rows.length > 0 ? rows : '<tr><td colspan="7" style="text-align:center; padding:20px;">No orders yet.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;

    // Attach listener for the manual order button
    document.getElementById('btn-manual-order')?.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = "Creating...";
        
        const success = await useAppStore.getState().orderHistory.createManualOrder();
        
        if(success) uiUtils.showToast('Walk-in order created', 'success');
        
        // Button resets automatically when re-render happens via store update
        // But if it failed:
        if (!success) {
             btn.disabled = false;
             btn.textContent = "+ Add Walk-in / Phone Order";
        }
    });
}

// --- CUSTOMER VIEW (Cards) ---
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
        const itemsHTML = order.order_items.map(item => `
            <li>${item.quantity} x ${item.menu_items?.name || 'Unknown Item'}</li>
        `).join('');

        return `
            <div class="order-history-card" data-order-id="${order.id}">
                <div class="order-card-header">
                    <h4>${new Date(order.created_at).toLocaleDateString()}</h4>
                    <span class="status-badge ${order.status}">${order.status}</span>
                </div>
                <ul class="order-card-items">${itemsHTML}</ul>
                <div class="order-card-footer">
                    <strong>Total: $${parseFloat(order.total_amount).toFixed(2)}</strong>
                    <button class="button-primary re-order-btn" data-order-id="${order.id}">Re-order</button>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="dashboard-container">
            <h2>Your Order History</h2>
            <div class="order-history-list">${ordersHTML}</div>
        </div>
    `;

    attachCustomerListeners(container);
}

function attachCustomerListeners(container) {
    if (container.dataset.listenersAttached === 'true') return;
    container.addEventListener('click', (event) => {
        if (event.target.matches('.re-order-btn')) {
            handleReorder(event.target.dataset.orderId);
        }
    });
    container.dataset.listenersAttached = 'true';
}

function handleReorder(orderId) {
    const { orders } = useAppStore.getState().orderHistory;
    const { addItem } = useAppStore.getState().cart;
    const order = orders.find(o => o.id === orderId);

    if (!order || !confirm("Add these items to your cart?")) return;

    order.order_items.forEach(item => {
        if(item.menu_items) {
            for (let i = 0; i < item.quantity; i++) addItem(item.menu_items);
        }
    });
    uiUtils.showToast("Items added to cart!", "success");
    window.location.hash = '#cart';
}