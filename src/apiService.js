// src/apiService.js

// Import Supabase client ONLY if it's needed here for token,
// otherwise rely on it being initialized before this module's functions are called
// by auth.js or main.js where token is typically retrieved.
// For now, let's assume `supabase` instance is available globally for auth token,
// or better, it's passed or auth module provides a token getter.
// A cleaner way is to have an auth module that provides the token.

// Assuming supabase is initialized elsewhere and accessible (e.g., from supabaseClient.js and then auth.js)
// If supabase is imported here, ensure it's the SAME instance.
import { supabase } from './supabaseClient.js'; // Ensure this is correctly set up

/**
 * Generic request handler for API calls.
 * @param {string} endpoint - The API endpoint (e.g., '/menu', '/orders').
 * @param {string} [method='GET'] - HTTP method.
 * @param {object|null} [body=null] - Request body for POST, PUT.
 * @param {boolean} [requireAuth=false] - Whether to include Authorization header.
 * @returns {Promise<any>} - The JSON response from the API.
 * @throws {Error} - Throws an error if the request fails or returns a non-ok status.
 */
async function request(endpoint, method = 'GET', body = null, requireAuth = false) {
    const headers = {
        'Content-Type': 'application/json',
        // You can add other default headers here if needed
    };

    if (requireAuth) {
        if (!supabase) {
            console.error("API Request: Supabase client not available for obtaining auth token.");
            throw new Error("Authentication client not initialized.");
        }
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.access_token) {
                headers['Authorization'] = `Bearer ${session.access_token}`;
            } else if (requireAuth) { // If auth is strictly required and no token
                console.error("API Request: Auth token required but not found or session expired.");
                // Potentially trigger a login UI or redirect. For now, throw.
                // This could also be a place to attempt a token refresh if your setup allows.
                throw new Error("Authentication required, but no valid session found.");
            }
        } catch (authError) {
            console.error("API Request: Error getting auth session for API call:", authError);
            throw new Error("Failed to get authentication details for API request.");
        }
    }

    const config = {
        method: method,
        headers: headers,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        config.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(`/api${endpoint}`, config); // Prepends /api for Vercel functions

        if (!response.ok) {
            let errorData;
            try {
                errorData = await response.json();
            } catch (e) {
                // If response is not JSON, use status text
                errorData = { message: response.statusText || `HTTP error! Status: ${response.status}` };
            }
            // Construct a more informative error message
            const errorMessage = errorData.message || `API request to ${endpoint} failed with status ${response.status}`;
            console.error(`API Error for ${method} ${endpoint}:`, response.status, errorData);
            const error = new Error(errorMessage);
            error.status = response.status; // Attach status to error object
            error.data = errorData;       // Attach full error data if available
            throw error;
        }

        // Handle cases with no content in response body (e.g., 204 No Content for DELETE)
        if (response.status === 204 || response.headers.get("content-length") === "0") {
            return null;
        }

        return await response.json(); // Parse and return JSON data

    } catch (error) {
        // Log errors that are not HTTP errors from response.ok check (e.g., network issues)
        if (!error.status) { // if status isn't set, it's likely not from the !response.ok block
          console.error(`Network or unexpected error during API call to ${endpoint}:`, error);
        }
        // Re-throw the error so the calling function can handle it
        throw error;
    }
}

// --- Menu API Functions ---
export const getMenu = () => request('/menu', 'GET');
export const addMenuItem = (itemData) => request('/menu', 'POST', itemData, true); // Requires auth
export const updateMenuItem = (itemId, itemData) => request(`/menu?itemId=${itemId}`, 'PUT', itemData, true); // Requires auth. Pass itemId as query param
export const deleteMenuItem = (itemId) => request(`/menu?itemId=${itemId}`, 'DELETE', null, true); // Requires auth

// --- Order API Functions ---
export const submitOrder = (orderData) => request('/orders', 'POST', orderData, orderData.totalAmount > 10); // Auth required if order > $10 (handled by server, but client can know)
export const getOrders = () => request('/orders', 'GET', null, true); // Owner/manager only, requires auth

// --- Settings API Functions ---
export const getSiteSettings = () => request('/settings', 'GET');
export const updateSiteSettings = (settings) => request('/settings', 'PUT', settings, true); // Manager/Owner only, requires auth

// --- User Profile API Functions ---
export const getUserProfile = () => request('/user/profile', 'GET', null, true); // Requires auth
export const updateUserProfile = (profileData) => request('/user/profile', 'PUT', profileData, true); // Requires auth

// Example of a function that might be added for image uploads to API, though direct client-to-storage is often better
// export const uploadImageToApi = (formData) => {
//     // Special handling for FormData, don't set Content-Type header manually
//     // (browser will set it to multipart/form-data with correct boundary)
//     const headers = {};
//     if (auth.isAuthenticated()) { // Hypothetical auth check
//         headers['Authorization'] = `Bearer ${auth.getToken()}`;
//     }
//     return fetch('/api/upload-image-endpoint', { // Some dedicated endpoint
//         method: 'POST',
//         headers: headers, // Only auth header
//         body: formData,
//     }).then(response => {
//         if (!response.ok) throw new Error('Image upload failed');
//         return response.json();
//     });
// };

// You could also export all functions as a default object:
// export default {
//   getMenu,
//   addMenuItem,
//   // ...etc.
// };
// Then import in main.js as: import api from './apiService.js'; api.getMenu();