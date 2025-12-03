// src/features/cart/cartUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY);

/**
 * Renders the Merged Cart & Checkout Page
 */
export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 1. Get State
    const { items, getCartTotal } = useAppStore.getState().cart;
    const { isAuthenticated } = useAppStore.getState().auth;
    const { settings } = useAppStore.getState().siteSettings;
    const { canPayWithCash } = useAppStore.getState().checkout;

    // 2. Empty State
    if (items.length === 0) {
        mainContent.innerHTML = `
            <div class="empty-state">
                <h2>Your Cart is Empty</h2>
                <p>Looks like you haven't added anything yet.</p>
                <a href="#menu" class="button-primary">Browse Menu</a>
            </div>`;
        return;
    }

    // 3. Totals Calculation
    const total = getCartTotal();

    // 4. Build Item List HTML
    const cartItemsHTML = items.map(item => {
        const price = parseFloat(item.price) || 0;
        return `
        <div class="cart-item" data-item-id="${item.id}" style="display:flex; align-items:center; justify-content:space-between; padding:15px 0; border-bottom:1px solid #eee;">
            <!-- Left: Image & Info -->
            <div style="display:flex; gap:15px; align-items:center;">
                <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" 
                     style="width:60px; height:60px; object-fit:cover; border-radius:6px;">
                <div>
                    <h4 style="margin:0; font-size:1rem;">${item.name}</h4>
                    <p style="margin:0; color:#666; font-size:0.9rem;">$${price.toFixed(2)}</p>
                </div>
            </div>

            <!-- Right: Controls -->
            <div style="display:flex; align-items:center; gap:15px;">
                
                <!-- Qty Stepper -->
                <div class="quantity-selector" style="display:flex; align-items:center; border:1px solid #ddd; border-radius:4px;">
                    <button class="quantity-btn decrease-qty" data-item-id="${item.id}" style="padding:5px 10px; background:none; border:none; cursor:pointer;">-</button>
                    <span style="padding:0 5px; min-width:20px; text-align:center;">${item.quantity}</span>
                    <button class="quantity-btn increase-qty" data-item-id="${item.id}" style="padding:5px 10px; background:none; border:none; cursor:pointer;">+</button>
                </div>

                <!-- Subtotal -->
                <span style="font-weight:600; width:60px; text-align:right;">$${(price * item.quantity).toFixed(2)}</span>

                <!-- Delete Button (Styled) -->
                <button class="delete-icon-btn remove-item-btn" data-item-id="${item.id}" title="Remove">×</button>
            </div>
        </div>`;
    }).join('');

    // 5. Payment Logic (Only if Authenticated)
    let paymentSectionHTML = '';

    if (!isAuthenticated) {
        paymentSectionHTML = `
            <div style="margin-top:30px; padding:20px; background:#fff3cd; border-radius:8px; text-align:center;">
                <h3>Almost there!</h3>
                <p>Please log in to complete your order.</p>
                <button class="button-primary" id="cart-login-btn">Login / Sign Up</button>
            </div>`;
    } else {
        // Authenticated: Show Payment Options
        const cashRule = canPayWithCash();
        const enableStripe = settings.paymentConfig?.enableStripe !== false;

        const cashBtn = cashRule.allowed
            ? `<button id="pay-cash-btn" class="button-secondary" style="width:100%; margin-bottom:10px; padding:15px;">Pay on Pickup (Cash)</button>`
            : `<div style="padding:10px; background:#eee; color:#666; font-size:0.9rem; text-align:center; margin-bottom:10px;">Pay on Pickup Unavailable (${cashRule.reason})</div>`;

        const stripeBtn = enableStripe
            ? `<button id="pay-stripe-btn" class="button-primary" style="width:100%; padding:15px;">Pay with Card</button>`
            : `<button disabled class="button-primary" style="width:100%; padding:15px; opacity:0.6;">Card Payments Offline</button>`;

        paymentSectionHTML = `
            <div class="payment-section" style="margin-top:30px;">
                <h3>Payment Method</h3>
                <div style="display:flex; flex-direction:column; gap:10px; max-width:400px; margin-left:auto;">
                    ${cashBtn}
                    ${stripeBtn}
                    
                    <!-- Stripe Container (Hidden) -->
                    <div id="stripe-container" style="display:none; border:1px solid #eee; padding:15px; border-radius:8px; margin-top:10px;">
                        <div id="stripe-element-mount"></div>
                        <button id="stripe-submit-btn" class="button-primary" style="width:100%; margin-top:15px;">Pay $${total.toFixed(2)}</button>
                        <div id="stripe-error" style="color:red; margin-top:10px; font-size:0.9rem;"></div>
                    </div>
                </div>
            </div>
        `;
    }

    // 6. Final Layout
    mainContent.innerHTML = `
        <div class="cart-container" style="max-width:800px; margin:0 auto;">
            <h2>Your Order</h2>
            <div class="cart-items-wrapper" style="background:white; padding:0 20px; border-radius:8px; box-shadow:0 2px 5px rgba(0,0,0,0.05);">
                ${cartItemsHTML}
            </div>
            
            <div class="cart-total-row" style="display:flex; justify-content:flex-end; align-items:center; gap:20px; margin-top:20px; font-size:1.3rem; font-weight:bold;">
                <span>Total:</span>
                <span style="color:var(--primary-color);">$${total.toFixed(2)}</span>
            </div>

            ${paymentSectionHTML}
        </div>
    `;

    attachListeners();
}

function attachListeners() {
    const mainContent = document.getElementById('main-content');

    // A. Cart Item Actions (Quantity / Delete)
    mainContent.addEventListener('click', (e) => {
        // use .closest() to handle clicks on icons inside buttons
        const btn = e.target.closest('button');
        if (!btn) return;

        const { updateItemQuantity, removeItem, items } = useAppStore.getState().cart;
        const itemId = btn.dataset.itemId;

        // Increase
        if (btn.classList.contains('increase-qty')) {
            const item = items.find(i => i.id === itemId);
            if (item) updateItemQuantity(itemId, item.quantity + 1);
        }
        // Decrease
        if (btn.classList.contains('decrease-qty')) {
            const item = items.find(i => i.id === itemId);
            if (item) updateItemQuantity(itemId, item.quantity - 1);
        }
        // Remove
        if (btn.classList.contains('remove-item-btn')) {
            if (confirm("Remove item?")) removeItem(itemId);
        }

        // Inline Login Button
        if (btn.id === 'cart-login-btn') {
            import('@/features/auth/authUI.js').then(m => m.showLoginSignupModal());
        }

        // Pay Cash
        if (btn.id === 'pay-cash-btn') {
            handleCashPayment(btn);
        }

        // Pay Stripe (Open Form)
        if (btn.id === 'pay-stripe-btn') {
            btn.style.display = 'none'; // Hide "Pay with Card" button
            document.getElementById('stripe-container').style.display = 'block'; // Show form
            initializeStripeFlow();
        }
    });
}

// --- Payment Handlers ---

async function handleCashPayment(btn) {
    btn.disabled = true;
    btn.textContent = "Processing...";

    const { submitCashOrder } = useAppStore.getState().checkout;
    const result = await submitCashOrder();

    if (result.success) {
        uiUtils.showToast("Order Placed!", "success");
        window.location.hash = '#order-history';
    } else {
        uiUtils.showToast(result.error, "error");
        btn.disabled = false;
        btn.textContent = "Pay on Pickup (Cash)";
    }
}

async function initializeStripeFlow() {
    const total = useAppStore.getState().cart.getCartTotal();
    const errorDiv = document.getElementById('stripe-error');

    try {
        // 1. Get Secret
        const res = await fetch('/api/create-payment-intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: total })
        });
        const { clientSecret, error } = await res.json();
        if (error) throw new Error(error);

        // 2. Mount Stripe
        const stripe = await stripePromise;
        const elements = stripe.elements({ clientSecret, appearance: { theme: 'stripe' } });
        const paymentElement = elements.create('payment');
        paymentElement.mount('#stripe-element-mount');

        // 3. Attach Submit Listener
        const submitBtn = document.getElementById('stripe-submit-btn');
        submitBtn.onclick = async () => {
            submitBtn.disabled = true;
            submitBtn.textContent = "Processing...";

            const result = await stripe.confirmPayment({
                elements,
                confirmParams: {
                    // FIX: Add this line. It redirects back to your site after payment if needed.
                    return_url: window.location.origin + '/#order-history',
                },
                redirect: 'if_required'
            });

            if (result.error) {
                errorDiv.textContent = result.error.message;
                submitBtn.disabled = false;
                submitBtn.textContent = `Pay $${total.toFixed(2)}`;
            } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
                // Save Order
                const { submitPaidOrder } = useAppStore.getState().checkout;
                const saveRes = await submitPaidOrder(result.paymentIntent);
                if (saveRes.success) {
                    uiUtils.showToast("Payment Successful!", "success");
                    window.location.hash = '#order-history';
                } else {
                    errorDiv.textContent = "Payment worked, but database save failed. Contact staff.";
                }
            }
        };

    } catch (e) {
        console.error(e);
        errorDiv.textContent = "Payment System Error.";
    }
}