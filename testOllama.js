require('dotenv').config();
const { callOllama, checkOllamaHealth } = require('./services/ollama');

async function runTest() {
    console.log('Testing Ollama Health...');
    const isHealthy = await checkOllamaHealth();
    console.log(`Ollama Health Status: ${isHealthy ? 'OK' : 'FAIL'}`);

    if (!isHealthy) {
        console.error('Ollama is not responding at ' + process.env.OLLAMA_BASE_URL);
        console.error('Make sure you have Ollama installed and running (e.g. `ollama serve`)');
        return;
    }

    console.log('\nTesting full completion...');
    try {
        const response = await callOllama({
            systemPrompt: 'You are a helpful AI assistant.',
            userMessage: 'Describe Green Dukan in 200 words',
            stream: false
        });

        console.log('\n--- OLLAMA RESPONSE ---');
        console.log(response);
        console.log('-----------------------\n');
        console.log('Test successful!');
    } catch (error) {
        console.error('Test failed:', error.message);
    }
}

runTest();
