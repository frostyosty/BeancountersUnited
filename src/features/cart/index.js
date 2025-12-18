// src/features/cart/index.js
import { useAppStore } from '@/store/appStore.js';
import * as templates from './templates.js';
import { handleCashPayment, initializeStripeFlow } from './payment.js';

// Local state for this session
let isGuestCheckout = false;

export function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { items, getCartTotal } = useAppStore.getState().cart;
    const { isAuthenticated } = useAppStore.getState().auth;
    const { settings } = useAppStore.getState().siteSettings;
    const { canPayWithCash } = useAppStore.getState().checkout;

    // 1. Empty State
    const validItems = items ? items.filter(i => i && i.id) : [];
    if (validItems.length === 0) {
        mainContent.innerHTML = templates.getEmptyStateHTML();
        return;
    }

    // 2. Prepare Data
    const total = getCartTotal();
    const savedGuestName = localStorage.getItem('guest_name');
    const cashRule = canPayWithCash();
    const enableStripe = settings.paymentConfig?.enableStripe !== false;

    // 3. Render HTML
    const itemsHTML = templates.getCartItemsHTML(validItems);
    const paymentHTML = templates.getPaymentSectionHTML(
        isAuthenticated, 
        isGuestCheckout, 
        cashRule, 
        enableStripe, 
        savedGuestName, 
        total
    );

    mainContent.innerHTML = `
        ${templates.CART_CSS}
        <div class="cart-container" style="max-width:800px; margin:0 auto;">
            <h2>Your Order</h2>
            <div class="cart-items-wrapper" style="background:white; padding:0 20px; border-radius:8px; box-shadow:0 2px 5px rgba(0,0,0,0.05);">
                ${itemsHTML}
            </div>
            
            <div class="cart-total-row" style="display:flex; justify-content:flex-end; align-items:center; gap:20px; margin-top:20px; font-size:1.3rem; font-weight:bold;">
                <span>Total:</span>
                <span style="color:var(--primary-color);">$${total.toFixed(2)}</span>
            </div>

            ${paymentHTML}
        </div>
    `;

    attachListeners();
}


function attachListeners() {
    // FIX: Select the .cart-container instead of #main-content
    // This element is destroyed/recreated on every render, preventing listener cleanup issues.
    const container = document.querySelector('.cart-container');
    if (!container) return;

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        // --- Guest Logic ---
        if (btn.id === 'guest-start-btn') {
            import('@/utils/uiUtils.js').then(utils => {
                utils.showGuestNameModal((name) => {
                    localStorage.setItem('guest_name', name);
                    isGuestCheckout = true;
                    renderCartPage();
                });
            });
            return;
        }
        if (btn.id === 'guest-continue-btn') {
            isGuestCheckout = true;
            renderCartPage();
            return;
        }

        // --- Auth Logic ---
        if (btn.id === 'cart-login-btn') {
            import('@/features/auth/authUI.js').then(m => m.showLoginSignupModal());
            return;
        }

        // --- Payment Logic ---
        if (btn.id === 'pay-cash-btn') {
            handleCashPayment(btn);
            return;
        }
        if (btn.id === 'pay-stripe-btn') {
            btn.style.display = 'none'; 
            document.getElementById('stripe-container').style.display = 'block'; 
            initializeStripeFlow(() => { isGuestCheckout = false; });
            return;
        }

        // --- Item Actions ---
        const uniqueId = btn.dataset.uniqueId;
        if (uniqueId) {
            const { updateItemQuantity, removeItem, items } = useAppStore.getState().cart;
            const currentItem = items.find(i => (i.cartId || i.id) === uniqueId);
            if (!currentItem) return;

            if (btn.classList.contains('increase-qty')) updateItemQuantity(uniqueId, currentItem.quantity + 1);
            else if (btn.classList.contains('decrease-qty')) updateItemQuantity(uniqueId, currentItem.quantity - 1);
            else if (btn.classList.contains('remove-item-btn')) removeItem(uniqueId);
        }
    });
}