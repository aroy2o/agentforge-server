const axios = require('axios');

const BASE_URL = 'http://localhost:3001/api';

async function verifyRoutes() {
    console.log('--- AgentForge API Verification ---');
    try {
        // 1. Test /tools/calculator
        console.log('\n[1/3] Testing POST /tools/calculator');
        const calcRes = await axios.post(`${BASE_URL}/tools/calculator`, {
            expression: "100 / 4 + 15"
        });
        console.log(`Expected: 40 | Received:`, calcRes.data.result);

        // 2. Test /tools/web_search
        console.log('\n[2/3] Testing POST /tools/web_search');
        const searchRes = await axios.post(`${BASE_URL}/tools/web_search`, {
            query: "AI Orchestration 2025"
        });
        console.log(`Web search returned ${searchRes.data.results.length} items.`);

        // 3. Test /agent/run
        console.log('\n[3/3] Testing POST /agent/run');
        const agentRes = await axios.post(`${BASE_URL}/agent/run`, {
            agentName: 'Quill',
            role: 'Content Strategist',
            personality: 'Creative and audience-aware.',
            tools: ['summarizer'],
            context: 'Write a two sentence hook about why local AI is the future.',
            stepNumber: 1,
            totalSteps: 1
        });

        console.log('\nAgent Output:');
        console.log(agentRes.data.output);
        console.log('\n✅ Route API Verification Complete!');

    } catch (error) {
        if (error.response) {
            console.error('❌ API Verification Failed:', error.response.status, error.response.data);
        } else {
            console.error('❌ API Verification Failed:', error.message);
        }
    }
}

verifyRoutes();
