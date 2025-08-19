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


/**
 * Displays a modal with the provided HTML content.
 * @param {string} htmlContent - HTML to render inside the modal.
 */
export function showModal(htmlContent) {
    // Remove any existing modal first
    closeModal();

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'modal-overlay';
    modalOverlay.className = 'modal-overlay';

    modalOverlay.innerHTML = `
        <div class="modal-content">
            <button id="modal-close-btn" class="modal-close-btn">&times;</button>
            <div id="modal-body">${htmlContent}</div>
        </div>
    `;

    document.body.appendChild(modalOverlay);
    document.body.style.overflow = 'hidden'; // Prevent background scrolling

    // Add event listeners
    const closeBtn = document.getElementById('modal-close-btn');
    closeBtn.addEventListener('click', closeModal);

    modalOverlay.addEventListener('click', (event) => {
        // Close if the click is on the overlay itself, not the content
        if (event.target === modalOverlay) {
            closeModal();
        }
    });
}

/**
 * Closes the currently open modal.
 */
export function closeModal() {
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay) {
        modalOverlay.remove();
    }
    document.body.style.overflow = 'auto'; // Restore scrolling
}