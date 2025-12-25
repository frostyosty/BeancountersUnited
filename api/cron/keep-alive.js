// /api/cron/keep-alive.js
import { supabaseAdmin } from '../_db.js'; // Use our existing admin client

export default async function handler(req, res) {
    // --- Security Check ---
    // It's good practice to protect cron jobs so they can't be spammed.
    // We check for a 'cron-secret' header that Vercel can be configured to send.
    const cronSecret = process.env.CRON_SECRET;
    if (req.headers['authorization'] !== `Bearer ${cronSecret}`) {
        // Respond with 401 Unauthorized if the secret is missing or incorrect.
        return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
        // Perform a very lightweight, inexpensive read operation on the database.
        // We're just selecting the `id` from a single row in the `profiles` table.
        // This is enough to register as "activity" on the Supabase project.
        const { error } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .limit(1)
            .maybeSingle(); // .maybeSingle() prevents an error if the table is empty.

        // If there's a database error (e.g., Supabase is down for other reasons),
        // log it for debugging but don't crash the whole function.
        if (error) {
            console.error('Keep-alive cron job failed during DB query:', error.message);
            // We can still return a 200 OK to Vercel so the cron job itself is marked as "successful",
            // but we log the internal failure.
            return res.status(200).json({ status: 'error', message: `DB ping failed: ${error.message}` });
        }

        // If the query was successful, log it and return a success message.
        console.log('Keep-alive cron job ran successfully. Supabase project is active.');
        return res.status(200).json({ status: 'ok', message: 'Supabase project pinged successfully.' });

    } catch (e) {
        // Catch any other unexpected errors during execution.
        console.error('Keep-alive cron job crashed:', e.message);
        return res.status(500).json({ status: 'error', message: `Cron job crashed: ${e.message}` });
    }
}