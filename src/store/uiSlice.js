// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    // Flattened State
    _reRenderTrigger: 0,
    activeMenuCategory: 'All',

    // Actions
    setActiveMenuCategory: (category) => {
        // Notice: we update state.ui.activeMenuCategory directly, not state.ui.ui.activeMenuCategory
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