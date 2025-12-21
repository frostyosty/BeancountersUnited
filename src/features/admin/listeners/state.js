export let currentSort = { column: 'category', direction: 'asc' };

export let adminState = {
    activeTab: 'active_orders',
    layout: [
        { id: 'active_orders', label: 'Live Orders', hidden: false },
        { id: 'clients', label: 'Clients', hidden: false },
        { id: 'menu', label: 'Menu Items', hidden: false },
        { id: 'categories', label: 'Categories', hidden: false },
        { id: 'header', label: 'Header', hidden: false },
        { id: 'appearance', label: 'Appearance', hidden: false },
        { id: 'global', label: 'Settings', hidden: false },
    ],
    tabPosition: 'top',
    tabsEnabled: true
};