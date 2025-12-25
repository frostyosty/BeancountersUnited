export function showModal(htmlContent) {
    closeModal(); 

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'modal-overlay'; 
    modalOverlay.className = 'modal-overlay';
    
    modalOverlay.innerHTML = `
        <div class="modal-content">
            <button class="modal-close-btn" aria-label="Close">&times;</button>
            ${htmlContent}
        </div>
    `;

    document.body.appendChild(modalOverlay);

    modalOverlay.querySelector('.modal-close-btn').addEventListener('click', closeModal);
    
    // Prevent closing if dragging text
    let isMouseDownOnOverlay = false;
    modalOverlay.addEventListener('mousedown', (e) => {
        if (e.target === modalOverlay) isMouseDownOnOverlay = true;
        else isMouseDownOnOverlay = false;
    });

    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay && isMouseDownOnOverlay) closeModal();
        isMouseDownOnOverlay = false;
    });
}

export function closeModal() {
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay) {
        modalOverlay.classList.add('fade-out');
        modalOverlay.remove();
    }
}

export function showGuestNameModal(onConfirm) {
    const modalHTML = `
        <div class="modal-form-container" style="max-width:400px; text-align:center;">
            <h3>Start Guest Order</h3>
            <p>Please enter a name for the barista to call out.</p>
            <form id="guest-name-form">
                <input type="text" id="guest-name-input" placeholder="Your Name" required 
                       style="width:100%; padding:12px; font-size:1.1rem; border:1px solid #ccc; border-radius:6px; margin-bottom:20px; text-align:center;">
                <button type="submit" class="button-primary" style="width:100%;">Continue</button>
            </form>
        </div>
    `;
    
    showModal(modalHTML);
    setTimeout(() => document.getElementById('guest-name-input')?.focus(), 100);

    document.getElementById('guest-name-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('guest-name-input').value.trim();
        if (name) {
            closeModal();
            onConfirm(name);
        }
    });
}