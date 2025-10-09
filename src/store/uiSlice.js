// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    // A dummy state property that we can change to force a re-render
    _reRenderTrigger: 0,
    activeMenuCategory: 'All', // The default active category

    setActiveMenuCategory: (category) => {
        set({ activeMenuCategory: category });
    },
    // This action will be called by our data slices when they finish loading.
    triggerPageRender: () => {
        set(state => ({ ui: { ...state.ui, _reRenderTrigger: state.ui._reRenderTrigger + 1 }}));
    },
});