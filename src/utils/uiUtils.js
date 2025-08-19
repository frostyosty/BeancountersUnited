// src/utils/uiUtils.js

/**
 * Displays a short-lived notification message (a "toast").
 * @param {string} message - The message to display.
 * @param {string} [type='info'] - The type of toast ('info', 'success', 'error').
 * @param {number} [duration=3000] - How long to display the toast in milliseconds.
 */
export function showToast(message, type = 'info', duration = 3000) {
    // Check if a toast container exists, if not, create it.
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    // Animate in
    setTimeout(() => {
        toast.classList.add('show');
    }, 100); // Small delay to allow CSS transition

    // Set timeout to remove the toast
    setTimeout(() => {
        toast.classList.remove('show');
        // Remove the element from DOM after transition ends
        toast.addEventListener('transitionend', () => {
            toast.remove();
        });
    }, duration);
}

// We will add more UI utilities here later, like showModal, setLoading, etc.