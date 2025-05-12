// api/_db.js
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient as createTursoClient } from '@libsql/client';

let supabase;
let turso;

// This function will decide which DB client to return
// It needs to know the "active" database, e.g., from an environment variable or a setting.
// For simplicity, we'll rely on environment variables set in Vercel.
// You would have SUPABASE_URL, SUPABASE_SERVICE_KEY for Supabase
// And TURSO_DATABASE_URL, TURSO_AUTH_TOKEN for Turso

function getSupabaseAdminClient() {
    if (!supabase) {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
            console.error('Supabase environment variables (URL & SERVICE_KEY) are not set.');
            // In a real scenario, you might throw an error or handle this more gracefully.
            // For now, returning null will cause subsequent operations to fail, indicating a config issue.
            return null;
        }
        supabase = createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    return supabase;
}

function getTursoClient() {
    if (!turso) {
         if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
            console.error('Turso environment variables (DATABASE_URL & AUTH_TOKEN) are not set.');
            return null;
        }
        turso = createTursoClient({
            url: process.env.TURSO_DATABASE_URL,
            authToken: process.env.TURSO_AUTH_TOKEN,
        });
    }
    return turso;
}

// Function to get the currently active DB client
// The manager UI switch would update this environment variable (requiring a Vercel redeploy)
// Or, it updates a setting in a small primary DB (e.g. Vercel KV or another Supabase table) that these functions read.
// For this example, let's assume ACTIVE_DB_PROVIDER is an env var.
async function getActiveDbClient() {
    const provider = process.env.ACTIVE_DB_PROVIDER || 'supabase'; // Default to Supabase

    if (provider === 'supabase') {
        const client = getSupabaseAdminClient();
        if (!client) throw new Error("Supabase client not initialized. Check config.");
        return { client, type: 'supabase' };
    } else if (provider === 'turso') {
        const client = getTursoClient();
        if (!client) throw new Error("Turso client not initialized. Check config.");
        // You'll need to adapt queries for Turso (SQLite syntax) and how it handles things like 'returning'
        return { client, type: 'turso' };
    } else {
        throw new Error(`Unsupported DB provider: ${provider}`);
    }
}

// Helper to verify JWT and get user (for Supabase)
async function getUserFromRequest(req) {
    if (!req.headers.authorization) return null;
    const token = req.headers.authorization.split(' ')[1];
    if (!token) return null;

    const sbAdmin = getSupabaseAdminClient(); // Use Supabase for auth even if primary DB is Turso for data
    if (!sbAdmin) {
        console.error("Supabase client (for auth) not available.");
        return null;
    }
    
    const { data: { user }, error } = await sbAdmin.auth.getUser(token);
    if (error) {
        console.warn('Auth error:', error.message);
        return null;
    }
    return user;
}

// Helper to get user profile with role
async function getUserProfile(userId) {
    // Profiles are always in Supabase for this example for simplicity, even if Turso is data DB
    const sbAdmin = getSupabaseAdminClient();
    if (!sbAdmin) throw new Error("Supabase client for profiles not available");

    const { data, error } = await sbAdmin
        .from('profiles') // Assuming you have a 'profiles' table
        .select('id, role, full_name, email') // email can come from auth.users as well
        .eq('id', userId)
        .single();
    if (error) throw error;
    return data;
}


export { getActiveDbClient, getUserFromRequest, getUserProfile, getSupabaseAdminClient };