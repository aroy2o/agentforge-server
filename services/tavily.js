const axios = require('axios');

async function searchWeb(query) {
    const apiKey = process.env.TAVILY_API_KEY;

    // Check for missing or placeholder key
    if (!apiKey || apiKey === 'your_key_here') {
        console.warn('Tavily API key is missing or set to placeholder. Using mock results.');
        return [
            {
                title: 'Mock Search Result 1: Future of AI Systems',
                url: 'https://example.com/mock-result-1',
                snippet: 'This is a mock search result describing how artificial intelligence is shaping the future of enterprise software, focusing on multi-agent orchestrations and autonomous task pipelines.',
            },
            {
                title: 'Mock Search Result 2: Top Trends in 2025',
                url: 'https://example.com/mock-result-2',
                snippet: 'Another mock snippet explaining that 2025 is the year of local LLMs like Llama 3 running on accessible hardware, drastically reducing cloud costs while maintaining data privacy.',
            }
        ];
    }

    try {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key: apiKey,
            query: query,
            search_depth: 'basic',
            max_results: 5
        });

        // Map and simplify results
        return response.data.results.map(result => ({
            title: result.title,
            url: result.url,
            // Truncate snippet to 300 chars
            snippet: result.content.length > 300 ? result.content.substring(0, 300) + '...' : result.content
        }));
    } catch (error) {
        console.error('Tavily Search API Error:', error.message);
        // Fallback to mock results on failure
        return [
            {
                title: 'Fallback Result: Unable to Reach Search Engine',
                url: 'https://example.com/fallback',
                snippet: `The search attempt failed with error: ${error.message}. Returning fallback static data to preserve pipeline integrity.`
            }
        ];
    }
}

module.exports = {
    searchWeb
};
