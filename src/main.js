// src/main.js

// --- Core Imports ---
import './assets/css/style.css';        // Main site styles
import './assets/css/theme-default.css';// Default theme (or your active theme CSS)

// --- Module Imports ---
// Use `import * as ...` to get all exports as a namespace,
// or import specific named exports: `import { getMenu, ... } from './apiService.js'`
import * as api from './apiService.js';
import * as auth from './auth.js';     // Handles user authentication, session, login UI
import * as uiUtils from './ui.js';        // DOM manipulation, modals, theme application, favicon updates
import * as cart from './cart.js';     // Cart logic
import * as admin from './admin.js';   // Owner/Manager dashboard rendering

// --- Global Namespace (for transition & external calls if needed) ---
// This is often a temporary step during refactoring.
// Ideally, modules call each other directly via imports, not through window.
window.api = api;
window.auth = auth;
window.ui = uiUtils;
window.cart = cart;
window.admin = admin;

// --- Helper Functions (specific to main.js orchestrator logic) ---

/**
 * Loads and applies initial site settings like website name and favicon.
 */
async function loadAndApplySiteSettings() {
    try {
        const settings = await api.getSiteSettings(); // Fetches all settings
        if (settings) {
            // Apply Website Name
            if (settings.websiteName) {
                ui.updateSiteTitles(settings.websiteName);
            }

            // Apply Theme Variables
            if (settings.themeVariables && Object.keys(settings.themeVariables).length > 0) {
                Object.entries(settings.themeVariables).forEach(([varName, value]) => {
                    ui.updateCssVariable(varName, value);
                });
            } else if (settings.activeThemeCss) { // Legacy theme file
                ui.applyTheme(settings.activeThemeCss);
            }

            // Apply Favicon
            const faviconConfig = settings.faviconConfig;
            if (faviconConfig) {
                if (faviconConfig.type === 'text' && ui.generateTextFaviconDataUrl) {
                    const dataUrl = ui.generateTextFaviconDataUrl(faviconConfig.text, faviconConfig.bgColor, faviconConfig.textColor);
                    ui.updateLiveFavicon(dataUrl, 'image/svg+xml');
                } else if (faviconConfig.type === 'image' && faviconConfig.url) {
                    let type = 'image/png'; // Default
                    if (faviconConfig.url.endsWith('.svg')) type = 'image/svg+xml';
                    if (faviconConfig.url.endsWith('.ico')) type = 'image/x-icon';
                    ui.updateLiveFavicon(faviconConfig.url, type);
                } else {
                    ui.updateLiveFavicon('/default-favicon.svg', 'image/svg+xml'); // Default
                }
            } else {
                ui.updateLiveFavicon('/default-favicon.svg', 'image/svg+xml'); // Fallback if no config
            }
        }
    } catch (error) {
        console.error("Failed to load or apply site settings:", error);
        // Fallback to basic defaults if settings fail
        ui.updateSiteTitles("My Awesome Restaurant");
        ui.updateLiveFavicon('/default-favicon.svg', 'image/svg+xml');
    }
}

/**
 * Simple hash-based router.
 */
function handleRouteChange() {
    ui.setLoading(true); // Show loading state
    const hash = window.location.hash || '#menu'; // Default to menu
    // console.log("Routing to:", hash);

    const { profile } = auth.getCurrentUser(); // Get user role for conditional rendering
    const userRole = profile?.role || 'guest';

    // Clear previous page-specific event listeners if necessary (more advanced)
    // For this simple SPA, we re-render and re-attach listeners as needed.

    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        case '#checkout':
            renderCheckoutPage();
            break;
        case '#order-confirmation':
            renderOrderConfirmationPage();
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'manager') {
                admin.renderOwnerDashboard(); // Assumes admin module has this function
            } else {
                ui.renderPage('<p>Access Denied. You need to be an owner or manager to view this page.</p>');
                ui.setLoading(false);
            }
            break;
        case '#manager-dashboard':
            if (userRole === 'manager') {
                admin.renderManagerDashboard(); // Assumes admin module has this function
            } else {
                ui.renderPage('<p>Access Denied. You need to be a manager to view this page.</p>');
                ui.setLoading(false);
            }
            break;
        default:
            ui.renderPage('<h2>Page Not Found</h2><p>Sorry, the page you are looking for does not exist.</p>');
            ui.setLoading(false);
    }
}

// Export navigateTo so it can be called from HTML event attributes (onclick="navigateTo('#cart')")
// or from other modules if they don't import main.js directly.
window.navigateTo = (hash) => {
    window.location.hash = hash; // Triggers 'hashchange' event, which calls handleRouteChange
};


// --- Page Rendering Functions ---
// These construct HTML and attach event listeners for each "page".

async function renderMenuPage() {
    try {
        const menuItems = await api.getMenu();
        let html = '<h2>Our Menu</h2><div class="menu-section" style="display: flex; flex-wrap: wrap; gap: 1em;">'; // Flexbox for simple grid
        if (!menuItems || menuItems.length === 0) {
            html += '<p>Our menu is currently empty. Please check back later!</p>';
        } else {
            menuItems.forEach(item => {
                html += `
                    <div class="menu-item" data-id="${item.id}" style="width: calc(33.333% - 1em); border: 1px solid #ccc; padding: 1em; box-sizing: border-box;">
                        <img src="${item.image_url || '/placeholder-pizza.jpg'}" alt="${item.name}" style="max-width:100%; height:auto; max-height:150px; object-fit:cover; margin-bottom:0.5em;">
                        <h3>${item.name}</h3>
                        <p>${item.description || ''}</p>
                        <p class="price" style="font-weight:bold;">$${parseFloat(item.price).toFixed(2)}</p>
                        <button class="add-to-cart-btn" data-id="${item.id}">Add to Cart</button>
                    </div>
                `;
            });
        }
        html += '</div>';
        ui.renderPage(html);

        document.querySelectorAll('.add-to-cart-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const itemId = e.target.dataset.id;
                // Find item data (getMenu response is still in scope or re-fetch item details)
                const item = menuItems.find(m => m.id.toString() === itemId.toString());
                if (item) cart.addItem(item); // Uses imported cart module
            });
        });
    } catch (error) {
        console.error("Failed to render menu:", error);
        ui.renderPage('<p style="color:red;">Error loading menu. Please try refreshing.</p>');
    } finally {
        ui.setLoading(false);
    }
}

function renderCartPage() {
    const items = cart.getItems(); // Uses imported cart module
    let html = '<h2>Your Cart</h2>';
    if (items.length === 0) {
        html += '<p>Your cart is empty. <a href="#menu" onclick="navigateTo(\'#menu\'); return false;">Browse our menu!</a></p>';
    } else {
        html += '<div id="cart-items-list">';
        items.forEach(item => {
            html += `
                <div class="cart-item" data-id="${item.id}" style="display:flex; justify-content:space-between; padding:0.5em 0; border-bottom:1px solid #eee;">
                    <div>
                        ${item.name} (x<input type="number" value="${item.quantity}" min="1" class="quantity-input" data-id="${item.id}" style="width: 50px; text-align:center;">)
                    </div>
                    <span>$${(item.price * item.quantity).toFixed(2)}</span>
                    <button class="remove-from-cart-btn" data-id="${item.id}" style="background:none; border:none; color:red; cursor:pointer;">× Remove</button>
                </div>
            `;
        });
        html += '</div>';
        html += `<p id="cart-total" style="font-weight:bold; margin-top:1em; text-align:right;">Total: $${cart.getTotal().toFixed(2)}</p>`;
        html += '<button id="checkout-button" onclick="navigateTo(\'#checkout\');" style="width:100%; padding:0.8em; background-color:var(--accent-color); color:white; border:none; border-radius:4px; font-size:1.1em; cursor:pointer; margin-top:1em;">Proceed to Checkout</button>';
    }
    ui.renderPage(html);

    // Attach event listeners for cart interactions
    document.querySelectorAll('.remove-from-cart-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            cart.removeItem(e.target.dataset.id);
            renderCartPage(); // Re-render cart
        });
    });
    document.querySelectorAll('.quantity-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const quantity = parseInt(e.target.value);
            if (quantity > 0) {
                cart.updateQuantity(e.target.dataset.id, quantity);
            } else {
                 cart.removeItem(e.target.dataset.id); // Or set to 1 if preferred
            }
            renderCartPage(); // Re-render cart
        });
    });
    ui.setLoading(false);
}

async function renderCheckoutPage() {
    const total = cart.getTotal();
    if (total === 0 && window.location.hash === '#checkout') { // Only redirect if actively trying to checkout an empty cart
        navigateTo('#cart');
        return;
    }

    const { user } = auth.getCurrentUser();

    if (total > 10 && !user) {
        ui.renderPage(`
            <h2>Login Required</h2>
            <p>Your order total is $${total.toFixed(2)}, which is over $10.00. Please login or sign up to continue.</p>
            <button id="login-for-checkout" style="padding:0.5em 1em;">Login / Sign Up</button>
        `);
        document.getElementById('login-for-checkout')?.addEventListener('click', () => {
            auth.showLoginModal();
            // Listen for successful login to re-route or re-render checkout
            function onAuthChangeForCheckout({ detail }) {
                if (detail.user) { // User is now logged in
                    navigateTo('#checkout'); // Re-evaluate checkout page
                }
                document.removeEventListener('authChange', onAuthChangeForCheckout);
            }
            document.addEventListener('authChange', onAuthChangeForCheckout, { once: true });
        });
        ui.setLoading(false);
        return;
    }

    // Set min pickup time (e.g., 30 mins from now, during operating hours)
    const minPickupDateTime = new Date(Date.now() + 30 * 60000); // 30 minutes from now
    // Format for datetime-local: YYYY-MM-DDTHH:MM
    const formattedMinPickup = `${minPickupDateTime.getFullYear()}-${String(minPickupDateTime.getMonth() + 1).padStart(2, '0')}-${String(minPickupDateTime.getDate()).padStart(2, '0')}T${String(minPickupDateTime.getHours()).padStart(2, '0')}:${String(minPickupDateTime.getMinutes()).padStart(2, '0')}`;

    let html = `
        <h2>Checkout</h2>
        <p>Order Total: $${total.toFixed(2)}</p>
        <form id="checkout-form">
            <div><label for="name">Full Name:</label><input type="text" id="name" name="name" value="${user?.user_metadata?.full_name || user?.email || ''}" required></div>
            <div><label for="emailC">Email:</label><input type="email" id="emailC" name="email" value="${user?.email || ''}" required></div>
            <div><label for="phone">Phone Number (Optional):</label><input type="tel" id="phone" name="phone"></div>
            <div><label for="pickup-time">Preferred Pickup Time:</label><input type="datetime-local" id="pickup-time" name="pickupTime" min="${formattedMinPickup}" required></div>
            <div><label for="special-requests">Special Requests:</label><textarea id="special-requests" name="specialRequests"></textarea></div>
            <div id="payment-section" style="margin-top:1em; padding:1em; border:1px dashed #ccc;">
                <h3>Payment Information</h3>
                <p><em>Payment processing (e.g., Stripe) would be integrated here. For now, this is a placeholder. Order will be submitted directly.</em></p>
            </div>
            <button type="submit" id="confirm-order-button" style="width:100%; padding:0.8em; background-color:var(--accent-color); color:white; border:none; border-radius:4px; font-size:1.1em; cursor:pointer; margin-top:1em;">Confirm Order</button>
        </form>
    `;
    ui.renderPage(html);
    document.getElementById('checkout-form')?.addEventListener('submit', handleConfirmOrder);
    ui.setLoading(false);
}

async function handleConfirmOrder(event) {
    event.preventDefault();
    const confirmButton = document.getElementById('confirm-order-button');
    if(confirmButton) confirmButton.disabled = true; // Prevent double submission
    ui.setLoading(true);

    const formData = new FormData(event.target);
    const orderData = {
        customerName: formData.get('name'),
        customerEmail: formData.get('email'), // Make sure this name attribute matches (used emailC in form)
        customerPhone: formData.get('phone'),
        pickupTime: formData.get('pickupTime'),
        specialRequests: formData.get('specialRequests'),
        items: cart.getItems().map(item => ({ menuItemId: item.id, quantity: item.quantity, priceAtOrder: item.price })),
        totalAmount: cart.getTotal(),
        userId: auth.getCurrentUser().user?.id || null,
    };

    // Re-check auth for orders over $10 as a server might do
    if (orderData.totalAmount > 10 && !orderData.userId) {
        alert("Login is required for orders over $10. Please login and try again.");
        if(confirmButton) confirmButton.disabled = false;
        ui.setLoading(false);
        auth.showLoginModal(); // Prompt login
        // Potentially listen for authChange to re-enable button or retry
        return;
    }

    try {
        // Simulate payment success (in real app, integrate Stripe here)
        const submittedOrder = await api.submitOrder(orderData);
        cart.clearCart();
        localStorage.setItem('lastOrderId', submittedOrder.id); // Store for confirmation page
        navigateTo('#order-confirmation');
    } catch (error) {
        console.error("Order submission failed:", error);
        alert(`Order failed: ${error.message}. Please try again.`);
        if(confirmButton) confirmButton.disabled = false;
        ui.setLoading(false);
    }
}

function renderOrderConfirmationPage() {
    const lastOrderId = localStorage.getItem('lastOrderId');
    let html = '<h2>Order Confirmation</h2>';
    if (lastOrderId) {
        html += `<p>Thank you for your order! Your Order ID is <strong>${lastOrderId}</strong>.</p>`;
        html += `<p>We've received your order and will start preparing it soon. You'll be notified if we have questions, or when it's ready for pickup at your scheduled time.</p>`;
        localStorage.removeItem('lastOrderId'); // Clear after display
    } else {
        html += '<p>Thank you for your order! If your payment was processed, your order was likely placed. Please check your email or contact us if you have concerns.</p>';
    }
    html += '<p><a href="#menu" onclick="navigateTo(\'#menu\'); return false;">Place another order</a> or <a href="#" onclick="navigateTo(\'#\'); return false;">Go to Homepage</a></p>';
    ui.renderPage(html);
    ui.setLoading(false);
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM fully loaded and parsed (Vite Entry)");

    // Initialize footer year
    const currentYearEl = document.getElementById('current-year');
    if (currentYearEl) currentYearEl.textContent = new Date().getFullYear();

    // Attach core event listeners for persistent elements if not handled by auth module
    const loginButton = document.getElementById('login-button'); // Initial button from HTML
    const logoutButton = document.getElementById('logout-button');
    if (loginButton) loginButton.addEventListener('click', auth.showLoginModal);
    if (logoutButton) logoutButton.addEventListener('click', auth.handleLogout);

    // Initial auth check (auth.js's onAuthStateChange will also handle this)
    // but good to do an explicit check on load.
    try {
        await auth.checkUserSession();
    } catch (e) {
        console.error("Error during initial auth checkUserSession:", e);
        // UI might show auth system error from auth.js if Supabase init failed there
    }


    // Load site settings (name, theme, favicon) AFTER auth potentially ready (in case settings depend on role, though unlikely for these)
    await loadAndApplySiteSettings();

    // Router setup
    window.addEventListener('hashchange', handleRouteChange);
    handleRouteChange(); // Initial route rendering based on current hash or default

    // Example of listener for theme controls (if they exist from manager dashboard)
    // Placed on document.body for event delegation, as controls are dynamic.
    document.body.addEventListener('input', (event) => {
        if (event.target.matches('.theme-controls input[data-css-var]')) {
            const varName = event.target.dataset.cssVar;
            const value = event.target.value;
            ui.updateCssVariable(varName, value);
        }
    });

    console.log("UI Module (as uiUtils) before cart count update:", uiUtils); // For debugging
    if (uiUtils && typeof uiUtils.updateCartCount === 'function' && cart && typeof cart.getItems === 'function') {
        uiUtils.updateCartCount(cart.getItems().reduce((sum, item) => sum + item.quantity, 0)); // <<< Use uiUtils.
    } else {
        console.error("Either uiUtils.updateCartCount or cart.getItems is not available!");
    }

    document.addEventListener('cartUpdated', (event) => {
        if (uiUtils && typeof uiUtils.updateCartCount === 'function' && event.detail && Array.isArray(event.detail.cartItems)) {
            uiUtils.updateCartCount(event.detail.cartItems.reduce((sum, item) => sum + item.quantity, 0)); // <<< Use uiUtils.
        } else {
            console.error("Cannot update cart count on event: uiUtils.updateCartCount not available or cartItems missing/invalid.");
        }
    });
});


