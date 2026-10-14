// worker.js - Runs in a background thread on the client's phone/browser

let isRunning = false;
let totalProcessed = 0;
let batchSize = 5000;

self.onmessage = function (e) {
    const { command, data } = e.data;

    if (command === 'START') {
        isRunning = true;
        processChunk(data || { difficulty: 4 });
    } else if (command === 'STOP') {
        isRunning = false;
        self.postMessage({ type: 'STOPPED', total: totalProcessed });
    }
};

function hashString(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function processChunk(params) {
    if (!isRunning) return;

    const startTime = performance.now();
    let matches = 0;
    const prefix = '0'.repeat(params.difficulty || 4);

    for (let i = 0; i < batchSize; i++) {
        totalProcessed++;
        const candidate = "g86_" + Math.random().toString(36).substring(2, 9) + "_" + totalProcessed;
        const hash = hashString(candidate);
        if (hash.startsWith(prefix)) {
            matches++;
            self.postMessage({
                type: 'FOUND_MATCH',
                candidate: candidate,
                hash: hash,
                atTotal: totalProcessed
            });
        }
    }

    const duration = performance.now() - startTime;
    const opsPerSec = Math.round((batchSize / (duration || 1)) * 1000);

    self.postMessage({
        type: 'PROGRESS',
        processed: totalProcessed,
        opsPerSec: opsPerSec,
        matches: matches
    });

    if (isRunning) {
        setTimeout(() => processChunk(params), 10);
    }
}
