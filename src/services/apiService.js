// src/services/apiService.js
import { supabase } from '@/supabaseClient.js'; // We'll need this for authenticated requests later

/**
 * A generic request handler for API calls.
 * (For now, a simplified version. We can expand it later).
 * @param {string} endpoint - The API endpoint (e.g., '/menu').
 * @returns {Promise<any>} - The JSON response from the API.
 */
async function request(endpoint) {
    try {
        const response = await fetch(`/api${endpoint}`);
        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`API Error for GET ${endpoint}:`, error);
        throw error; // Re-throw so the caller (e.g., the store slice) can handle it
    }
}

// --- Menu API Functions ---
export const getMenu = () => request('/menu');

// We'll add more API functions here later (submitOrder, updateMenuItem, etc.)