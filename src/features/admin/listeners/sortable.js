import Sortable from 'sortablejs';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';

export function initializeSortable() {
    const list = document.getElementById('category-list');
    if (list && list.dataset.sortableInitialized !== 'true') {
        new Sortable(list, { 
            animation: 150, 
            handle: '.drag-handle-wrapper', 
            onEnd: async (evt) => {
                const items = Array.from(list.children);
                const newOrder = items.map(li => li.dataset.categoryName);
                const { data: { session } } = await supabase.auth.getSession();
                await api.updateSiteSettings({ menuCategories: newOrder }, session.access_token);
            }
        });
        list.dataset.sortableInitialized = 'true';
    }
    
    const tabList = document.getElementById('tab-sort-list');
    if (tabList && tabList.dataset.sortableInitialized !== 'true') {
        new Sortable(tabList, { animation: 150 });
        tabList.dataset.sortableInitialized = 'true';
    }
}