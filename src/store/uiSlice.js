// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    _reRenderTrigger: 0,
    activeMenuCategory: 'All',

    setActiveMenuCategory: (category) => {
        // Correctly updates the top-level property
        set({ activeMenuCategory: category }, false, 'ui/setActiveMenuCategory');
    },

    triggerPageRender: () => {
        // --- THIS IS THE FIX ---
        // It now correctly updates the top-level _reRenderTrigger property.
        set((state) => ({ _reRenderTrigger: state._reRenderTrigger + 1 }), false, 'ui/triggerPageRender');
        // --- END OF FIX ---
    },
});