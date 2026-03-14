const axios = require('axios');

// Extract the first 400 characters worth of meaningful key terms from a potentially
// long reframed task prompt, to avoid Tavily rejecting oversized queries.
function buildSearchQuery(rawQuery) {
    const q = String(rawQuery || '').trim();
    if (q.length <= 400) return q;
    // Take first sentence/clause that ends with a period or newline
    const firstSentence = q.match(/^[^.\n]{20,300}[.!?]/)?.[0];
    if (firstSentence) return firstSentence.trim().slice(0, 400);
    return q.slice(0, 400);
}

async function searchWeb(query) {
    const apiKey = process.env.TAVILY_API_KEY;

    // Check for missing or placeholder key
    if (!apiKey || apiKey === 'your_key_here') {
        throw new Error('Tavily API key is missing or placeholder.');
    }

    const searchQuery = buildSearchQuery(query);

    try {
        // Use v2 Bearer token auth (required for tvly-dev- key format)
        const response = await axios.post('https://api.tavily.com/search', {
            query: searchQuery,
            search_depth: 'basic',
            max_results: 5,
        }, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });

        const mapped = (response.data.results || []).map((result) => {
            const rawContent = String(result.content || result.snippet || '');
            const snippet = rawContent.length > 300 ? rawContent.substring(0, 300) + '...' : rawContent;
            return {
                title: result.title,
                url: result.url,
                snippet,
            };
        });

        const valid = mapped.filter((result) => {
            const url = String(result.url || '').trim().toLowerCase();
            return url && !url.includes('example.com');
        });

        if (valid.length === 0) {
            throw new Error('No valid Tavily results found.');
        }

        return valid;
    } catch (error) {
        const status = error.response?.status;
        const body = error.response?.data ? JSON.stringify(error.response.data) : '';
        console.error(`Tavily Search API Error [${status || 'network'}]:`, error.message, body || '');
        throw error;
    }
}

module.exports = {
    searchWeb
};
