const mongoose = require('mongoose');

const ChatSessionSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, unique: true, required: true },
    title: { type: String, default: 'New Session' },
    taskGoal: { type: String },
    pipelineAgents: [{
        agentId: String,
        agentName: String,
        agentColor: String
    }],
    messages: [{
        id: String,
        role: { type: String, enum: ['user', 'assistant', 'system'] },
        agentName: String,
        agentColor: String,
        content: { type: String, required: true },
        toolsUsed: [String],
        timestamp: { type: Date, default: Date.now },
        isStreaming: { type: Boolean, default: false }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

ChatSessionSchema.pre('save', async function () {
    this.updatedAt = new Date();
});

module.exports = mongoose.model('ChatSession', ChatSessionSchema);
