// src/features/static/staticUI.js
import * as uiUtils from '@/utils/uiUtils.js';

export function renderStaticSite() {
    const app = document.getElementById('app');
    
    // 1. Try to get cached menu, or fallback to empty
    let menuItems = [];
    try {
        const cached = localStorage.getItem('backup_menu_items');
        menuItems = cached ? JSON.parse(cached) : [];
    } catch(e) { console.error("Static load error", e); }

    // 2. Apply Static Class
    document.body.classList.add('static-mode');
    
    // 3. Render Simplified HTML
    const itemsHTML = menuItems.map(item => `
        <div class="menu-item-card" style="padding:15px; margin-bottom:15px; display:flex; gap:15px; align-items:start;">
            <div style="flex:1;">
                <h3 style="margin:0 0 5px 0;">${item.name}</h3>
                <p style="margin:0; font-size:0.9rem;">${item.description || ''}</p>
                <p style="font-weight:bold; margin-top:5px;">$${parseFloat(item.price).toFixed(2)}</p>
            </div>
            ${item.image_url ? `<img src="${item.image_url}" style="width:80px; height:80px; object-fit:cover; border:1px solid #000;">` : ''}
        </div>
    `).join('');

    app.innerHTML = `
        <div class="static-notice">Read-Only Mode • In-Store Ordering Only</div>
        <header id="main-header" style="padding: 20px; text-align:center;">
            <h1 style="margin:0; font-size:2rem;">MENU</h1>
        </header>
        <main id="main-content" style="max-width:800px; margin:0 auto; padding:20px;">
            <div class="static-menu-grid">
                ${itemsHTML.length ? itemsHTML : '<p>Menu currently unavailable.</p>'}
            </div>
            
            <div style="margin-top:50px; text-align:center; border-top:1px solid #000; padding-top:20px;">
                <p>Please order at the counter.</p>
                <a href="/?mode=admin" style="color:#ccc; text-decoration:none; font-size:0.7rem;">Admin Login</a>
            </div>
        </main>
    `;
}