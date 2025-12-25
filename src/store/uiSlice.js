// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    _reRenderTrigger: 0,
    activeMenuCategory: 'All',
    activeAllergenFilters: [], 
    
    // NEW: Highlight logic
    highlightOrderId: null,

    setActiveMenuCategory: (category) => {
        set((state) => ({
            ui: { ...state.ui, activeMenuCategory: category }
        }), false, 'ui/setActiveMenuCategory');
    },

    toggleAllergenFilter: (tag) => {
        set((state) => {
            const current = state.ui.activeAllergenFilters;
            const newFilters = current.includes(tag) 
                ? current.filter(t => t !== tag) 
                : [...current, tag];
            return { ui: { ...state.ui, activeAllergenFilters: newFilters } };
        });
    },

    // NEW ACTIONS
    setHighlightOrderId: (id) => set(state => ({ ui: { ...state.ui, highlightOrderId: id } })),
    
    triggerPageRender: () => {
        // console.log("%c[UiSlice] Triggering Page Render...", "color: pink; font-weight: bold;");
        set((state) => ({
            ui: { ...state.ui, _reRenderTrigger: state.ui._reRenderTrigger + 1 }
        }), false, 'ui/triggerPageRender');
    },
});