// src/features/cart/cartUI.js
import { useAppStore } from '@/store/appStore.js';

/**
 * Renders the shopping cart page into the main content area.
 */


export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { cartItems, getCartTotal } = useAppStore.getState();

    if (cartItems.length === 0) {
        mainContent.innerHTML = `
            <div class="empty-state">
                <h2>Your Cart is Empty</h2>
                <a href="#menu" class="button-link">Continue Shopping</a>
            </div>
        `;
        return;
    }

    const cartItemsHTML = cartItems.map(item => `
        <div class="cart-item" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-pizza.jpg'}" alt="${item.name}" class="cart-item-image">
            <div class="cart-item-details">
                <h4 class="cart-item-name">${item.name}</h4>
                <p class="cart-item-price">$${parseFloat(item.price).toFixed(2)}</p>
            </div>
            <div class="cart-item-actions">
                <div class="quantity-selector">
                    <button class="quantity-btn decrease-qty" data-item-id="${item.id}">-</button>
                    <input type="number" class="quantity-input" value="${item.quantity}" min="0" data-item-id="${item.id}">
                    <button class="quantity-btn increase-qty" data-item-id="${item.id}">+</button>
                </div>
                <p class="cart-item-subtotal">$${(item.price * item.quantity).toFixed(2)}</p>
                <button class="remove-item-btn" data-item-id="${item.id}" title="Remove item">&times;</button>
            </div>
        </div>
    `).join('');

    mainContent.innerHTML = `
        <h2>Your Cart</h2>
        <div class="cart-items-container">${cartItemsHTML}</div>
        <div class="cart-summary">
            <p class="cart-total">Total: <strong>$${getCartTotal().toFixed(2)}</strong></p>
            <a href="#checkout" class="button-primary">Proceed to Checkout</a>
        </div>
    `;
    attachCartEventListeners();
}

/**
 * Attaches event listeners for the interactive elements on the cart page.
 */
function attachCartEventListeners() {
    const cartContainer = document.querySelector('.cart-items-container');
    if (!cartContainer) return;

    const { updateItemQuantity, removeItem } = useAppStore.getState();

    // Use a single event listener with delegation for performance
    cartContainer.addEventListener('click', (event) => {
        const target = event.target;
        const itemId = target.closest('[data-item-id]')?.dataset.itemId;
        if (!itemId) return;

        const currentItem = useAppStore.getState().cartItems.find(i => i.id === itemId);
        if (!currentItem) return;

        if (target.matches('.increase-qty')) {
            updateItemQuantity(itemId, currentItem.quantity + 1);
        } else if (target.matches('.decrease-qty')) {
            updateItemQuantity(itemId, currentItem.quantity - 1);
        } else if (target.matches('.remove-item-btn')) {
            removeItem(itemId);
        }
    });

    cartContainer.addEventListener('change', (event) => {
        const target = event.target;
        if (target.matches('.quantity-input')) {
            const itemId = target.dataset.itemId;
            const newQuantity = parseInt(target.value, 10);
            if (!isNaN(newQuantity)) {
                updateItemQuantity(itemId, newQuantity);
            }
        }
    });
}


/**
 * Renders the checkout page into the main content area.
 */
export function renderCheckoutPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { getCartTotal } = useAppStore.getState().cart;
    const { isAuthenticated } = useAppStore.getState().auth;
    const total = getCartTotal();

    // Rule: Require login for orders over $10
    if (total > 10 && !isAuthenticated) {
        mainContent.innerHTML = `
            <div class="notice-message">
                <h2>Login Required</h2>
                <p>Your order total is over $10.00. Please log in or sign up to continue.</p>
                <p><em>(We'll bring you right back to this page after you log in!)</em></p>
            </div>
        `;
        // The "Login / Sign Up" button is always visible in the header.
        return;
    }

    const { user } = useAppStore.getState().auth;
    const minPickupDateTime = new Date(Date.now() + 20 * 60000);
    const formattedMinPickup = `${minPickupDateTime.getFullYear()}-${String(minPickupDateTime.getMonth() + 1).padStart(2, '0')}-${String(minPickupDateTime.getDate()).padStart(2, '0')}T${String(minPickupDateTime.getHours()).padStart(2, '0')}:${String(minPickupDateTime.getMinutes()).padStart(2, '0')}`;

    mainContent.innerHTML = `
        <div class="checkout-container">
            <h2>Checkout</h2>
            <div class="order-summary">
                <h3>Your Order Summary</h3>
                <p>Total: <strong>$${total.toFixed(2)}</strong></p>
            </div>
            <form id="checkout-form">
                <h3>Your Details</h3>
                <div class="form-group">
                    <label for="checkout-name">Full Name</label>
                    <input type="text" id="checkout-name" name="name" required value="${user?.email || ''}">
                </div>
                <div class="form-group">
                    <label for="checkout-email">Email Address</label>
                    <input type="email" id="checkout-email" name="email" required value="${user?.email || ''}">
                </div>
                <div class="form-group">
                    <label for="checkout-phone">Phone Number (Optional)</label>
                    <input type="tel" id="checkout-phone" name="phone" placeholder="In case we need to contact you">
                </div>
                <h3>Pickup Details</h3>
                <div class="form-group">
                    <label for="checkout-pickup-time">Pickup Time</label>
                    <input type="datetime-local" id="checkout-pickup-time" name="pickupTime" required min="${formattedMinPickup}">
                </div>
                <div class="form-group">
                    <label for="checkout-requests">Special Requests</label>
                    <textarea id="checkout-requests" name="specialRequests" rows="3"></textarea>
                </div>
                <div id="payment-placeholder">
                    <p><strong>Payment:</strong> For this demo, payment is collected upon pickup.</p>
                </div>
                <button type="submit" id="submit-order-btn" class="button-primary">Place Order</button>
            </form>
        </div>
    `;
    document.getElementById('checkout-form').addEventListener('submit', handleCheckoutSubmit);
}

/**
 * Handles the submission of the checkout form.
 */
async function handleCheckoutSubmit(event) {
    event.preventDefault();
    const submitBtn = document.getElementById('submit-order-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Placing Order...';

    const formData = new FormData(event.target);
    const customerDetails = Object.fromEntries(formData.entries());

    const success = await useAppStore.getState().checkout.submitOrder(customerDetails);

    if (success) {
        // Navigate to the confirmation page
        window.location.hash = '#order-confirmation';
    } else {
        const submitError = useAppStore.getState().checkout.checkoutError;
        alert(`There was an issue placing your order: ${submitError || 'Please try again.'}`);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Place Order';
    }
}