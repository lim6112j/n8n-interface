const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Serve static files from the public directory
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

        // The test webhook URL provided by the user
        //const webhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook-test/10df9f3d-ca2d-4a30-9d49-472866901991';

        // production 
        const webhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';
        // Headers for the request to the webhook
        // form-data library handles the boundary automatically
        const headers = {
            ...formData.getHeaders(),
            'Content-Type': contentType // Dynamic content type
        };

        const https = require('https');

        const fileBuffer = fs.readFileSync(filePath);

        // Increase timeout to 15 minutes (900000 ms) as requested
        const TIMEOUT_MS = 900000;

        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 10,
            rejectUnauthorized: false // Allow self-signed certs if needed for ngrok/dev
        });

        const response = await axios.post(webhookUrl, fileBuffer, {
            headers: {
                'Content-Type': contentType
            },
            timeout: TIMEOUT_MS, // Set explicit timeout for axios
            httpsAgent: httpsAgent,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        /*
        // MOCK RESPONSE FOR TESTING
        const response = {
            data: {
                output: {
                    output: `
                        <!DOCTYPE html>
                        <html>
                        <head><style>body { font-family: sans-serif; padding: 20px; }</style></head>
                        <body>
                            <h1>Analysis Report</h1>
                            <p>This is a mock report generated for testing purposes.</p>
                            <div style="height: 300px; background: #eee; margin-top: 20px; display: flex; align-items: center; justify-content: center;">
                                Chart Placeholder
                            </div>
                        </body>
                        </html>
                    `,
                    insights: [
                        "Supply chain velocity increased by 15%",
                        "Potential bottleneck identified in Sector 7",
                        "Weather patterns may affect delivery times"
                    ]
                }
            }
        };
        */

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
        console.error('Error forwarding file:', error);
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
    // New Webhook URL for interactions
    //const interactionWebhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook-test/63b5b0bd-1d44-481a-8e3a-9fced8e717eb';
    // production
    //const interactionWebhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/63b5b0bd-1d44-481a-8e3a-9fced8e717eb';
    // upload
    const interactionWebhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';

    try {
        const https = require('https');
        const httpsAgent = new https.Agent({
            rejectUnauthorized: false
        });

        // Send the message to the webhook
        // Assuming the webhook expects { "message": "..." } or similar
        const response = await axios.post(interactionWebhookUrl, { message }, {
            httpsAgent: httpsAgent,
            timeout: 300000 // 5 minutes timeout for slow AI responses
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
        res.status(500).json({ error: 'Failed to communicate with AI agent' });
    }
});

const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Set server timeout to 15 minutes to match the request timeout
server.setTimeout(900000);
