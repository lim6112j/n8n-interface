require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const pool = new Pool({
    user: 'mobble_ai',
    host: 'localhost',
    database: 'mobble',
    password: 'ciel@105',
    port: 5432,
});

// Initialize database schema for users and sessions
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "sid" varchar NOT NULL COLLATE "default",
                "sess" json NOT NULL,
                "expire" timestamp(6) NOT NULL
            ) WITH (OIDS=FALSE);
            
            ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
            CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
        `).catch(e => {
            // Ignore error if constraint already exists
            if (e.code !== '42P07') console.error('Session table init error:', e);
        });

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                google_id VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255),
                role VARCHAR(50) DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}
initDb();

const app = express();
const port = 3000;

// Debug logging middleware for /upload to check if the request even reaches Express
app.use('/upload', (req, res, next) => {
    const logLine = `[${new Date().toISOString()}] Incoming /upload request. Content-Length: ${req.headers['content-length']}\n`;
    console.log(logLine.trim());
    fs.appendFileSync('debug.log', logLine);
    
    const originalSend = res.send;
    res.send = function (data) {
        const outLine = `[${new Date().toISOString()}] Outgoing /upload response. Status: ${res.statusCode}\n`;
        console.log(outLine.trim());
        fs.appendFileSync('debug.log', outLine);
        return originalSend.apply(res, arguments);
    };
    next();
});

// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB
    },
});

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

// Configure session
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session'
    }),
    secret: process.env.SESSION_SECRET || 'fallback_secret_for_development',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (result.rows.length > 0) {
            done(null, result.rows[0]);
        } else {
            done(null, false);
        }
    } catch (err) {
        done(err);
    }
});

// Passport Google Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback",
    proxy: true
},
    async function (accessToken, refreshToken, profile, cb) {
        try {
            const googleId = profile.id;
            const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
            const name = profile.displayName;

            let result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);

            if (result.rows.length === 0) {
                // New user registration
                let role = 'user';
                const superuserEmails = process.env.SUPERUSER_EMAILS ? process.env.SUPERUSER_EMAILS.split(',').map(e => e.trim()) : [];
                if (email && superuserEmails.includes(email)) {
                    role = 'superuser';
                }
                const insertResult = await pool.query(
                    'INSERT INTO users (google_id, email, name, role) VALUES ($1, $2, $3, $4) RETURNING *',
                    [googleId, email, name, role]
                );
                return cb(null, insertResult.rows[0]);
            } else {
                // Existing user
                return cb(null, result.rows[0]);
            }
        } catch (err) {
            return cb(err);
        }
    }
));

// Auth Routes
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    function (req, res) {
        // Successful authentication, redirect to home.
        res.redirect('/');
    });

app.get('/api/current-user', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ authenticated: true, user: req.user });
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/api/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.json({ success: true });
    });
});

// User Management Routes (Superuser only)
app.get('/api/users', async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== 'superuser') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const result = await pool.query('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC');
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:id/role', async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== 'superuser') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { role } = req.body;
    if (!['user', 'admin', 'superuser'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    try {
        const result = await pool.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, name, role', [role, req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Human-In-The-Loop (HITL) Approval State ---
// Maps requestId → { resumeUrl, approvalData, status: 'pending_approval' }
const approvalStore = new Map();

// In-memory store for async callback results (requestId → { html, insights, receivedAt })
const callbackStore = new Map();

// --- Human-In-The-Loop (HITL) Approval Endpoints ---

// Callback endpoint for n8n async workflows
// If the n8n workflow sends 'needsApproval' flag, this stores the resumeUrl
app.post('/callback', (req, res) => {
    const targetId = req.body.requestId || req.body.sessionId;
    const { html, insights, resumeUrl, needsApproval, approvalData } = req.body;
    if (!targetId) {
        return res.status(400).json({ error: 'requestId required' });
    }

    // Check if this is an approval request (from n8n Wait node)
    if (needsApproval === true && resumeUrl) {
        approvalStore.set(targetId, {
            resumeUrl,
            approvalData: approvalData || {},
            status: 'pending_approval',
            receivedAt: new Date().toISOString()
        });
        console.log(`[callback] Received approval request for requestId=${targetId}`);
        res.json({ success: true, status: 'approval_required' });
        return;
    }

    // Normal result callback (workflow completed or no approval needed)
    callbackStore.set(targetId, { html, insights, receivedAt: new Date().toISOString() });
    console.log(`[callback] Received result for requestId=${targetId}`);
    // Auto-cleanup after 10 minutes
    setTimeout(() => callbackStore.delete(targetId), 10 * 60 * 1000);
    res.json({ success: true });
});

// Status endpoint for frontend polling
app.get('/status/:requestId', (req, res) => {
    const requestId = req.params.requestId;

    // First check if workflow is awaiting approval
    const approval = approvalStore.get(requestId);
    if (approval) {
        return res.json({
            status: 'awaiting_approval',
            approvalData: approval.approvalData,
            message: 'Awaiting human approval'
        });
    }

    // Otherwise check for completed result
    const result = callbackStore.get(requestId);
    if (!result) {
        return res.json({ status: 'pending' });
    }
    res.json({ status: 'completed', html: result.html, insights: result.insights });
});

// Approve or deny action - client calls this when user clicks approve/deny
app.post('/approve/:requestId', async (req, res) => {
    const requestId = req.params.requestId;
    const { approved, reason } = req.body;

    const approval = approvalStore.get(requestId);
    if (!approval) {
        return res.status(404).json({ error: 'Approval session not found or already processed' });
    }

    console.log(`[approve] RequestId=${requestId} approved=${approved} resumeUrl=${approval.resumeUrl}`);

    try {
        // n8n Wait node with httpMethod=POST requires POST to resume
        // Send approval data as JSON body
        const response = await axios({
            method: 'POST',
            url: approval.resumeUrl,
            data: { approved: approved === true, reason: reason || '' },
            timeout: 30000,
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            validateStatus: () => true // Don't throw on non-2xx, we handle it
        });

        console.log(`[approve] n8n responded status=${response.status} data=${JSON.stringify(response.data).substring(0, 200)}`);

        if (response.status >= 400) {
            console.error(`[approve] n8n returned error status ${response.status}: ${JSON.stringify(response.data)}`);
            return res.status(502).json({
                error: 'n8n returned an error when resuming workflow',
                n8nStatus: response.status,
                details: response.data
            });
        }

        // Remove from approval store - workflow is now resuming
        approvalStore.delete(requestId);
        setTimeout(() => approvalStore.delete(requestId), 5000);

        res.json({ success: true, message: `Workflow is ${approved ? 'approved' : 'denied'} and resuming.` });
    } catch (error) {
        console.error(`[approve] Error forwarding approval for requestId=${requestId}:`, error.message);
        if (error.response) {
            console.error(`[approve] n8n response status: ${error.response.status}`);
            console.error(`[approve] n8n response data: ${JSON.stringify(error.response.data).substring(0, 500)}`);
        }
        res.status(500).json({ error: 'Failed to approve workflow', details: error.message });
    }
});

// Protect HTML files except index.html
app.use((req, res, next) => {
    if (req.path.endsWith('.html') && req.path !== '/index.html' && req.path !== '/') {
        if (!req.isAuthenticated()) {
            return res.redirect('/');
        }
        // Specific check for admin.html and system_prompts.html
        if ((req.path === '/admin.html' || req.path === '/system_prompts.html') && req.user.role === 'user') {
            return res.redirect('/');
        }
    }
    next();
});

// Serve static files from the public directory
app.use(express.static('public'));

// Middleware to protect admin system-prompts API routes
const requireAdminAuth = (req, res, next) => {
    if (!req.isAuthenticated() || (req.user.role !== 'admin' && req.user.role !== 'superuser')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

// --- System Prompts CRUD Endpoints (Admin only) ---
app.use('/api/system-prompts', requireAdminAuth);

// Get all system prompts
app.get('/api/system-prompts', async (req, res) => {
    try {
        const query = 'SELECT id, workflow_name, workflow_id, node_name, prompt, created_at FROM public.system_prompts ORDER BY workflow_name ASC, node_name ASC, id ASC;';
        const result = await pool.query(query);
        res.json({ prompts: result.rows });
    } catch (error) {
        console.error('Error fetching system prompts:', error);
        res.status(500).json({ error: 'Failed to fetch system prompts' });
    }
});

// Get a single system prompt
app.get('/api/system-prompts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'SELECT id, workflow_name, workflow_id, node_name, prompt, created_at FROM public.system_prompts WHERE id = $1;';
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'System prompt not found' });
        }
        res.json({ prompt: result.rows[0] });
    } catch (error) {
        console.error(`Error fetching system prompt ${id}:`, error);
        res.status(500).json({ error: 'Failed to fetch system prompt' });
    }
});

// Create a new system prompt
app.post('/api/system-prompts', async (req, res) => {
    const { workflow_name, workflow_id, node_name, prompt } = req.body;
    if (!workflow_name) {
        return res.status(400).json({ error: 'Workflow name is required' });
    }
    try {
        const query = `
            INSERT INTO public.system_prompts (workflow_name, workflow_id, node_name, prompt)
            VALUES ($1, $2, $3, $4)
            RETURNING id, workflow_name, workflow_id, node_name, prompt, created_at;
        `;
        const result = await pool.query(query, [workflow_name, workflow_id || null, node_name || null, prompt || null]);
        res.status(201).json({ success: true, prompt: result.rows[0] });
    } catch (error) {
        console.error('Error creating system prompt:', error);
        res.status(500).json({ error: 'Failed to create system prompt' });
    }
});

// Update a system prompt
app.put('/api/system-prompts/:id', async (req, res) => {
    const { id } = req.params;
    const { workflow_name, workflow_id, node_name, prompt } = req.body;
    if (!workflow_name) {
        return res.status(400).json({ error: 'Workflow name is required' });
    }
    try {
        const query = `
            UPDATE public.system_prompts
            SET workflow_name = $1, workflow_id = $2, node_name = $3, prompt = $4
            WHERE id = $5
            RETURNING id, workflow_name, workflow_id, node_name, prompt, created_at;
        `;
        const result = await pool.query(query, [workflow_name, workflow_id || null, node_name || null, prompt || null, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'System prompt not found' });
        }
        res.json({ success: true, prompt: result.rows[0] });
    } catch (error) {
        console.error(`Error updating system prompt ${id}:`, error);
        res.status(500).json({ error: 'Failed to update system prompt' });
    }
});

// Delete a system prompt
app.delete('/api/system-prompts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'DELETE FROM public.system_prompts WHERE id = $1 RETURNING id, workflow_name;';
        const result = await pool.query(query, [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'System prompt not found' });
        }
        res.json({ success: true, message: `System prompt '${result.rows[0].workflow_name}' deleted successfully` });
    } catch (error) {
        console.error(`Error deleting system prompt ${id}:`, error);
        res.status(500).json({ error: 'Failed to delete system prompt' });
    }
});

// --- Database API Endpoints ---

// Middleware to protect API routes and set schema
const requireDbAuth = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.dbSchema = String(req.user.id);
    next();
};

app.use('/api/db', requireDbAuth);

// Get all user-defined tables
app.get('/api/db/tables', async (req, res) => {
    try {
        const schema = req.dbSchema;
        // Ensure schema exists
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);

        const query = `
            SELECT tablename 
            FROM pg_catalog.pg_tables 
            WHERE schemaname = $1
            ORDER BY tablename ASC;
        `;
        const result = await pool.query(query, [schema]);
        res.json({ tables: result.rows.map(row => row.tablename) });
    } catch (error) {
        console.error('Error fetching tables:', error);
        res.status(500).json({ error: 'Failed to fetch tables' });
    }
});

// Get table data
app.get('/api/db/tables/:tableName', async (req, res) => {
    const { tableName } = req.params;
    const schema = req.dbSchema;
    const { offset = 0, limit = 50, filterCol, filterVal } = req.query;

    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    try {
        // Get column info
        const colQuery = `
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position ASC;
        `;
        const colResult = await pool.query(colQuery, [schema, tableName]);
        const validColumns = colResult.rows.map(c => c.column_name);

        let queryParams = [];
        let whereClause = '';

        if (filterCol && filterVal && validColumns.includes(filterCol)) {
            whereClause = `WHERE "${filterCol}"::text ILIKE $1`;
            queryParams.push(`%${filterVal}%`);
        }

        let orderClause = '';
        if (validColumns.includes('id')) {
            orderClause = 'ORDER BY id ASC';
        }

        queryParams.push(limit);
        queryParams.push(offset);
        const limitOffsetStr = `LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;

        const dataQuery = `SELECT * FROM "${schema}"."${tableName}" ${whereClause} ${orderClause} ${limitOffsetStr};`;
        const dataResult = await pool.query(dataQuery, queryParams);

        res.json({
            columns: colResult.rows,
            data: dataResult.rows
        });
    } catch (error) {
        console.error(`Error fetching data for ${tableName}:`, error);
        res.status(500).json({ error: `Failed to fetch data for ${tableName}` });
    }
});

// Add new row
app.post('/api/db/tables/:tableName', async (req, res) => {
    const { tableName } = req.params;
    const schema = req.dbSchema;
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    try {
        const rowData = req.body;
        // Filter out 'id' if it's empty to allow auto-increment
        const columns = Object.keys(rowData).filter(col => col !== 'id' || rowData[col] !== '');
        const values = columns.map(col => rowData[col]);
        const placeholders = columns.map((_, i) => `$${i + 1}`);

        if (columns.length === 0) {
            return res.status(400).json({ error: 'No data provided' });
        }

        const query = `INSERT INTO "${schema}"."${tableName}" ("${columns.join('", "')}") VALUES (${placeholders.join(', ')}) RETURNING *`;
        const result = await pool.query(query, values);
        res.json({ success: true, row: result.rows[0] });
    } catch (error) {
        console.error(`Error inserting into ${tableName}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Update row
app.put('/api/db/tables/:tableName/:id', async (req, res) => {
    const { tableName, id } = req.params;
    const schema = req.dbSchema;
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    try {
        const rowData = req.body;
        const columns = Object.keys(rowData).filter(col => col !== 'id');
        const values = columns.map(col => rowData[col]);

        const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');

        values.push(id);
        const query = `UPDATE "${schema}"."${tableName}" SET ${setClause} WHERE id = $${values.length} RETURNING *`;

        const result = await pool.query(query, values);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Row not found' });
        }
        res.json({ success: true, row: result.rows[0] });
    } catch (error) {
        console.error(`Error updating ${tableName}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Delete row
app.delete('/api/db/tables/:tableName/:id', async (req, res) => {
    const { tableName, id } = req.params;
    const schema = req.dbSchema;
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    try {
        const query = `DELETE FROM "${schema}"."${tableName}" WHERE id = $1 RETURNING *`;
        const result = await pool.query(query, [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Row not found' });
        }
        res.json({ success: true, row: result.rows[0] });
    } catch (error) {
        console.error(`Error deleting from ${tableName}:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/upload', upload.array('file'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).send('No file uploaded.');
    }

    try {
        const formData = new FormData();
        req.files.forEach((file, index) => {
            const contentType = file.mimetype === 'text/csv' ? 'text/csv' :
                (file.mimetype === 'application/vnd.ms-excel' ? 'application/vnd.ms-excel' :
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

            const key = req.files.length === 1 ? 'file' : `file${index}`;
            formData.append(key, fs.createReadStream(file.path), {
                filename: file.originalname,
                contentType: contentType
            });
        });

        // Generate unique requestId for this specific request so upload and interact don't share callback store keys
        const sessionId = req.query.sessionId || req.body.sessionId || 'unknown';
        const userId = req.user ? req.user.id : 'anonymous';
        const requestId = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        const baseUrl = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';
        const webhookUrl = `${baseUrl}?sessionId=${sessionId}&requestId=${requestId}&userId=${userId}`;

        // Increase timeout to 15 minutes (900000 ms) as requested
        const TIMEOUT_MS = 900000;

        const response = await axios.post(webhookUrl, formData, {
            headers: formData.getHeaders(),
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
            return res.json({ accepted: true, requestId, status: 'processing' });
        }

        // Check for unused Respond to Webhook warning (legacy after switch to async)
        if (result && result.code === 0 && result.message && result.message.includes('Unused Respond to Webhook')) {
            return res.json({ accepted: true, requestId, status: 'processing' });
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
        // Clean up the uploaded files from local storage
        if (req.files) {
            req.files.forEach(file => {
                if (file.path && fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            });
        }
    }
});

// Chat / Interaction Endpoint
app.post('/interact', async (req, res) => {
    const { message } = req.body;
    // Generate unique requestId for this specific request so upload and interact don't share callback store keys
    const sessionId = req.query.sessionId || req.body.sessionId || 'unknown';
    const userId = req.user ? req.user.id : 'anonymous';
    const requestId = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    const baseUrl = process.env.INTERACTION_WEBHOOK_URL || 'http://localhost:5678/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';
    const interactionWebhookUrl = `${baseUrl}?sessionId=${sessionId}&requestId=${requestId}&userId=${userId}`;
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
            return res.json({ accepted: true, requestId, status: 'processing' });
        }

        // Check for unused Respond to Webhook warning (legacy after switch to async)
        if (result && result.code === 0 && result.message && result.message.includes('Unused Respond to Webhook')) {
            return res.json({ accepted: true, requestId, status: 'processing' });
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
