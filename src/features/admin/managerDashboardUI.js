// api/auth.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // We use a query param '?type=...' to decide what to do
    const { type } = req.query;
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
        
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ error: error.message });
        return res.status(200).json({ session: data.session });
    }

    // Handle SIGNUP
    if (type === 'signup') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        // Use Service Key for signup to auto-confirm users (if enabled) or just standard flow
        // Using Anon key here to mimic standard client-side signup behavior
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        const { email, password } = req.body;

        const { data, error } = await supabase.auth.signUp({ email, password });
        
        if (error) return res.status(400).json({ error: error.message });
        
        // Create Profile Entry (if trigger doesn't exist, do it manually here)
        if (data.user) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
            await supabaseAdmin.from('profiles').insert([{ id: data.user.id, email: email, role: 'customer' }]);
        }
        return res.status(200).json({ user: data.user });
    }

    return res.status(400).json({ error: "Invalid auth type requested." });
}