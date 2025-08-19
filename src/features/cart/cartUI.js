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
            // Later this will navigate to a #checkout hash
            console.log('TODO: Navigate to checkout page');
            alert('Checkout feature coming soon!');
        });
    }
}