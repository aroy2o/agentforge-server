const axios = require('axios');
const { defaultAgents } = require('../agentforge-client/src/constants/defaultAgents.js');

const TOOLS = {
    web_search: { name: 'Web Search', url: '/api/tools/web_search' },
    calculator: { name: 'Calculator', url: '/api/tools/calculate' },
    todo: { name: 'Todo Planner', url: '/api/tools/todo' },
    email_draft: { name: 'Email Drafter', url: '/api/tools/email_draft' },
    summarizer: { name: 'Summarizer', url: '/api/tools/summarize' },
    scheduler: { name: 'Scheduler', url: '/api/tools/scheduler' }
};

const BASE_URL = 'http://localhost:3001';

function generateAgentInstruction(agent, taskGoal, stepIndex, totalSteps, previousOutputs) {
    if (stepIndex === 0) return taskGoal;
    const last = previousOutputs[previousOutputs.length - 1];
    const prevContext = last ? last.output.substring(0, 1000) : '';
    const tools = agent.tools || [];
    const contextBlock = `--- PREVIOUS AGENT OUTPUT (${last?.agentName || 'Previous Agent'}) ---\n${prevContext}\n---`;

    if (tools.includes('email_draft') && !tools.includes('web_search')) {
        return `${contextBlock}\n\nYour task: Write a professional email using the research above. Do NOT search for anything — the research is already complete. Focus entirely on writing a clear, compelling, ready-to-send email.`;
    }
    if (tools.includes('todo') && !tools.includes('web_search')) {
        return `${contextBlock}\n\nYour task: Create a detailed, actionable plan or to-do list based on the work above. Do NOT search for anything. Convert the findings into clear, prioritized action items.`;
    }
    if (tools.includes('summarizer') && !tools.includes('web_search') && !tools.includes('calculator') && !tools.includes('email_draft') && !tools.includes('todo')) {
        return `${contextBlock}\n\nYour task: Summarize and synthesize the information above into clear, concise key points. Distill the most important insights.`;
    }
    if (tools.includes('calculator')) {
        return `${contextBlock}\n\nYour task: Analyze the numerical data above and perform any relevant calculations needed to deliver insight. Show your methodology.`;
    }
    return `${contextBlock}\n\nYour task: Continue from where the previous agent left off. Apply your full expertise as ${agent.role}. Original goal for reference: ${taskGoal}`;
}

async function runPipeline(agentNames, taskGoal) {
    console.log(`\n======================================================`);
    console.log(`TEST RUN: ${agentNames.join(' -> ')}`);
    console.log(`TASK: ${taskGoal}`);
    console.log(`======================================================\n`);

    const pipeline = agentNames.map(name => defaultAgents.find(a => a.name === name));

    console.log(`[SYSTEM] Pipeline initiated — ${pipeline.length} agents — Goal: ${taskGoal.substring(0, 80)}...`);

    let contextHistory = [];
    let fullFinalOutput = "TASK: " + taskGoal;

    for (let i = 0; i < pipeline.length; i++) {
        const agent = pipeline[i];
        console.log(`[ACTION] Agent ${agent.name} — ${agent.role} — Step ${i + 1} of ${pipeline.length}`);
        console.log(`[THINKING] Analyzing task context and preparing ${agent.role} perspective...`);

        let agentInstruction = generateAgentInstruction(agent, taskGoal, i, pipeline.length, contextHistory);
        let agentContext = agentInstruction;

        if (i === 0 && contextHistory.length > 0) {
            const recentHistory = contextHistory.slice(-2);
            agentContext += `\n\nRECENT ACTIVITY:\n` + recentHistory.map(entry => {
                let out = entry.output;
                if (out.length > 800) out = out.substring(0, 800) + "...";
                return `AGENT ${entry.agentName.toUpperCase()} OUTPUT: \n${out}`;
            }).join('\n\n');
        }

        if (agent.tools && agent.tools.length > 0) {
            for (const toolId of agent.tools) {
                const toolInfo = TOOLS[toolId] || { name: toolId };
                console.log(`[TOOL] Invoking ${toolInfo.name}...`);

                try {
                    let toolResultContent = "";
                    if (toolId === 'web_search') {
                        const { data } = await axios.post(`${BASE_URL}/api/tools/web_search`, { query: taskGoal });
                        if (data && data.results) toolResultContent = data.results.map(r => `• ${r.title}: ${r.snippet}`).join('\n');
                        else toolResultContent = JSON.stringify(data);
                    } else if (toolId === 'scheduler') {
                        const { data } = await axios.post(`${BASE_URL}/api/tools/scheduler`, { taskDescription: taskGoal, cronExpression: '0 9 * * *', recipientEmail: 'abhijeetroy20@outlook.com', agentId: agent.id, userId: 'test' });
                        toolResultContent = JSON.stringify(data);
                    } else if (TOOLS[toolId] && TOOLS[toolId].url) {
                        // Provide taskGoal for the summary payload to ensure the tool actually processes something
                        const { data } = await axios.post(`${BASE_URL}${TOOLS[toolId].url}`, { text: taskGoal, content: taskGoal, expression: taskGoal });
                        toolResultContent = data.summary || data.email || data.todos || data.result || JSON.stringify(data);
                    }
                    if (toolResultContent) {
                        agentContext += `\n\nTOOL RESULT from ${toolInfo.name}:\n${toolResultContent}`;
                    }
                } catch (e) {
                    console.log(`[TOOL ERROR] URL: ${TOOLS[toolId]?.url}`);
                    if (e.response) {
                        console.log(`[TOOL ERROR] Response: ${e.response.status} - ${JSON.stringify(e.response.data)}`);
                    } else {
                        console.log(`[TOOL ERROR] ${e.message}`);
                    }
                }
            }
        }

        if (agentContext.length > 4000) {
            agentContext = agentContext.substring(0, 4000) + "\n...[Context truncated for brevity]";
        }

        const streamPayload = {
            agentId: agent.id, taskGoal, agentName: agent.name, role: agent.role,
            personality: agent.personality, tools: agent.tools, context: agentContext,
            stepNumber: i + 1, totalSteps: pipeline.length
        };

        try {
            const { data } = await axios.post(`${BASE_URL}/api/agent/run`, streamPayload);
            const output = data.output;
            console.log(`[OUTPUT] ${agent.name}:\n${output}\n`);
            contextHistory.push({ agentName: agent.name, output: output });
        } catch (e) {
            if (e.response) {
                console.log(`[ERROR] Agent ${agent.name} failed: ${e.response.status} - ${JSON.stringify(e.response.data)}`);
            } else {
                console.log(`[ERROR] Agent ${agent.name} failed: ${e.message}`);
            }
        }
    }

    console.log(`[SYSTEM] ✓ Pipeline complete. All ${pipeline.length} agents processed the task.`);
}

async function runAll() {
    await runPipeline(['Scout'], "Search the internet for the latest iPhone 17 release date and price.");
    await runPipeline(['Lens'], "Summarize this text — Artificial intelligence has transformed industries ranging from healthcare to finance. Machine learning models can now diagnose diseases with accuracy matching expert doctors. Natural language processing enables computers to understand human speech and text. Computer vision allows machines to identify objects in images and videos. These technologies are converging to create systems that can perform complex cognitive tasks.");
    await runPipeline(['Quill'], "Write a professional email to my manager requesting approval for a 3 day work from home arrangement starting next Monday.");
    await runPipeline(['Atlas'], "Calculate the monthly EMI for a loan of 500000 rupees at 10 percent annual interest rate for 5 years.");
    await runPipeline(['Sage'], "Create a detailed action plan for launching a food delivery startup in Guwahati.");
    await runPipeline(['Hermes'], "Schedule a daily news summary email to be sentimmidiatly to abhijeetroy20@outlook.com.");

    await runPipeline(['Scout', 'Lens'], "Search for the latest news about electric vehicles in India 2025 and summarize the findings.");
    await runPipeline(['Scout', 'Quill'], "Search for the top benefits of meditation and write a professional email sharing these benefits with a wellness team.");
    await runPipeline(['Scout', 'Lens', 'Quill'], "Search for top 3 AI tools in 2025 summarize the findings and draft a team update email.");
}

runAll().catch(e => console.error(e));
