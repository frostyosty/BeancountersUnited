// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';

export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Use the flat store state
    const { menuItems, isMenuLoading } = useAppStore.getState();

    if (isMenuLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        return;
    }

    const menuHTML = menuItems.map(item => `<div><h3>${item.name}</h3></div>`).join('');
    mainContent.innerHTML = `<h2>Menu</h2>${menuHTML}`;
}