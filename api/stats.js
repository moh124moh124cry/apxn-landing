export default async function handler(req, res) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/users?select=country`, {
            headers: {
                'apikey': SUPABASE_SECRET_KEY,
                'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`
            }
        });

        const data = await response.json();
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load data' });
    }
}
