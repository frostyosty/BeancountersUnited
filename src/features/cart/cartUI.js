// src/features/cart/cartUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Renders the shopping cart page into the main content area.
 */
export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Get cart state and selectors from the Zustand store
    const { items, getCartTotal } = useAppStore.getState();

    let contentHTML = '<h2>Your Cart</h2>';

    if (items.length === 0) {
        contentHTML += `
            <div class="empty-state">
                <p>Your cart is empty.</p>
                <a href="#menu" class="button-link">Browse the Menu</a>
            </div>
        `;
    } else {
        const cartItemsHTML = items.map(item => `
            <div class="cart-item" data-item-id="${item.id}">
                <img src="${item.image_url || '/placeholder-pizza.jpg'}" alt="${item.name}" class="cart-item-image">
                <div class="cart-item-details">
                    <h4 class="cart-item-name">${item.name}</h4>
                    <p class="cart-item-price">$${item.price.toFixed(2)}</e>
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

        contentHTML += `
            <div class="cart-items-container">${cartItemsHTML}</div>
            <div class="cart-summary">
                <p class="cart-total">Total: <strong>$${getCartTotal().toFixed(2)}</strong></p>
                <button id="checkout-btn" class="button-primary">Proceed to Checkout</button>
            </div>
        `;
    }

    mainContent.innerHTML = contentHTML;
    attachCartEventListeners(); // Attach listeners for the newly rendered elements
}

/**
 * Attaches event listeners for the interactive elements on the cart page.
 */
function attachCartEventListeners() {
    const cartContainer = document.querySelector('.cart-items-container');
    if (!cartContainer) return;

    cartContainer.addEventListener('click', (event) => {
        const target = event.target;
        const itemId = target.dataset.itemId;
        if (!itemId) return;

        const { updateItemQuantity, removeItem } = useAppStore.getState();
        const currentItem = useAppStore.getState().items.find(i => i.id === itemId);
        if (!currentItem) return;

        if (target.matches('.increase-qty')) {
            updateItemQuantity(itemId, currentItem.quantity + 1);
        } else if (target.matches('.decrease-qty')) {
            updateItemQuantity(itemId, currentItem.quantity - 1);
        } else if (target.matches('.remove-item-btn')) {
            if (confirm(`Remove ${currentItem.name} from your cart?`)) {
                removeItem(itemId);
            }
        }
    });

    // Handle direct input in the quantity field
    cartContainer.addEventListener('change', (event) => {
        const target = event.target;
        if (target.matches('.quantity-input')) {
            const itemId = target.dataset.itemId;
            const newQuantity = parseInt(target.value, 10);
            if (!isNaN(newQuantity)) {
                useAppStore.getState().updateItemQuantity(itemId, newQuantity);
            }
        }
    });

    const checkoutBtn = document.getElementById('checkout-btn');
if (checkoutBtn) {
        checkoutBtn.addEventListener('click', () => {
            // Instead of logging, we now change the URL hash to navigate.
            // Our router in main.js will detect this change and render the checkout page.
            window.location.hash = '#checkout';
        });
    }
}


/**
 * Renders the checkout page into the main content area.
 */
export function renderCheckoutPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { getCartTotal, isAuthenticated, user } = useAppStore.getState();
    const total = getCartTotal();

    // Rule: Require login for orders over $10
    if (total > 10 && !isAuthenticated) {
        mainContent.innerHTML = `
            <div class="notice-message">
                <h2>Login Required</h2>
                <p>Your order total is over $10.00. Please log in or sign up to continue.</p>
                <p><em>(We'll bring you right back here after you log in!)</em></p>
            </div>
        `;
        // In a real app, you would pop the login modal here.
        // For now, this message guides the user. The nav bar still has the login button.
        return;
    }

    // Set a minimum pickup time (e.g., 20 minutes from now)
    const minPickupDateTime = new Date(Date.now() + 20 * 60000);
    const formattedMinPickup = `${minPickupDateTime.getFullYear()}-${String(minPickupDateTime.getMonth() + 1).padStart(2, '0')}-${String(minPickupDateTime.getDate()).padStart(2, '0')}T${String(minPickupDateTime.getHours()).padStart(2, '0')}:${String(minPickupDateTime.getMinutes()).padStart(2, '0')}`;

    const contentHTML = `
        <div class="checkout-container">
            <h2>Checkout</h2>
            <div class="order-summary">
                <h3>Your Order</h3>
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
    mainContent.innerHTML = contentHTML;
    document.getElementById('checkout-form').addEventListener('submit', handleCheckoutSubmit);
}


/**
 * Handles the submission of the checkout form.
 * @param {Event} event
 */
async function handleCheckoutSubmit(event) {
    event.preventDefault();
    const submitBtn = document.getElementById('submit-order-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Placing Order...';

    const formData = new FormData(event.target);
    const customerDetails = {
        name: formData.get('name'),
        email: formData.get('email'),
        phone: formData.get('phone'),
        pickupTime: formData.get('pickupTime'),
        specialRequests: formData.get('specialRequests'),
    };

    const success = await useAppStore.getState().submitOrder(customerDetails);

    if (success) {
        // Navigate to the confirmation page
        window.location.hash = '#order-confirmation';
    } else {
        // Show an error message
        const submitError = useAppStore.getState().error;
        alert(`There was an issue placing your order: ${submitError || 'Please try again.'}`);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Place Order';
    }
}