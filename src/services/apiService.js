// src/services/apiService.js

async function request(endpoint, method = 'GET', body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const config = { method, headers };
    if (body) {
        config.body = JSON.stringify(body);
    }
    try {
        const response = await fetch(`/api${endpoint}`, config);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(errorData.message || `API request failed with status ${response.status}`);
        }
        if (response.status === 204) return null;
        return await response.json();
    } catch (error) {
        console.error(`API Error for ${method} ${endpoint}:`, error);
        throw error;
    }
}

// --- Menu API Functions ---
export const getMenu = () => request('/menu');


export const getOrderHistory = (token) => request('/user/orders', 'GET', null, token);

// --- User Profile API Functions ---
export const getUserProfile = (token) => request('/user/profile', 'GET', null, token);

// --- AUTH API FUNCTIONS ---
// These call OUR backend, not Supabase directly.
export const loginViaApi = (email, password) => request('/auth/login', 'POST', { email, password });
export const signUpViaApi = (email, password) => request('/auth/signup', 'POST', { email, password });


export const listAllUsers = (token) => request('/user/manage', 'GET', null, token);
export const updateUser = (userId, newRole, isVerifiedBuyer, canSeeOrderHistory, token) => {
    return request('/user/manage', 'PUT', { userId, newRole, isVerifiedBuyer, canSeeOrderHistory }, token);
};

export const addMenuItem = (itemData, token) => request('/menu', 'POST', itemData, token);
export const updateMenuItem = (itemId, itemData, token) => request(`/menu?id=${itemId}`, 'PUT', itemData, token);
export const deleteMenuItem = (itemId, token) => request(`/menu?id=${itemId}`, 'DELETE', null, token);

// --- Settings API Functions ---
// Anyone can read the settings
export const getSiteSettings = () => request('/settings', 'GET');

// Only authenticated users (owners/managers) can update settings
export const updateSiteSettings = (settingsData, token) => request('/settings', 'PUT', settingsData, token);