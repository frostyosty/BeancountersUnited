// api/auth.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const { type } = req.query;
    
    // DEBUG: Log the type clearly
    console.log(`--- [API Auth] Handling Request: ${type?.toUpperCase()} ---`);

    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
        return res.status(500).json({ error: "Server Config Error" });
    }

    // Handle LOGIN
    if (type === 'login') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        const { email, password } = req.body;
        
        console.log(`[API Auth] Attempting login for: ${email}`);
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        
        if (error) {
            console.error("[API Auth] Login Error:", error.message);
            return res.status(401).json({ error: error.message });
        }
        return res.status(200).json({ session: data.session });
    }

    // Handle SIGNUP
    if (type === 'signup') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        const { email, password } = req.body;

        console.log(`[API Auth] Attempting signup for: ${email}`);
        const { data, error } = await supabase.auth.signUp({ email, password });
        
        if (error) {
            console.error("[API Auth] Signup Error:", error.message);
            return res.status(400).json({ error: error.message });
        }
        
        // Auto-create Profile
        if (data.user) {
            console.log(`[API Auth] Creating profile for ${data.user.id}`);
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
            await supabaseAdmin.from('profiles').insert([{ 
                id: data.user.id, 
                email: email, 
                role: 'customer',
                full_name: email.split('@')[0] // Default name
            }]);
        }
        return res.status(200).json({ user: data.user });
    }

    return res.status(400).json({ error: "Invalid auth type requested." });
}