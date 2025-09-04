// /api/auth/login.js
import { supabaseAdmin } from '../_db.js'; // Use our admin client

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end('Method Not Allowed');
    }

    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        console.log(`[API /auth/login] Attempting login for: ${email}`);

        // --- THE KEY ---
        // We use the admin client to perform the sign-in.
        // This bypasses the faulty 'authenticator' role.
        const { data, error } = await supabaseAdmin.auth.signInWithPassword({
            email: email,
            password: password,
        });

        if (error) {
            console.error(`[API /auth/login] Supabase login error for ${email}:`, error.message);
            // Don't leak detailed error messages. "Invalid credentials" is safer.
            return res.status(401).json({ error: 'Invalid login credentials.' });
        }

        if (data.session) {
            console.log(`[API /auth/login] Login successful for: ${email}`);
            // On success, return the full session data to the client.
            return res.status(200).json(data);
        } else {
            // This case is unlikely if there's no error, but good to handle.
            return res.status(500).json({ error: 'Login succeeded but no session was returned.' });
        }

    } catch (e) {
        console.error("[API /auth/login] CRITICAL ERROR:", e);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
}