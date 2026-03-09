const mongoose = require('mongoose');

const pipelineSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    name: { type: String, default: 'My Pipeline' },
    agentOrder: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Pipeline', pipelineSchema);
