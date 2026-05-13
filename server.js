const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const port = 3000;

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Create agents for HTTP/1.1 support (n8n webhook requires HTTP/1.1, not HTTP/2)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ 
    keepAlive: true,
    maxSockets: 10,
    rejectUnauthorized: false,
    // Force HTTP/1.1 to avoid PROTOCOL_ERROR with ngrok
    maxVersion: 'TLSv1.2'
});

app.use(express.json()); // Parse JSON bodies — MUST be before routes that need body parsing

// In-memory store for async callback results (sessionId → { html, insights, receivedAt })
const callbackStore = new Map();

// Callback endpoint for n8n async workflows
app.post('/callback', (req, res) => {
    const { sessionId, html, insights } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    callbackStore.set(sessionId, { html, insights, receivedAt: new Date().toISOString() });
    console.log(`[callback] Received result for sessionId=${sessionId}`);
    // Auto-cleanup after 10 minutes
    setTimeout(() => callbackStore.delete(sessionId), 10 * 60 * 1000);
    res.json({ success: true });
});

// Status endpoint for frontend polling
app.get('/status/:sessionId', (req, res) => {
    const result = callbackStore.get(req.params.sessionId);
    if (!result) {
        return res.json({ status: 'pending' });
    }
    res.json({ status: 'completed', html: result.html, insights: result.insights });
});

// Serve static files from the public directory
app.use(express.static('public'));

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    // Determine the content type based on the file extension or mimetype
    const contentType = req.file.mimetype === 'text/csv' ? 'text/csv' :
        (req.file.mimetype === 'application/vnd.ms-excel' ? 'application/vnd.ms-excel' :
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), {
            filename: originalName,
            contentType: contentType // Dynamic content type
        });

        // production 
        // const webhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';
        const sessionId = req.query.sessionId || '';
	    const webhookUrl = `http://localhost:5678/webhook/10df9f3d-ca2d-4a30-9d49-472866901991${sessionId ? `?sessionId=${sessionId}` : ''}`;
        const fileBuffer = fs.readFileSync(filePath);

        // Increase timeout to 15 minutes (900000 ms) as requested
        const TIMEOUT_MS = 900000;

        const response = await axios.post(webhookUrl, fileBuffer, {
            headers: {
                'Content-Type': contentType
            },
            timeout: TIMEOUT_MS,
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            maxRedirects: 5
        });

        // Check the type of response data
        let result = response.data;

        // If it's an array (N8n often returns [{...}]), take the first item
        if (Array.isArray(result) && result.length > 0) {
            result = result[0];
        }
        // Check for async webhook response (onReceived mode)
        if (result && result.message && (result.message.includes('Workflow was started') || result.message.includes('Workflow got started'))) {
            return res.json({ accepted: true, sessionId, status: 'processing' });
        }

        // Check for unused Respond to Webhook warning (legacy after switch to async)
        if (result && result.code === 0 && result.message && result.message.includes('Unused Respond to Webhook')) {
            return res.json({ accepted: true, sessionId, status: 'processing' });
        }

        console.log(result)

        // Check for nested structure { output: { html: "...", insights: [...] } }
        // N8n sometimes wraps the response in an 'output' property
        if (result && result.output && typeof result.output === 'object' && result.output.html) {
            result = result.output;
        }

        // Just send the result as JSON. The frontend will handle { html, insights }
        res.json(result);

    } catch (error) {
        console.error('Error forwarding file:', error.message);
        res.status(500).json({ error: 'Failed to forward file to webhook', details: error.message });
    } finally {
        // Clean up the uploaded file from local storage
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});

// Chat / Interaction Endpoint
app.post('/interact', async (req, res) => {
    const { message } = req.body;
    const sessionId = req.query.sessionId || '';
    // const interactionWebhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';
    const interactionWebhookUrl = `http://localhost:5678/webhook/10df9f3d-ca2d-4a30-9d49-472866901991${sessionId ? `?sessionId=${sessionId}` : ''}`;
    try {
        // Send the message to the webhook — wrap in { body } so n8n workflow's Switch node can match it
        const response = await axios.post(interactionWebhookUrl, { body: { message } }, {
            timeout: 300000, // 5 minutes timeout for slow AI responses
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            maxRedirects: 5
        });

        let result = response.data;

        // Normalize response structure (same as /upload)
        if (Array.isArray(result) && result.length > 0) {
            result = result[0];
        }

        // Check for async webhook response (onReceived mode)
        if (result && result.message && (result.message.includes('Workflow was started') || result.message.includes('Workflow got started'))) {
            return res.json({ accepted: true, sessionId, status: 'processing' });
        }

        // Check for unused Respond to Webhook warning (legacy after switch to async)
        if (result && result.code === 0 && result.message && result.message.includes('Unused Respond to Webhook')) {
            return res.json({ accepted: true, sessionId, status: 'processing' });
        }

        // Check for nested structure { output: { html: "...", insights: [...] } }
        if (result && result.output && typeof result.output === 'object' && result.output.html) {
            result = result.output;
        }

        // Loop back the webhook response
        res.json(result);

    } catch (error) {
        console.error('Interaction Error:', error.message);
        res.status(500).json({ error: 'Failed to communicate with AI agent', details: error.message });
    }
});

const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Set server timeout to 15 minutes to match the request timeout
server.setTimeout(900000);
