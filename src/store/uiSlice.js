// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    ui: { // <-- All state for this slice is nested under a 'ui' key
        _reRenderTrigger: 0,
        activeMenuCategory: 'All',
    },

    // Actions live at the top level of the slice
    setActiveMenuCategory: (category) => {
        set((state) => ({
            ui: { ...state.ui, activeMenuCategory: category }
        }), false, 'ui/setActiveMenuCategory');
    },

    triggerPageRender: () => {
        set((state) => ({
            ui: { ...state.ui, _reRenderTrigger: state.ui._reRenderTrigger + 1 }
        }), false, 'ui/triggerPageRender');
    },
});