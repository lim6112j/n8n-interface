require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
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
  async function(accessToken, refreshToken, profile, cb) {
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
  function(req, res) {
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

// Protect HTML files except index.html
app.use((req, res, next) => {
    if (req.path.endsWith('.html') && req.path !== '/index.html' && req.path !== '/') {
        if (!req.isAuthenticated()) {
            return res.redirect('/');
        }
        // Specific check for admin.html
        if (req.path === '/admin.html' && req.user.role === 'user') {
            return res.redirect('/');
        }
    }
    next();
});

// Serve static files from the public directory
app.use(express.static('public'));

// --- Database API Endpoints ---

// Get all user-defined tables
app.get('/api/db/tables', async (req, res) => {
    try {
        const query = `
            SELECT tablename 
            FROM pg_catalog.pg_tables 
            WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema'
            ORDER BY tablename ASC;
        `;
        const result = await pool.query(query);
        res.json({ tables: result.rows.map(row => row.tablename) });
    } catch (error) {
        console.error('Error fetching tables:', error);
        res.status(500).json({ error: 'Failed to fetch tables' });
    }
});

// Get table data
app.get('/api/db/tables/:tableName', async (req, res) => {
    const { tableName } = req.params;
    const { offset = 0, limit = 50, filterCol, filterVal } = req.query;
    
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    try {
        // Get column info
        const colQuery = `
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = $1
            ORDER BY ordinal_position ASC;
        `;
        const colResult = await pool.query(colQuery, [tableName]);
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

        const dataQuery = `SELECT * FROM "${tableName}" ${whereClause} ${orderClause} ${limitOffsetStr};`;
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

        const query = `INSERT INTO "${tableName}" ("${columns.join('", "')}") VALUES (${placeholders.join(', ')}) RETURNING *`;
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
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    try {
        const rowData = req.body;
        const columns = Object.keys(rowData).filter(col => col !== 'id');
        const values = columns.map(col => rowData[col]);
        
        const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
        
        values.push(id);
        const query = `UPDATE "${tableName}" SET ${setClause} WHERE id = $${values.length} RETURNING *`;
        
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
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    try {
        const query = `DELETE FROM "${tableName}" WHERE id = $1 RETURNING *`;
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

        // Generate unique requestId for this specific request so upload and interact don't share callback store keys
        const requestId = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        const webhookUrl = `http://localhost:5678/webhook/10df9f3d-ca2d-4a30-9d49-472866901991?sessionId=${requestId}`;
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
        // Clean up the uploaded file from local storage
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});

// Chat / Interaction Endpoint
app.post('/interact', async (req, res) => {
    const { message } = req.body;
    // Generate unique requestId for this specific request so upload and interact don't share callback store keys
    const requestId = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    // const interactionWebhookUrl = 'https://draven-reparative-subfestively.ngrok-free.dev/webhook/10df9f3d-ca2d-4a30-9d49-472866901991';
    const interactionWebhookUrl = `http://localhost:5678/webhook/10df9f3d-ca2d-4a30-9d49-472866901991?sessionId=${requestId}`;
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
