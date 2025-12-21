import { useAppStore } from '@/store/appStore.js';

export function showToast(message, type = 'info', overrideDuration = null, onClick = null) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    let settings = {};
    try { settings = useAppStore.getState().siteSettings?.settings?.toast || {}; } catch(e) {}
    
    const duration = overrideDuration || settings.duration || 3000;
    const position = settings.position || 'bottom-center';

    // Reset styles
    container.style.left = '';
    container.style.right = '';
    container.style.top = '';
    container.style.bottom = '';
    container.style.transform = '';
    container.style.alignItems = ''; 

    // Apply Position
    if (position.includes('bottom')) { 
        container.style.bottom = '20px'; container.style.top = 'auto'; 
    } else { 
        container.style.top = '20px'; container.style.bottom = 'auto'; 
    }
    
    if (position.includes('right')) { 
        container.style.right = '20px'; container.style.alignItems = 'flex-end'; 
    } else if (position.includes('left')) { 
        container.style.left = '20px'; container.style.alignItems = 'flex-start'; 
    } else { 
        // CENTER
        container.style.left = '0'; container.style.right = '0'; container.style.alignItems = 'center'; 
        container.style.width = '100%'; container.style.pointerEvents = 'none'; 
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.pointerEvents = 'auto'; 
    
    if (onClick) {
        toast.classList.add('clickable');
        toast.addEventListener('click', () => { onClick(); toast.remove(); });
    }

    container.appendChild(toast);

    // Animation
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Auto-remove
    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            });
            // Force remove backup
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
        }
    }, duration);
}