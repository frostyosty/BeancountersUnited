// src/features/user/orderHistoryUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Renders the user's order history page.
 */
export async function renderOrderHistoryPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    mainContent.innerHTML = `<div class="loading-spinner">Loading your order history...</div>`;

    // Fetch the latest order history
    await useAppStore.getState().orderHistory.fetchOrderHistory();

    // Get the state after the fetch is complete
    const { orders, isLoading, error } = useAppStore.getState().orderHistory;
    
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Could not load history</h2><p>${error}</p></div>`;
        return;
    }

    if (orders.length === 0) {
        mainContent.innerHTML = `
            <div class="empty-state">
                <h2>No Past Orders Found</h2>
                <p>You haven't placed any orders with us yet.</p>
                <a href="#menu" class="button-link">Start Your First Order</a>
            </div>
        `;
        return;
    }

    const ordersHTML = orders.map(order => {
        // The items are nested inside the order object from our API query
        const itemsHTML = order.order_items.map(item => `
            <li>${item.quantity} x ${item.menu_items.name}</li>
        `).join('');

        return `
            <div class="order-history-card" data-order-id="${order.id}">
                <div class="order-card-header">
                    <h4>Order Placed: ${new Date(order.created_at).toLocaleString()}</h4>
                    <p>Total: $${parseFloat(order.total_amount).toFixed(2)}</p>
                </div>
                <ul class="order-card-items">
                    ${itemsHTML}
                </ul>
                <div class="order-card-actions">
                    <button class="button-primary re-order-btn" data-order-id="${order.id}">Re-order</button>
                </div>
            </div>
        `;
    }).join('');

    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>Your Order History</h2>
            <div class="order-history-list">
                ${ordersHTML}
            </div>
        </div>
    `;

    attachOrderHistoryListeners();
}

/**
 * Attaches event listeners for the order history page.
 */
function attachOrderHistoryListeners() {
    const listContainer = document.querySelector('.order-history-list');
    if (!listContainer) return;

    listContainer.addEventListener('click', (event) => {
        const reorderButton = event.target.closest('.re-order-btn');
        if (reorderButton) {
            const orderId = reorderButton.dataset.orderId;
            handleReorder(orderId);
        }
    });
}

/**
 * Handles the re-order logic.
 * @param {string} orderId - The ID of the order to re-add to the cart.
 */
function handleReorder(orderId) {
    const { orders } = useAppStore.getState().orderHistory;
    const { addItem } = useAppStore.getState().cart;
    const orderToReorder = orders.find(o => o.id === orderId);

    if (!orderToReorder) {
        uiUtils.showToast("Could not find that order.", "error");
        return;
    }

    if (!confirm("This will add all items from this past order to your current cart. Proceed?")) {
        return;
    }

    // Loop through the items from the past order and add them to the cart
    orderToReorder.order_items.forEach(item => {
        // The full menu item data is nested inside `menu_items`
        const menuItemData = item.menu_items;
        // We need to add it `quantity` times
        for (let i = 0; i < item.quantity; i++) {
            addItem(menuItemData);
        }
    });

    uiUtils.showToast("Items added to your cart!", "success");
    // Navigate the user to the cart to review their re-order
    window.location.hash = '#cart';
}