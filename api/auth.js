// /api/auth/login.js
import { supabaseAdmin } from './_db.js';

export default async function handler(req, res) {
    console.log("--- [API /auth/login] Handler started ---");
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end('Method Not Allowed');
    }

    try {
        const { email, password } = req.body;
        console.log(`[API /auth/login] Received request for email: ${email}`);

        if (!email || !password) {
            console.log("[API /auth/login] Missing email or password. Sending 400.");
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        console.log("[API /auth/login] Calling supabaseAdmin.auth.signInWithPassword...");
        const { data, error } = await supabaseAdmin.auth.signInWithPassword({
            email: email,
            password: password,
        });

        // Log the raw response from the admin sign-in call
        console.log("[API /auth/login] Supabase response received.");
        console.log("[API /auth/login] Error object:", error);
        console.log("[API /auth/login] Data object:", data ? { session: !!data.session, user: !!data.user } : null);

        if (error) {
            console.error(`[API /auth/login] Supabase login returned an error for ${email}:`, error.message);
            return res.status(401).json({ error: `Supabase Auth Error: ${error.message}` });
        }

        if (data.session) {
            console.log(`[API /auth/login] Login successful. Returning session data.`);
            return res.status(200).json(data);
        } else {
            console.error("[API /auth/login] Login succeeded but no session was returned.");
            return res.status(500).json({ error: 'Login succeeded but no session was returned.' });
        }

    } catch (e) {
        console.error("[API /auth/login] CRITICAL ERROR in try/catch block:", e);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
}