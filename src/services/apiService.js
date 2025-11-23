// src/services/apiService.js
console.log("--- [2] apiService.js: START ---");

async function request(endpoint, method = 'GET', body = null, token = null) { 
    // ... (Your existing request function logic remains exactly the same) ...
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    try {
        // Note: endpoint already contains the query params
        const response = await fetch(`/api${endpoint}`, config);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(errorData.message || `API request failed`);
        }
        if (response.status === 204) return null;
        return await response.json();
    } catch (error) {
        console.error(`Request failed: ${endpoint}`, error);
        throw error;
    }
}

// --- UPDATED AUTH & USER FUNCTIONS ---

// 1. Auth (Uses /api/auth?type=...)
export const loginViaApi = (email, password) => request('/auth?type=login', 'POST', { email, password });
export const signUpViaApi = (email, password) => request('/auth?type=signup', 'POST', { email, password });

// 2. User Basics (Uses /api/user?type=...)
export const getUserProfile = (token) => request('/user?type=profile', 'GET', null, token);
export const getOrderHistory = (token) => request('/user?type=orders', 'GET', null, token);

// 3. Admin User Management (Uses /api/user?type=manage)
export const listAllUsers = (token) => request('/user?type=manage', 'GET', null, token);
export const updateUser = (userId, newRole, isVerifiedBuyer, canSeeOrderHistory, token) => {
    return request('/user?type=manage', 'PUT', { userId, newRole, isVerifiedBuyer, canSeeOrderHistory }, token);
};

// 4. CRM (Uses /api/user?type=crm)
export const getCustomerDetails = (userId, token) => 
    request(`/user?type=crm&userId=${userId}`, 'GET', null, token);

export const updateCustomerDetails = (data, token) => 
    request('/user?type=crm', 'POST', data, token);


// --- OTHER FUNCTIONS (UNCHANGED) ---
export const getMenu = () => request('/menu');
export const addMenuItem = (itemData, token) => request('/menu', 'POST', itemData, token);
export const updateMenuItem = (itemId, itemData, token) => request(`/menu?id=${itemId}`, 'PUT', itemData, token);
export const deleteMenuItem = (itemId, token) => request(`/menu?id=${itemId}`, 'DELETE', null, token);
export const updateSiteSettings = (settingsData, token) => request('/settings', 'PUT', settingsData, token);
export const getSiteSettings = () => request('/settings', 'GET');
export const createManualOrder = (orderData, token) => request('/manual-order', 'POST', orderData, token);

console.log("--- [2] apiService.js: END ---");