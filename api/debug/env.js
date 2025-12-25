// /api/debug/env.js

export default function handler(req, res) {
    // SECURITY: Protect this endpoint with a secret
    const { secret } = req.query;
    if (secret !== process.env.DEBUG_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    // Read the exact variables your backend functions are trying to use.
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    // Also check for the VITE_ prefixed versions for comparison
    const viteSupabaseUrl = process.env.VITE_SUPABASE_URL;

    res.status(200).json({
        message: "This is the environment your Vercel Function sees.",
        NODE_ENV: process.env.NODE_ENV,
        VERCEL_ENV: process.env.VERCEL_ENV,
        SUPABASE_URL: {
            value: supabaseUrl,
            isDefined: !!supabaseUrl,
            length: supabaseUrl?.length || 0,
        },
        SUPABASE_SERVICE_KEY: {
            isDefined: !!serviceKey,
            // We'll only show the first few and last few characters for security
            preview: serviceKey ? `${serviceKey.substring(0, 4)}...${serviceKey.substring(serviceKey.length - 4)}` : "Not Defined",
            length: serviceKey?.length || 0,
        },
        // Check this just in case
        VITE_SUPABASE_URL: {
            isDefined: !!viteSupabaseUrl,
            value: viteSupabaseUrl,
        }
    });
}