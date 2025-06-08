// /api/keep-alive.js
import { createClient } from '@supabase/supabase-js'; // Import directly if not using getActiveDbClient for pings

export default async function handler(req, res) {
    const { secret } = req.query;
    if (process.env.KEEP_ALIVE_SECRET && secret !== process.env.KEEP_ALIVE_SECRET) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const projectsToPing = [
        {
            name: "ProjectAlpha",
            url: process.env.SUPABASE_PROJECT_ALPHA_URL,
            anonKey: process.env.SUPABASE_PROJECT_ALPHA_ANON_KEY,
            tableName: "site_settings" // e.g., site_settings or a dedicated ping_table
        },
        {
            name: "ProjectBeta",
            url: process.env.SUPABASE_PROJECT_BETA_URL,
            anonKey: process.env.SUPABASE_PROJECT_BETA_ANON_KEY,
            tableName: "users"
        }
        // Add more projects as needed
    ];

    const results = [];
    let overallStatus = 'ok';

    for (const project of projectsToPing) {
        if (!project.url || !project.anonKey) {
            console.warn(`Keep-alive: Missing URL or Anon Key for ${project.name}`);
            results.push({ project: project.name, status: 'config_error', message: 'Missing URL/Key' });
            overallStatus = 'partial_error';
            continue;
        }

        try {
            const supabase = createClient(project.url, project.anonKey);
            const { error } = await supabase
                .from(project.tableName)
                .select('id') // or any small column
                .limit(1)
                .maybeSingle();

            if (error && error.code !== '42P01' && error.code !== 'PGRST116') { // Ignore "table not found" or "relation does not exist"
                console.error(`Keep-alive ping failed for ${project.name}:`, error);
                results.push({ project: project.name, status: 'ping_error', message: error.message });
                overallStatus = 'partial_error';
            } else {
                // console.log(`Keep-alive Supabase ping successful for ${project.name}.`);
                results.push({ project: project.name, status: 'ok' });
            }
        } catch (e) {
            console.error(`Keep-alive: Exception pinging ${project.name}:`, e);
            results.push({ project: project.name, status: 'exception', message: e.message });
            overallStatus = 'partial_error';
        }
    }

    return res.status(overallStatus === 'ok' ? 200 : 207) // 207 Multi-Status if partial errors
        .json({
            overall_status: overallStatus,
            pinged_at: new Date().toISOString(),
            details: results
        });
}