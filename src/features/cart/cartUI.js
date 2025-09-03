// src/features/cart/cartUI.js
import { useAppStore } from '@/store/appStore.js';

/**
 * Renders the shopping cart page into the main content area.
 */

export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Correctly read from the 'cart' namespace
    const { items, getCartTotal } = useAppStore.getState().cart;

    if (items.length === 0) {
        mainContent.innerHTML = `<div class="empty-state">Your cart is empty.</div>`;
        return;
    }
    const cartTotal = getCartTotal();
    mainContent.innerHTML = `<h2>Cart Total: $${cartTotal.toFixed(2)}</h2>`;
}



// export function renderCartPage() {
//     const mainContent = document.getElementById('main-content');
//     if (!mainContent) return;

//     const { cartItems, getCartTotal } = useAppStore.getState();

//     if (cartItems.length === 0) {
//         mainContent.innerHTML = `
//             <div class="empty-state">
//                 <h2>Your Cart is Empty</h2>
//                 <a href="#menu" class="button-link">Continue Shopping</a>
//             </div>
//         `;
//         return;
//     }

//     const cartItemsHTML = cartItems.map(item => `
//         <div class="cart-item" data-item-id="${item.id}">
//             <img src="${item.image_url || '/placeholder-pizza.jpg'}" alt="${item.name}" class="cart-item-image">
//             <div class="cart-item-details">
//                 <h4 class="cart-item-name">${item.name}</h4>
//                 <p class="cart-item-price">$${parseFloat(item.price).toFixed(2)}</p>
//             </div>
//             <div class="cart-item-actions">
//                 <div class="quantity-selector">
//                     <button class="quantity-btn decrease-qty" data-item-id="${item.id}">-</button>
//                     <input type="number" class="quantity-input" value="${item.quantity}" min="0" data-item-id="${item.id}">
//                     <button class="quantity-btn increase-qty" data-item-id="${item.id}">+</button>
//                 </div>
//                 <p class="cart-item-subtotal">$${(item.price * item.quantity).toFixed(2)}</p>
//                 <button class="remove-item-btn" data-item-id="${item.id}" title="Remove item">&times;</button>
//             </div>
//         </div>
//     `).join('');

//     mainContent.innerHTML = `
//         <h2>Your Cart</h2>
//         <div class="cart-items-container">${cartItemsHTML}</div>
//         <div class="cart-summary">
//             <p class="cart-total">Total: <strong>$${getCartTotal().toFixed(2)}</strong></p>
//             <a href="#checkout" class="button-primary">Proceed to Checkout</a>
//         </div>
//     `;
//     attachCartEventListeners();
// }

// /**
//  * Attaches event listeners for the interactive elements on the cart page.
//  */
// function attachCartEventListeners() {
//     const cartContainer = document.querySelector('.cart-items-container');
//     if (!cartContainer) return;

//     const { updateItemQuantity, removeItem } = useAppStore.getState();

//     // Use a single event listener with delegation for performance
//     cartContainer.addEventListener('click', (event) => {
//         const target = event.target;
//         const itemId = target.closest('[data-item-id]')?.dataset.itemId;
//         if (!itemId) return;

//         const currentItem = useAppStore.getState().cartItems.find(i => i.id === itemId);
//         if (!currentItem) return;

//         if (target.matches('.increase-qty')) {
//             updateItemQuantity(itemId, currentItem.quantity + 1);
//         } else if (target.matches('.decrease-qty')) {
//             updateItemQuantity(itemId, currentItem.quantity - 1);
//         } else if (target.matches('.remove-item-btn')) {
//             removeItem(itemId);
//         }
//     });

//     cartContainer.addEventListener('change', (event) => {
//         const target = event.target;
//         if (target.matches('.quantity-input')) {
//             const itemId = target.dataset.itemId;
//             const newQuantity = parseInt(target.value, 10);
//             if (!isNaN(newQuantity)) {
//                 updateItemQuantity(itemId, newQuantity);
//             }
//         }
//     });
// }