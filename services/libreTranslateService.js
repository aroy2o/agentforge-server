const { spawn } = require('child_process');

let ltProcess = null;

function startLibreTranslate() {
    return new Promise((resolve, reject) => {
        console.log('[LibreTranslate] Spawning local instance...');

        // Spawn LibreTranslate with the requested languages loaded into memory to save time
        ltProcess = spawn('libretranslate', [
            '--load-only',
            'en,hi,bn,te,ta,mr,gu,kn,pa,fr,es,de,zh,ja,ar'
        ], {
            // Detach if you want it to outlive the node process but typically we want it bound
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        ltProcess.stdout.on('data', (data) => {
            const output = data.toString();
            // LibreTranslate prints Running on http://... when ready
            if (output.includes('Running on')) {
                console.log('[LibreTranslate] Engine is loaded and ready.');
                resolve(true);
            }
        });

        ltProcess.stderr.on('data', (data) => {
            // LibreTranslate outputs a lot of model loading info to stderr
            const errStr = data.toString();
            if (errStr.includes('Running on')) {
                console.log('[LibreTranslate] Engine is loaded and ready.');
                resolve(true);
            }
        });

        ltProcess.on('error', (err) => {
            console.error('[LibreTranslate] Failed to start:', err.message);
            resolve(false);
        });

        ltProcess.on('close', (code) => {
            console.log(`[LibreTranslate] Process exited with code ${code}`);
        });
    });
}

function stopLibreTranslate() {
    if (ltProcess) {
        console.log('[LibreTranslate] Shutting down instance...');
        ltProcess.kill('SIGTERM');
        ltProcess = null;
    }
}

module.exports = {
    startLibreTranslate,
    stopLibreTranslate
};
