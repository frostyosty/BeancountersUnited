import './assets/css/style.css';
import './assets/css/theme-default.css'; // Or dynamically load themes later

// Import other JS modules (they need to EXPORT what they provide)
import * as api from './apiService.js'; // Assuming apiService.js exports functions
import * as auth from './auth.js';
import * as ui from './ui.js';
import * as cart from './cart.js';
import * as admin from './admin.js';

// Make functions/objects globally available if your old code relied on window.foo
// THIS IS A TEMPORARY STEP to minimize immediate refactoring.
// Ideally, you'd refactor to pass dependencies explicitly.
window.api = api;
window.auth = auth;
window.ui = ui;
window.cart = cart;
window.admin = admin;
window.supabase = window.supabase; // Ensure the global supabase from index.html is still accessible if needed this way

// The rest of your existing main.js logic (event listeners, router)
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM fully loaded and parsed (Vite Entry)");

    document.getElementById('current-year').textContent = new Date().getFullYear();
    await auth.checkUserSession();


    loadSiteSettings(); // Ensure this function is defined or imported

    window.addEventListener('hashchange', handleRouteChange);
    handleRouteChange(); // Initial route

    document.body.addEventListener('input', (event) => {
        if (event.target.matches('.theme-controls input[data-css-var]')) {
            const varName = event.target.dataset.cssVar;
            const value = event.target.value;
            ui.updateCssVariable(varName, value); // Ensure ui object/module has this
        }
    });
});


async function loadSiteSettings() {
    try {
        const settings = await api.getSiteSettings();
        if (settings.websiteName) {
            ui.updateSiteTitles(settings.websiteName);
        }
        // Apply theme settings if stored
        if (settings.themeVariables) {
            Object.entries(settings.themeVariables).forEach(([varName, value]) => {
                ui.updateCssVariable(varName, value);
            });
        } else if (settings.activeThemeCss) { // Fallback for older theme model
             ui.applyTheme(settings.activeThemeCss);
        }
    } catch (error) {
        console.error("Failed to load site settings:", error);
        // Use default titles if loading fails
        ui.updateSiteTitles("My Awesome Restaurant");
    }
}


function handleRouteChange() {
    ui.setLoading(true);
    const hash = window.location.hash || '#menu';
    console.log("Routing to:", hash);

    // Simple access control based on role - you might want more robust checks
    const { profile } = auth.getCurrentUser();
    const userRole = profile?.role || 'guest';

    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        case '#checkout': // This might be part of cart page or a separate step
            renderCheckoutPage();
            break;
        case '#order-confirmation':
             // This page might be shown after a successful order.
             // Typically you'd pass an order ID via query param or state.
            renderOrderConfirmationPage();
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'manager') {
                admin.renderOwnerDashboard();
            } else {
                ui.renderPage('<p>Access Denied. You need to be an owner or manager.</p>');
            }
            break;
        case '#manager-dashboard':
            if (userRole === 'manager') {
                admin.renderManagerDashboard();
            } else {
                ui.renderPage('<p>Access Denied. You need to be a manager.</p>');
            }
            break;
        default:
            ui.renderPage('<h2>Page Not Found</h2><p>The page you are looking for does not exist.</p>');
            ui.setLoading(false);
    }
}

window.navigateTo = (hash) => {
    window.location.hash = hash;
    // handleRouteChange will be called by 'hashchange' event
};

async function renderMenuPage() {
    try {
        const menuItems = await api.getMenu();
        let html = '<h2>Our Menu</h2><div class="menu-section">';
        if (!menuItems || menuItems.length === 0) {
            html += '<p>Our menu is currently empty. Please check back later!</p>';
        } else {
            menuItems.forEach(item => {
                html += `
                    <div class="menu-item" data-id="${item.id}">
                        <img src="${item.image_url || 'images/placeholder-pizza.jpg'}" alt="${item.name}">
                        <h3>${item.name}</h3>
                        <p>${item.description || ''}</p>
                        <p class="price">$${parseFloat(item.price).toFixed(2)}</p>
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
                const item = menuItems.find(m => m.id.toString() === itemId.toString());
                if (item) cart.addItem(item);
            });
        });
    } catch (error) {
        console.error("Failed to render menu:", error);
        ui.renderPage('<p>Error loading menu. Please try refreshing.</p>');
    } finally {
        ui.setLoading(false);
    }
}

function renderCartPage() {
    const items = cart.getItems();
    let html = '<h2>Your Cart</h2>';
    if (items.length === 0) {
        html += '<p>Your cart is empty. <a href="#menu">Browse our menu!</a></p>';
    } else {
        html += '<div id="cart-items-list">';
        items.forEach(item => {
            html += `
                <div class="cart-item" data-id="${item.id}">
                    <span>${item.name} (x${item.quantity})</span>
                    <span>$${(item.price * item.quantity).toFixed(2)}</span>
                    <div>
                        <input type="number" value="${item.quantity}" min="1" class="quantity-input" data-id="${item.id}" style="width: 50px;">
                        <button class="remove-from-cart-btn" data-id="${item.id}">Remove</button>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        html += `<p id="cart-total">Total: $${cart.getTotal().toFixed(2)}</p>`;
        html += '<button id="checkout-button">Proceed to Checkout</button>';
    }
    ui.renderPage(html);

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
                 cart.removeItem(e.target.dataset.id);
            }
            renderCartPage(); // Re-render cart
        });
    });
    const checkoutButton = document.getElementById('checkout-button');
    if(checkoutButton) checkoutButton.addEventListener('click', () => navigateTo('#checkout'));
    ui.setLoading(false);
}

async function renderCheckoutPage() {
    const total = cart.getTotal();
    if (total === 0) {
        navigateTo('#cart'); // Go back to cart if it's empty
        return;
    }

    const { user } = auth.getCurrentUser();

    if (total > 10 && !user) {
        ui.renderPage(`
            <h2>Login Required</h2>
            <p>Your order is over $10.00. Please login or sign up to continue.</p>
            <button id="login-for-checkout">Login / Sign Up</button>
        `);
        document.getElementById('login-for-checkout').addEventListener('click', () => {
            auth.showLoginModal();
            // After login, user should be redirected back or checkout re-evaluated.
            // This can be handled by listening to 'authChange' event.
            document.addEventListener('authChange', function onAuthForCheckout() {
                if (auth.getCurrentUser().user) { // if now logged in
                    navigateTo('#checkout'); // retry checkout page
                }
                document.removeEventListener('authChange', onAuthForCheckout); // cleanup listener
            }, { once: true });
        });
        ui.setLoading(false);
        return;
    }

    let html = `
        <h2>Checkout</h2>
        <p>Order Total: $${total.toFixed(2)}</p>
        <form id="checkout-form">
            <div>
                <label for="name">Full Name:</label>
                <input type="text" id="name" name="name" value="${user?.user_metadata?.full_name || ''}" required>
            </div>
            <div>
                <label for="email">Email:</label>
                <input type="email" id="email" name="email" value="${user?.email || ''}" required>
            </div>
            <div>
                <label for="phone">Phone Number (Optional):</label>
                <input type="tel" id="phone" name="phone">
            </div>
            <div>
                <label for="pickup-time">Preferred Pickup Time:</label>
                <input type="datetime-local" id="pickup-time" name="pickupTime" required>
            </div>
            <div>
                <label for="special-requests">Special Requests (Optional):</label>
                <textarea id="special-requests" name="specialRequests"></textarea>
            </div>
            <!-- Placeholder for Payment Section -->
            <div id="payment-section">
                <h3>Payment Information</h3>
                <p><em>Payment processing (e.g., Stripe Elements) would be integrated here. For now, this is a placeholder.</em></p>
            </div>
            <button type="submit" id="confirm-order-button">Confirm Order & Pay</button>
        </form>
    `;
    ui.renderPage(html);

    // Set min pickup time (e.g., 30 mins from now)
    const pickupTimeInput = document.getElementById('pickup-time');
    if (pickupTimeInput) {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 30 - now.getTimezoneOffset()); // Add 30 mins, adjust for local timezone for datetime-local
        pickupTimeInput.min = now.toISOString().slice(0, 16);
    }
    
    document.getElementById('checkout-form').addEventListener('submit', handleConfirmOrder);
    ui.setLoading(false);
}

async function handleConfirmOrder(event) {
    event.preventDefault();
    ui.setLoading(true);
    const formData = new FormData(event.target);
    const orderData = {
        customerName: formData.get('name'),
        customerEmail: formData.get('email'),
        customerPhone: formData.get('phone'),
        pickupTime: formData.get('pickupTime'),
        specialRequests: formData.get('specialRequests'),
        items: cart.getItems().map(item => ({ menuItemId: item.id, quantity: item.quantity, priceAtOrder: item.price })),
        totalAmount: cart.getTotal(),
    };

    // For actual payment:
    // 1. Create PaymentIntent on server with orderData.totalAmount.
    // 2. Use Stripe Elements on client to confirm card payment with client_secret from PaymentIntent.
    // 3. Only on successful payment confirmation from Stripe, then call api.submitOrder.

    try {
        const { user } = auth.getCurrentUser();
        if (orderData.totalAmount > 10 && !user) {
            // This check should ideally be done before even showing the form, but as a safeguard:
            alert("Error: Login required for orders over $10.");
            navigateTo('#checkout'); // Go back to fix
            return;
        }
        orderData.userId = user?.id || null; // Add userId if logged in

        // Simulate payment success for now
        console.log("Simulating payment...");
        // In a real app, here you would integrate Stripe or another payment gateway.
        // After successful payment, then submit the order.

        const submittedOrder = await api.submitOrder(orderData);
        console.log("Order submitted:", submittedOrder);
        cart.clearCart();
        // Store orderId to display on confirmation page (could use localStorage or query param)
        localStorage.setItem('lastOrderId', submittedOrder.id);
        navigateTo('#order-confirmation');
    } catch (error) {
        console.error("Order submission failed:", error);
        alert(`Order failed: ${error.message}`); // Show user-friendly error
        ui.setLoading(false);
    }
}

function renderOrderConfirmationPage() {
    const lastOrderId = localStorage.getItem('lastOrderId');
    let html = '<h2>Order Confirmation</h2>';
    if (lastOrderId) {
        html += `<p>Thank you for your order! Your order ID is <strong>${lastOrderId}</strong>.</p>`;
        html += `<p>We've received your order and will start preparing it soon. You'll be notified when it's ready for pickup.</p>`;
        // Optionally, fetch order details for display:
        // const orderDetails = await api.getOrderById(lastOrderId); display...
        localStorage.removeItem('lastOrderId'); // Clear it after display
    } else {
        html += '<p>There seems to be an issue retrieving your order details, but if your payment was processed, your order was likely placed.</p>';
    }
    html += '<p><a href="#menu">Place another order</a></p>';
    ui.renderPage(html);
    ui.setLoading(false);
}