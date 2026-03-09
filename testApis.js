require('dotenv').config();
const { searchWeb } = require('./services/tavily');

async function runTests() {
    console.log('Testing Tavily Web Search (Mock Fallback)...');

    const results = await searchWeb('AI 2025');

    console.log('\n--- SEARCH RESULTS ---');
    console.log(JSON.stringify(results, null, 2));
    console.log('----------------------\n');

    if (results.length > 0 && results[0].title.includes('Mock')) {
        console.log('✅ Mock fallback successfully engaged.');
    } else if (results.length > 0) {
        console.log('✅ Live API successfully engaged.');
    } else {
        console.error('❌ Search returned an empty array.');
    }
}

runTests();
