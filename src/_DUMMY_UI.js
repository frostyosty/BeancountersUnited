// /src/_DUMMY_UI.js - A temporary file for debugging imports.

// This file exports empty functions with all the names main.js needs.

export function renderMenuPage() {
    console.log("[DUMMY] renderMenuPage called.");
    document.getElementById('main-content').innerHTML = `<h2>Menu (Dummy)</h2>`;
}
export function renderCartPage() {
    console.log("[DUMMY] renderCartPage called.");
    document.getElementById('main-content').innerHTML = `<h2>Cart (Dummy)</h2>`;
}
export function renderCheckoutPage() {}
export function renderAuthStatus() {
    console.log("[DUMMY] renderAuthStatus called.");
    document.getElementById('auth-status-container').innerHTML = `<span>Auth (Dummy)</span>`;
}
export function showLoginSignupModal() {}
export function renderOwnerDashboard() {}
export function renderManagerDashboard() {}
export function initializeImpersonationToolbar() {}