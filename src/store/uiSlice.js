// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    _reRenderTrigger: 0,
    activeMenuCategory: 'All',
    // NEW: Allergen Filters
    activeAllergenFilters: [], 

    setActiveMenuCategory: (category) => {
        set((state) => ({
            ui: { ...state.ui, activeMenuCategory: category }
        }), false, 'ui/setActiveMenuCategory');
    },

    // NEW: Toggle Allergen Filter
    toggleAllergenFilter: (tag) => {
        set((state) => {
            const current = state.ui.activeAllergenFilters;
            const newFilters = current.includes(tag) 
                ? current.filter(t => t !== tag) // Remove if exists
                : [...current, tag]; // Add if missing
            
            return { ui: { ...state.ui, activeAllergenFilters: newFilters } };
        });
    },

    triggerPageRender: () => {
        console.log("%c[UiSlice] Triggering Page Render...", "color: pink; font-weight: bold;");
        set((state) => ({
            ui: { ...state.ui, _reRenderTrigger: state.ui._reRenderTrigger + 1 }
        }), false, 'ui/triggerPageRender');
    },
});