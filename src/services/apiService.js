// src/services/apiService.js
import { supabase } from '@/supabaseClient.js';

/**
 * Generic request handler for API calls.
 * This version is "pure" - it only gets the session token when it's needed.
 * @param {string} endpoint - The API endpoint (e.g., '/menu').
 * @param {string} [method='GET'] - HTTP method.
 * @param {object|null} [body=null] - Request body for POST, PUT.
 * @returns {Promise<any>} - The JSON response from the API.
 */
async function request(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };

    // Get the session token INSIDE the function, right before the request.
    // This avoids top-level await and ensures we always have the freshest token.
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
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

// --- User Profile API Functions ---
export const getUserProfile = () => request('/user/profile');

// --- Add other API functions here as we build them ---
// export const addMenuItem = (itemData) => request('/menu', 'POST', itemData);
// export const updateMenuItem = (itemId, itemData) => request(`/menu?id=${itemId}`, 'PUT', itemData);
// export const deleteMenuItem = (itemId) => request(`/menu?id=${itemId}`, 'DELETE');
// export const submitOrder = (orderData) => request('/orders', 'POST', orderData);
// export const getSiteSettings = () => request('/settings', 'GET');