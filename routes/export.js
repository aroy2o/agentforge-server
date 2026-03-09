const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');

/**
 * Parse agent sections from the finalOutput string.
 * The format is:  ━━ AGENTNAME — ROLE ━━\ncontent
 * Returns an array of { agentName, content }
 */
function parseAgentSections(finalOutput) {
    if (!finalOutput) return [];
    // Split on the ━━ separator lines
    const sections = finalOutput.split(/━━[^━]+━━/);
    const headers = [...finalOutput.matchAll(/━━\s*(.+?)\s*—\s*.+?\s*━━/g)];

    const result = [];
    for (let i = 0; i < headers.length; i++) {
        const rawName = headers[i][1].trim();
        // Capitalize first letter, lowercase the rest
        const agentName = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
        const content = (sections[i + 1] || '').trim();
        if (content) {
            result.push({ agentName, content });
        }
    }
    return result;
}

// POST /markdown
router.post('/markdown', (req, res) => {
    try {
        const { taskGoal, logs = [], agentCount, createdAt, finalOutput } = req.body;
        const safeDate = createdAt ? new Date(createdAt).toLocaleString() : new Date().toLocaleString();

        let mdString = `# ${taskGoal || 'Task Report'}\n\n`;
        mdString += `*Date: ${safeDate} | Agents: ${agentCount || 0}*\n\n`;
        mdString += `---\n\n`;

        // Try logs first, then fall back to parsing finalOutput
        const outputLogs = logs.filter(l => l.type === 'output' && l.content && l.content.trim().length > 10);

        if (outputLogs.length > 0) {
            outputLogs.forEach(log => {
                mdString += `## ${log.agentName || 'Agent'}\n\n`;
                mdString += `${log.content.trim()}\n\n`;
            });
        } else {
            // Parse from finalOutput string
            const sections = parseAgentSections(finalOutput);
            sections.forEach(({ agentName, content }) => {
                mdString += `## ${agentName}\n\n`;
                mdString += `${content}\n\n`;
            });
        }

        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', 'attachment; filename="agentforge-report.md"');
        res.send(mdString);
    } catch (error) {
        console.error('[Export MD Error]', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /pdf
router.post('/pdf', (req, res) => {
    try {
        const { taskGoal, logs = [], agentCount, createdAt, finalOutput } = req.body;

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="agentforge-report.pdf"');
        doc.pipe(res);

        // Title
        doc.fontSize(22).font('Helvetica-Bold').fillColor('#000000').text('AgentForge Report', { align: 'center' });
        doc.moveDown();

        // Task goal
        doc.fontSize(14).font('Helvetica').fillColor('#000000').text(`Task Goal: ${taskGoal || 'N/A'}`);
        doc.moveDown(0.5);

        // Date & agent count
        const safeDate = createdAt ? new Date(createdAt).toLocaleString() : new Date().toLocaleString();
        doc.fontSize(10).fillColor('gray').text(`Date: ${safeDate} | Agents: ${agentCount || 0}`);
        doc.moveDown(2);

        // Try logs first, fall back to parsing finalOutput
        const outputLogs = logs.filter(l => l.type === 'output' && l.content && l.content.trim().length > 10);

        if (outputLogs.length > 0) {
            outputLogs.forEach(log => {
                doc.fillColor('#000000').fontSize(13).font('Helvetica-Bold').text(log.agentName || 'Agent');
                doc.moveDown(0.3);
                doc.font('Helvetica').fontSize(11).fillColor('#222222').text(log.content.trim(), { lineGap: 4.4 });
                doc.moveDown(1.5);
            });
        } else {
            // Parse from finalOutput string
            const sections = parseAgentSections(finalOutput);
            sections.forEach(({ agentName, content }) => {
                doc.fillColor('#000000').fontSize(13).font('Helvetica-Bold').text(agentName);
                doc.moveDown(0.3);
                doc.font('Helvetica').fontSize(11).fillColor('#222222').text(content, { lineGap: 4.4 });
                doc.moveDown(1.5);
            });
        }

        doc.end();
    } catch (error) {
        console.error('[Export PDF Error]', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

module.exports = router;

