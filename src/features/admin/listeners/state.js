export let currentSort = { column: 'category', direction: 'asc' };

// 1. UPDATE STATE
export let adminState = {
    activeTab: 'active_orders',
    layout: [
        { id: 'active_orders', label: 'Live Orders', hidden: false },
        { id: 'clients', label: 'Clients', hidden: false },
        { id: 'menu', label: 'Menu Items', hidden: false },
        { id: 'operations', label: 'Store Operations', hidden: false }, // NEW
        { id: 'history', label: 'Site History', hidden: false },        // NEW
        { id: 'categories', label: 'Categories', hidden: false },
        { id: 'header', label: 'Header', hidden: false },
        { id: 'appearance', label: 'Appearance', hidden: false },
        { id: 'global', label: 'Settings', hidden: false },
    ],
    tabPosition: 'top',
    tabsEnabled: true
};