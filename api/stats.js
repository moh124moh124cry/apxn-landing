export default async function handler(req, res) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
        return res.status(500).json({ error: 'Missing environment variables' });
    }

    try {
        const apiURL = `${SUPABASE_URL}/rest/v1/visits?select=country`;
        const response = await fetch(apiURL, {
            method: 'GET',
            headers: {
                'apikey': SUPABASE_SECRET_KEY,
                'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Supabase error: ${errText}`);
        }

        const data = await response.json();
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
