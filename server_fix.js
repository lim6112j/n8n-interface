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

// Serve static files from the public directory
app.use(express.static('public'));
app.use(express.json()); // Parse JSON bodies for chat interaction

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
        const webhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';

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
        console.log(result)
        // Check for nested structure { output: { output: "...", insights: [...] } }
        // N8n sometimes wraps the response in an 'output' property
        if (result && result.output && typeof result.output === 'object' && result.output.output) {
            result = result.output;
        }

        // Just send the result as JSON. The frontend will handle { output, insights }
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
    const interactionWebhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';

    try {
        // Send the message to the webhook
        const response = await axios.post(interactionWebhookUrl, { message }, {
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

        // Check for nested structure { output: { output: "...", insights: [...] } }
        if (result && result.output && typeof result.output === 'object' && result.output.output) {
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
