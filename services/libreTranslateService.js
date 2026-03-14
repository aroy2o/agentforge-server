const { spawn } = require('child_process');
const axios = require('axios');

let ltProcess = null;
let starting = false;
let shuttingDown = false;

const LT_HOST = process.env.LIBRETRANSLATE_HOST || '127.0.0.1';
const LT_PORT = process.env.LIBRETRANSLATE_PORT || '8002';
const LT_URL = process.env.LIBRETRANSLATE_URL || `http://${LT_HOST}:${LT_PORT}`;
const LT_STARTUP_TIMEOUT_MS = Number(process.env.LIBRE_STARTUP_TIMEOUT_MS || 90000);

async function isLibreHealthy(timeout = 1500) {
    try {
        const res = await axios.get(`${LT_URL}/languages`, { timeout });
        return Array.isArray(res.data);
    } catch {
        return false;
    }
}

async function waitForLibreHealth(timeoutMs = LT_STARTUP_TIMEOUT_MS, pollMs = 1200) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await isLibreHealthy()) return true;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
}

function startLibreTranslate(options = {}) {
    const startupTimeoutMs = Number(options.timeoutMs || LT_STARTUP_TIMEOUT_MS);
    return new Promise((resolve) => {
        const launch = async () => {
            if (shuttingDown) {
                resolve(false);
                return;
            }

            if (await isLibreHealthy()) {
                console.log(`[LibreTranslate] Existing instance is healthy at ${LT_URL}`);
                resolve(true);
                return;
            }

            if (ltProcess || starting) {
                const warmHealthy = await waitForLibreHealth(startupTimeoutMs);
                if (warmHealthy) {
                    console.log(`[LibreTranslate] Existing process became healthy at ${LT_URL}`);
                    resolve(true);
                    return;
                }
                resolve(false);
                return;
            }
            starting = true;

            console.log(`[LibreTranslate] Spawning local instance on ${LT_URL}...`);

            // Spawn LibreTranslate with the requested languages loaded into memory to save time
            ltProcess = spawn('libretranslate', [
                '--host',
                LT_HOST,
                '--port',
                String(LT_PORT),
                '--load-only',
                'en,hi,bn,te,ta,mr,gu,kn,pa,fr,es,de,zh,ja,ar'
            ], {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let resolved = false;
            const finish = (ok) => {
                if (resolved) return;
                resolved = true;
                starting = false;
                resolve(ok);
            };

            const readyMatcher = (text) =>
                text.includes('Running on') || text.includes('Uvicorn running on') || text.includes('Application startup complete');

            ltProcess.stdout.on('data', (data) => {
                const output = data.toString();
                if (readyMatcher(output)) {
                    isLibreHealthy().then((ok) => {
                        if (ok) {
                            console.log(`[LibreTranslate] Engine is loaded and ready at ${LT_URL}.`);
                            finish(true);
                        }
                    });
                }
            });

            ltProcess.stderr.on('data', (data) => {
                const errStr = data.toString();
                if (readyMatcher(errStr)) {
                    isLibreHealthy().then((ok) => {
                        if (ok) {
                            console.log(`[LibreTranslate] Engine is loaded and ready at ${LT_URL}.`);
                            finish(true);
                        }
                    });
                }
            });

            ltProcess.on('error', (err) => {
                console.error('[LibreTranslate] Failed to start:', err.message);
                ltProcess = null;
                finish(false);
            });

            ltProcess.on('close', (code) => {
                console.log(`[LibreTranslate] Process exited with code ${code}`);
                ltProcess = null;
                finish(false);
            });

            // Health-driven readiness, not only log-driven readiness.
            const healthy = await waitForLibreHealth(startupTimeoutMs);
            if (healthy) {
                console.log(`[LibreTranslate] Engine is loaded and ready at ${LT_URL}.`);
                finish(true);
                return;
            }

            console.warn(`[LibreTranslate] Startup timeout after ${startupTimeoutMs}ms. Continuing without local translator engine for now.`);
            finish(false);

        };

        launch();
    });
}

function stopLibreTranslate() {
    shuttingDown = true;
    return new Promise((resolve) => {
        if (!ltProcess) {
            resolve();
            return;
        }

        console.log('[LibreTranslate] Shutting down instance...');
        const proc = ltProcess;
        const pid = proc.pid;
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            ltProcess = null;
            starting = false;
            resolve();
        };

        proc.once('close', finish);

        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            try { process.kill(pid, 'SIGTERM'); } catch { }
        }

        setTimeout(() => {
            if (done) return;
            try { process.kill(-pid, 'SIGKILL'); } catch {
                try { process.kill(pid, 'SIGKILL'); } catch { }
            }
            finish();
        }, 4000);
    });
}

module.exports = {
    startLibreTranslate,
    stopLibreTranslate
};
