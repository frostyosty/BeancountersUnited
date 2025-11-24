// src/features/cart/cartUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { loadStripe } from '@stripe/stripe-js';

// Initialize Stripe outside of render to avoid reloading it on every render
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY);

/**
 * Renders the shopping cart page.
 */
export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const cartSlice = useAppStore.getState().cart;
    // FIX: Use getCartTotal, not getTotalPrice
    const { items, getCartTotal } = cartSlice;

    if (items.length === 0) {
        mainContent.innerHTML = `
            <div class="empty-state">
                <h2>Your Cart is Empty</h2>
                <a href="#menu" class="button-primary">Browse Menu</a>
            </div>`;
        return;
    }

    const cartItemsHTML = items.map(item => {
        // FIX: Ensure numbers
        const price = parseFloat(item.price) || 0;
        const subtotal = price * item.quantity;

        return `
        <div class="cart-item" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" class="cart-item-image">
            <div class="cart-item-details">
                <h4 class="cart-item-name">${item.name}</h4> <!-- Only print name once -->
                <p class="cart-item-price">$${price.toFixed(2)}</p>
            </div>
            <div class="cart-item-actions">
                <div class="quantity-selector">
                    <button class="quantity-btn decrease-qty" data-item-id="${item.id}">-</button>
                    <input type="number" class="quantity-input" value="${item.quantity}" readonly>
                    <button class="quantity-btn increase-qty" data-item-id="${item.id}">+</button>
                </div>
                <p class="cart-item-subtotal">$${subtotal.toFixed(2)}</p>
                <button class="remove-item-btn" data-item-id="${item.id}" title="Remove">&times;</button>
            </div>
        </div>
    `;
    }).join('');

    // FIX: Ensure total is a number
    const totalVal = parseFloat(getCartTotal()) || 0;

    mainContent.innerHTML = `
        <h2>Your Cart</h2>
        <div class="cart-items-container">${cartItemsHTML}</div>
        <div class="cart-summary">
            <div class="cart-total-row" style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem;">
                <span>Total:</span>
                <span>$${totalVal.toFixed(2)}</span>
            </div>
            <a href="#checkout" class="button-primary full-width-mobile" style="display:block; text-align:center;">Proceed to Checkout</a>
        </div>
    `;

    attachCartEventListeners();
}


function attachCartEventListeners() {
    const cartContainer = document.querySelector('.cart-items-container');
    if (!cartContainer || cartContainer.dataset.listenersAttached) return;

    cartContainer.addEventListener('click', (event) => {
        const target = event.target;
        const itemId = target.closest('[data-item-id]')?.dataset.itemId;
        if (!itemId) return;

        const { updateItemQuantity, removeItem } = useAppStore.getState().cart;
        const currentItem = useAppStore.getState().cart.items.find(i => i.id === itemId);
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
        if (event.target.matches('.quantity-input')) {
            const itemId = event.target.dataset.itemId;
            const newQuantity = parseInt(event.target.value, 10);
            if (!isNaN(newQuantity)) {
                useAppStore.getState().cart.updateItemQuantity(itemId, newQuantity);
            }
        }
    });

    cartContainer.dataset.listenersAttached = 'true';
}

/**
 * Renders the checkout page into the main content area.
 */
export function renderCheckoutPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;


    const { items, getCartTotal } = useAppStore.getState().cart;
    const { isAuthenticated } = useAppStore.getState().auth;
    const { canPayWithCash } = useAppStore.getState().checkout;
    // FIX: Get settings directly to check for Stripe
    const { settings } = useAppStore.getState().siteSettings;
    const paymentConfig = settings.paymentConfig || {};
    const enableStripe = paymentConfig.enableStripe !== false; // Default true

    // 1. Empty Cart Check
    if (items.length === 0) {
        window.location.hash = '#menu';
        return;
    }

    // 2. Auth Check
    if (!isAuthenticated) {
        mainContent.innerHTML = `
            <div class="notice-message">
                <h2>Login Required</h2>
                <p>Please log in or sign up to complete your order.</p>
                <button class="button-primary" onclick="document.getElementById('login-signup-btn').click()">Login / Sign Up</button>
            </div>
        `;
        return;
    }
    const total = getCartTotal();
    // 3. Check Payment Rules
    const cashValidation = canPayWithCash();

    // 4. Generate Payment Buttons HTML
    let cashSectionHTML = '';

    // FIX: Only show button if allowed. Do NOT show "Unavailable" error box.
    if (cashValidation.allowed) {
        cashSectionHTML = `
            <button id="pay-cash-btn" class="button-secondary" style="width:100%; margin-bottom:15px; padding:15px; font-size:1rem; border:2px solid var(--secondary-color);">
                Pay on Pickup (Cash/EFTPOS)
            </button>
        `;
    }
    // Else: Show nothing for cash.

    let stripeSectionHTML = '';
    if (enableStripe) {
        stripeSectionHTML = `
            <button id="pay-stripe-btn" class="button-primary" style="width:100%; padding:15px; font-size:1rem;">
                Pay with Card (Stripe)
            </button>
            <div id="stripe-element-container" style="margin-top:20px; padding:15px; border:1px solid #eee; border-radius:8px; display:none;"></div>
            <div id="stripe-error-message" style="color:red; margin-top:10px; display:none;"></div>
        `;
    } else {
        stripeSectionHTML = `<div class="notice-message">Online payments are temporarily disabled.</div>`;
    }

    // If both disabled?
    if (!cashValidation.allowed && !enableStripe) {
        mainContent.innerHTML = `
            <div class="checkout-container" style="max-width:600px; margin:0 auto;">
                <h2>Checkout</h2>
                <div class="error-message">
                    <h3>No Payment Methods Available</h3>
                    <p>Your order (${cashValidation.reason}) cannot be paid with cash, and online payments are offline.</p>
                    <p>Please reduce your order size or contact staff.</p>
                </div>
            </div>`;
        return;
    }

    mainContent.innerHTML = `
        <div class="checkout-container" style="max-width:600px; margin:0 auto;">
            <h2>Checkout</h2>
            
            <div class="checkout-summary" style="background:#f9f9f9; padding:20px; border-radius:8px; margin-bottom:25px;">
                <h3>Order Summary</h3>
                <ul style="list-style:none; padding:0; margin:0 0 15px 0;">
                    ${items.map(item => `
                        <li style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.95rem;">
                            <span>${item.quantity}x ${item.name}</span>
                            <span>$${(item.price * item.quantity).toFixed(2)}</span>
                        </li>
                    `).join('')}
                </ul>
                <div style="border-top:1px solid #ddd; padding-top:10px; display:flex; justify-content:space-between; font-weight:bold; font-size:1.2rem;">
                    <span>Total</span>
                    <span>$${total.toFixed(2)}</span>
                </div>
            </div>

            <div class="payment-options">
                <h3>Choose Payment Method</h3>
                ${cashSectionHTML}
                ${stripeSectionHTML}
            </div>
        </div>
    `;

    attachCheckoutListeners();
}

function attachCheckoutListeners() {
    // --- Handler for Cash/Pickup ---
    document.getElementById('pay-cash-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('pay-cash-btn');
        btn.disabled = true;
        btn.textContent = "Processing Order...";

        const { submitCashOrder } = useAppStore.getState().checkout;
        const result = await submitCashOrder();

        if (result.success) {
            uiUtils.showToast("Order Placed Successfully!", "success");
            window.location.hash = '#order-history';
        } else {
            uiUtils.showToast(result.error, "error");
            btn.disabled = false;
            btn.textContent = "Pay on Pickup (Cash/EFTPOS)";
        }
    });

    // --- Handler for Stripe ---
    const stripeBtn = document.getElementById('pay-stripe-btn');
    stripeBtn?.addEventListener('click', async () => {
        const container = document.getElementById('stripe-element-container');
        const errorDiv = document.getElementById('stripe-error-message');
        const total = useAppStore.getState().cart.getCartTotal();

        stripeBtn.disabled = true;
        stripeBtn.textContent = "Loading Secure Payment...";
        errorDiv.style.display = 'none';

        try {
            // 1. Call Backend to get Client Secret
            const response = await fetch('/api/create-payment-intent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: total }),
            });

            const { clientSecret, error } = await response.json();
            if (error) throw new Error(error);

            // 2. Load Stripe Elements
            const stripe = await stripePromise;
            const elements = stripe.elements({ clientSecret, appearance: { theme: 'stripe' } });
            const paymentElement = elements.create('payment');

            container.style.display = 'block';
            container.innerHTML = ''; // Clear previous if any
            paymentElement.mount('#stripe-element-container');

            // 3. Change Button to "Pay Now"
            stripeBtn.textContent = `Pay $${total.toFixed(2)} Now`;
            stripeBtn.disabled = false;

            // 4. Switch listener to "Submit Payment"
            // We clone the button to remove old listeners easily
            const newBtn = stripeBtn.cloneNode(true);
            stripeBtn.parentNode.replaceChild(newBtn, stripeBtn);

            newBtn.addEventListener('click', async () => {
                newBtn.disabled = true;
                newBtn.textContent = "Processing...";
                errorDiv.style.display = 'none';

                // A. Confirm Payment with Stripe
                const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
                    elements,
                    confirmParams: {
                        // We handle redirect manually via 'if_required'
                    },
                    redirect: 'if_required'
                });

                if (stripeError) {
                    errorDiv.textContent = stripeError.message;
                    errorDiv.style.display = 'block';
                    newBtn.disabled = false;
                    newBtn.textContent = `Pay $${total.toFixed(2)} Now`;
                } else if (paymentIntent && paymentIntent.status === 'succeeded') {
                    // B. Payment Success! Save to DB
                    const { submitPaidOrder } = useAppStore.getState().checkout;
                    const res = await submitPaidOrder(paymentIntent);

                    if (res.success) {
                        uiUtils.showToast("Payment Successful!", "success");
                        window.location.hash = '#order-history';
                    } else {
                        // Rare edge case: Payment worked, DB failed
                        uiUtils.showToast(res.error, 'error');
                        errorDiv.textContent = "Payment succeeded, but order saving failed. Please contact staff.";
                        errorDiv.style.display = 'block';
                    }
                }
            });

        } catch (e) {
            console.error(e);
            uiUtils.showToast("Could not initialize payment.", "error");
            stripeBtn.disabled = false;
            stripeBtn.textContent = "Pay with Card (Stripe)";
        }
    });
}