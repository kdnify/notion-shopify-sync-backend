import express from 'express';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import webhookRoutes from './routes/webhooks';
import authRoutes from './routes/auth';
import notionRoutes from './routes/notion';
import configRoutes from './routes/config';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware configured for embedded Shopify app
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com", "https://cdn.shopify.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.shopify.com"],
      connectSrc: ["'self'", "https://cdn.shopify.com", "https://api.notion.com"],
      frameSrc: ["'self'"],
      frameAncestors: ["https://*.myshopify.com", "https://admin.shopify.com"],
    },
  },
  frameguard: false, // Allow embedding in Shopify admin
}));

// Body parser middleware - Raw for webhook verification
app.use('/webhooks', bodyParser.raw({ type: 'application/json' }));

// JSON body parser for other routes
app.use(bodyParser.json());

// Serve static files for embedded app
app.use('/static', express.static(path.join(__dirname, '../public')));

// Routes
app.use('/auth', authRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/notion', notionRoutes);
app.use('/config', configRoutes);

// Embedded app main interface
app.get('/app', (req: express.Request, res: express.Response) => {
  const { shop, hmac, timestamp, session, locale, error, installed } = req.query;
  
  // Basic validation for embedded app access
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  const errorMessage = error ? decodeURIComponent(error as string) : null;
  const isNewInstall = installed === 'true';

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>NotionSync - Order Sync</title>
      <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
      <script src="https://unpkg.com/@shopify/app-bridge-utils@3"></script>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          margin: 0;
          padding: 20px;
          background-color: #f6f6f7;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background: white;
          border-radius: 8px;
          padding: 24px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .header {
          border-bottom: 1px solid #e1e3e5;
          padding-bottom: 16px;
          margin-bottom: 24px;
        }
        .title {
          font-size: 24px;
          font-weight: 600;
          color: #202223;
          margin: 0 0 8px 0;
        }
        .subtitle {
          color: #6d7175;
          margin: 0;
        }
        .status-card {
          background: #f0f8ff;
          border: 1px solid #b3d9ff;
          border-radius: 6px;
          padding: 16px;
          margin: 16px 0;
        }
        .status-title {
          font-weight: 600;
          color: #0066cc;
          margin: 0 0 8px 0;
        }
        .status-list {
          margin: 0;
          padding-left: 20px;
          color: #202223;
        }
        .sync-button {
          background: #008060;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          margin: 16px 8px 16px 0;
        }
        .sync-button:hover {
          background: #006b4f;
        }
        .sync-button:disabled {
          background: #b5b5b5;
          cursor: not-allowed;
        }
        .settings-section {
          margin-top: 32px;
          padding-top: 24px;
          border-top: 1px solid #e1e3e5;
        }
        .section-title {
          font-size: 18px;
          font-weight: 600;
          color: #202223;
          margin: 0 0 16px 0;
        }
        .info-row {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid #f1f1f1;
        }
        .info-label {
          font-weight: 500;
          color: #6d7175;
        }
        .info-value {
          color: #202223;
        }
        .logs {
          background: #f8f8f8;
          border: 1px solid #e1e3e5;
          border-radius: 6px;
          padding: 16px;
          margin: 16px 0;
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 12px;
          max-height: 200px;
          overflow-y: auto;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 class="title">🎯 NotionSync</h1>
          <p class="subtitle">Automatically sync your Shopify orders to Notion</p>
        </div>

        ${errorMessage ? `
        <div class="status-card" style="background: #fff2f2; border-color: #ffb3b3;">
          <h3 class="status-title" style="color: #cc0000;">❌ Integration Error</h3>
          <p style="margin: 8px 0; color: #202223;">${errorMessage}</p>
        </div>
        ` : isNewInstall ? `
        <div class="status-card" style="background: #f0fff4; border-color: #b3ffcc;">
          <h3 class="status-title" style="color: #00cc44;">🎉 Installation Complete!</h3>
          <p style="margin: 8px 0; color: #202223;">Your NotionSync app has been successfully installed and configured.</p>
        </div>
        ` : ''}

        <div class="status-card">
          <h3 class="status-title">✅ App Installed</h3>
          <p style="margin: 8px 0; color: #202223;">Connected to shop: <strong>${shop}</strong></p>
        </div>

        <div class="settings-section">
          <h2 class="section-title">📊 Your Notion Database</h2>
          
          <!-- Database Connected State -->
          <div id="databaseConnected" style="display: none;">
            <div class="status-card" style="background: #f0fff4; border-color: #b3ffcc;">
              <h3 class="status-title" style="color: #00cc44;">✅ Connected to Notion!</h3>
              <p style="margin: 8px 0; color: #202223;">Your personal Notion database is ready and syncing orders automatically.</p>
              <div style="margin-top: 16px;">
                <button class="sync-button" id="openDatabaseBtn" style="background: #0066cc;">
                  🔗 Open My Notion Dashboard
                </button>
                <div style="margin-top: 8px;">
                  <a href="/redirect/notion/212e8f5ac14a807fb67ac1887df275d5" target="_blank" style="color: #0066cc; text-decoration: underline; font-size: 14px;">
                    Or click here to open Notion directly
                  </a>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Not Connected State -->
          <div id="databaseNotConnected">
            <div class="status-card" style="background: #fff9e6; border-color: #ffeb99;">
              <h3 class="status-title" style="color: #cc7a00;">🔗 Connect Your Notion</h3>
              <p style="margin: 8px 0; color: #202223;">Connect to Notion to automatically create your personal order tracking database.</p>
              <div style="margin-top: 16px;">
                <button class="sync-button" style="background: #0066cc;" id="connectBtn">
                  🔗 Connect to Notion
                </button>
              </div>
            </div>
          </div>

          <div id="setupStatus" style="display: none; padding: 12px; border-radius: 6px; margin-top: 16px;"></div>
        </div>


      </div>

      <script>
        // Initialize Shopify App Bridge
        const AppBridge = window['app-bridge'];
        const createApp = AppBridge.default;
        const { Redirect } = AppBridge.actions;
        const { Toast } = AppBridge.actions;

        const app = createApp({
          apiKey: '${process.env.SHOPIFY_API_KEY}',
          shopOrigin: '${shop}',
        });

        // App state
        let currentNotionDbId = null;

        // Initialize app - check for existing database
        async function initializeApp() {
          try {
            const response = await fetch('/auth/user-info?shop=${shop}');
            if (response.ok) {
              const userInfo = await response.json();
              console.log('User info loaded:', userInfo);
              if (userInfo.success && userInfo.data.notionDbId && userInfo.data.notionDbId.trim() !== '') {
                currentNotionDbId = userInfo.data.notionDbId;
                showDatabaseConnected(userInfo.data.notionDbId);
                console.log('Database connected:', userInfo.data.notionDbId);
              } else {
                console.log('No database found, showing connect option');
                showDatabaseNotConnected();
                
                // Check if this is from setup flow and auto-trigger Notion connection
                const urlParams = new URLSearchParams(window.location.search);
                if (urlParams.get('setup') === 'true') {
                  console.log('Setup flow detected, auto-triggering Notion connection');
                  setTimeout(() => {
                    connectToNotion();
                  }, 1000); // Small delay to let UI render
                }
              }
            } else {
              console.log('Failed to load user info, showing connect option');
              showDatabaseNotConnected();
              
              // Check if this is from setup flow and auto-trigger Notion connection
              const urlParams = new URLSearchParams(window.location.search);
              if (urlParams.get('setup') === 'true') {
                console.log('Setup flow detected, auto-triggering Notion connection');
                setTimeout(() => {
                  connectToNotion();
                }, 1000); // Small delay to let UI render
              }
            }
          } catch (error) {
            console.log('Could not load user info:', error);
            showDatabaseNotConnected();
            
            // Check if this is from setup flow and auto-trigger Notion connection
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('setup') === 'true') {
              console.log('Setup flow detected, auto-triggering Notion connection');
              setTimeout(() => {
                connectToNotion();
              }, 1000); // Small delay to let UI render
            }
          }
        }

        function showDatabaseConnected(dbId) {
          const connected = document.getElementById('databaseConnected');
          const notConnected = document.getElementById('databaseNotConnected');
          
          if (connected && notConnected) {
            connected.style.display = 'block';
            notConnected.style.display = 'none';
          }
        }

        function showDatabaseNotConnected() {
          const connected = document.getElementById('databaseConnected');
          const notConnected = document.getElementById('databaseNotConnected');
          
          if (connected && notConnected) {
            connected.style.display = 'none';
            notConnected.style.display = 'block';
          }
        }

        function connectToNotion() {
          const connectBtn = document.getElementById('connectBtn');
          if (connectBtn) {
            connectBtn.textContent = '⏳ Connecting...';
            connectBtn.disabled = true;
          }

          // Build Notion OAuth URL
          const clientId = '${process.env.NOTION_OAUTH_CLIENT_ID || '212d872b-594c-80fd-ae95-0037202a219e'}';
          const redirectUri = encodeURIComponent('https://${req.get('host')}/auth/notion-callback');
          const state = encodeURIComponent(JSON.stringify({
            shop: '${shop}',
            source: 'embedded_app'
          }));
          
          const notionOAuthUrl = 'https://api.notion.com/v1/oauth/authorize?' +
            'client_id=' + clientId +
            '&response_type=code' +
            '&owner=user' +
            '&redirect_uri=' + redirectUri +
            '&state=' + state;

          // Redirect to Notion OAuth
          window.location.href = notionOAuthUrl;
        }

        function openUserDatabase() {
          if (currentNotionDbId) {
            // Use our redirect endpoint to avoid iframe CSP issues
            const redirectUrl = '/redirect/notion/' + currentNotionDbId;
            console.log('Redirecting to:', redirectUrl);
            
            // Use Shopify App Bridge to redirect to our endpoint
            const redirect = Redirect.create(app);
            redirect.dispatch(Redirect.Action.REMOTE, {
              url: redirectUrl,
              newContext: true
            });
          } else {
            console.log('No database ID available');
            const toast = Toast.create(app, {
              message: '❌ No database connected yet',
              duration: 3000
            });
            toast.dispatch(Toast.Action.SHOW);
          }
        }

        // App functions



        // Add event listeners
        document.addEventListener('DOMContentLoaded', function() {
          // Connect button event listener
          const connectBtn = document.getElementById('connectBtn');
          if (connectBtn) {
            connectBtn.addEventListener('click', connectToNotion);
          }
          
          // Open database button event listener
          const openDbBtn = document.getElementById('openDatabaseBtn');
          if (openDbBtn) {
            openDbBtn.addEventListener('click', openUserDatabase);
          }
        });

        // Initialize the app when page loads
        initializeApp();
      </script>
    </body>
    </html>
  `);
});

// App installation endpoint (for when users install from app store)
app.get('/install', (req: express.Request, res: express.Response) => {
  const { shop } = req.query;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  // Redirect to OAuth flow
  res.redirect(`/auth?shop=${shop}`);
});

// Welcome page (for development/testing)
app.get('/', (req: express.Request, res: express.Response) => {
  res.send(`
    <html>
      <head><title>NotionSync - Shopify to Notion Integration</title></head>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>🎯 NotionSync</h1>
        <p>Shopify to Notion order synchronization service.</p>
        <h3>🔗 Available Endpoints:</h3>
        <ul>
          <li><a href="/health">🏥 Health Check</a></li>
          <li><a href="/webhooks/test">🧪 Webhook Test</a></li>
          <li><a href="/setup">🚀 Smart Setup Flow</a></li>
        </ul>
        <h3>🧪 Test Stores:</h3>
        <ul>
          <li><a href="/auth?shop=testcrump1">🆕 Install App (testcrump1)</a></li>
          <li><a href="/auth?shop=testcrump2">🆕 Install App (testcrump2)</a></li>
          <li><a href="/auth?shop=crumpskin">🆕 Install App (crumpskin)</a></li>
        </ul>
        <h3>📋 Integration Status:</h3>
        <p>✅ Server Running<br/>
        ✅ Notion Integration Ready<br/>
        ✅ Webhook Endpoint Active<br/>
        ✅ OAuth Flow Configured<br/>
        ✅ Embedded App Interface Ready</p>
        
        <h3>🛠 For Shopify Integration:</h3>
        <p>Set your app's <strong>App URL</strong> to: <code>https://your-domain.com/app</code></p>
        <p>Set your <strong>Allowed redirection URL(s)</strong> to: <code>https://your-domain.com/auth/callback</code></p>
        
        <h3>📝 How to Test:</h3>
        <ol>
          <li>Try the <strong>Smart Setup Flow</strong> above for the full experience</li>
          <li>Or click one of the "Install App" links for direct installation</li>
          <li>After installation, you'll be redirected to the embedded app</li>
          <li>Click "Connect to Notion" to test the OAuth flow</li>
        </ol>
      </body>
    </html>
  `);
});

// Smart Setup Flow - The main landing page users will see
app.get('/setup', (req: express.Request, res: express.Response) => {
  // Set more permissive CSP for setup page since it's not embedded
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>NotionSync - Setup Your Order Tracking</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          background: white;
          border-radius: 16px;
          padding: 40px;
          max-width: 600px;
          width: 90%;
          box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        .header {
          text-align: center;
          margin-bottom: 40px;
        }
        .title {
          font-size: 32px;
          font-weight: 700;
          color: #1a1a1a;
          margin-bottom: 8px;
        }
        .subtitle {
          font-size: 18px;
          color: #666;
          margin-bottom: 20px;
        }
        .template-preview {
          background: #f8f9fa;
          border: 2px dashed #dee2e6;
          border-radius: 12px;
          padding: 30px;
          text-align: center;
          margin-bottom: 30px;
        }
        .template-title {
          font-size: 20px;
          font-weight: 600;
          color: #495057;
          margin-bottom: 10px;
        }
        .template-description {
          color: #6c757d;
          margin-bottom: 20px;
        }
        .template-features {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 20px;
          text-align: left;
        }
        .feature {
          display: flex;
          align-items: center;
          font-size: 14px;
          color: #495057;
        }
        .feature::before {
          content: "✅";
          margin-right: 8px;
        }
        .setup-form {
          background: #fff;
          border: 1px solid #e9ecef;
          border-radius: 12px;
          padding: 30px;
        }
        .form-group {
          margin-bottom: 20px;
        }
        .label {
          display: block;
          font-weight: 600;
          color: #495057;
          margin-bottom: 8px;
        }
        .input {
          width: 100%;
          padding: 12px 16px;
          border: 2px solid #e9ecef;
          border-radius: 8px;
          font-size: 16px;
          transition: border-color 0.2s;
        }
        .input:focus {
          outline: none;
          border-color: #667eea;
        }
        .help-text {
          font-size: 14px;
          color: #6c757d;
          margin-top: 4px;
        }
        .setup-button {
          width: 100%;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          padding: 16px 24px;
          border-radius: 8px;
          font-size: 18px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s;
        }
        .setup-button:hover {
          transform: translateY(-2px);
        }
        .setup-button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
        .error {
          background: #f8d7da;
          color: #721c24;
          padding: 12px;
          border-radius: 8px;
          margin-bottom: 20px;
          display: none;
        }
        .steps {
          margin-top: 30px;
          padding-top: 20px;
          border-top: 1px solid #e9ecef;
        }
        .steps-title {
          font-weight: 600;
          color: #495057;
          margin-bottom: 15px;
        }
        .step {
          display: flex;
          align-items: center;
          margin-bottom: 10px;
          font-size: 14px;
          color: #6c757d;
        }
        .step-number {
          background: #667eea;
          color: white;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          margin-right: 12px;
          font-size: 12px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 class="title">🎯 NotionSync</h1>
          <p class="subtitle">Automatically sync your Shopify orders to a beautiful Notion database</p>
        </div>

        <div class="template-preview">
          <h3 class="template-title">📊 Your Personal Order Tracking Database</h3>
          <p class="template-description">We'll create a custom Notion database just for you with all the fields you need</p>
          
          <div class="template-features">
            <div class="feature">Customer Details</div>
            <div class="feature">Order Information</div>
            <div class="feature">Shipping Address</div>
            <div class="feature">Order Status</div>
            <div class="feature">Total Price</div>
            <div class="feature">Items Purchased</div>
            <div class="feature">Shopify Admin Link</div>
            <div class="feature">Custom Notes Field</div>
          </div>
        </div>

        <div class="setup-form">
          <div class="error" id="errorMessage"></div>
          
          <div class="form-group">
            <label class="label" for="shopName">Your Shopify Store Name</label>
            <input 
              type="text" 
              id="shopName" 
              class="input" 
              placeholder="e.g., mystore (without .myshopify.com)"
              required
            />
            <div class="help-text">Enter just your store name, we'll handle the rest</div>
          </div>

                     <button class="setup-button" id="setupButton">
             🚀 Connect Store & Create Database
           </button>

          <div class="steps">
            <div class="steps-title">What happens next:</div>
            <div class="step">
              <div class="step-number">1</div>
              <div>Connect to your Shopify store (secure OAuth)</div>
            </div>
            <div class="step">
              <div class="step-number">2</div>
              <div>Connect to your Notion workspace</div>
            </div>
            <div class="step">
              <div class="step-number">3</div>
              <div>Create your personal order tracking database</div>
            </div>
            <div class="step">
              <div class="step-number">4</div>
              <div>Set up automatic order syncing</div>
            </div>
          </div>
        </div>
      </div>

      <script>
        function showError(message) {
          const errorDiv = document.getElementById('errorMessage');
          errorDiv.textContent = message;
          errorDiv.style.display = 'block';
        }

        function hideError() {
          const errorDiv = document.getElementById('errorMessage');
          errorDiv.style.display = 'none';
        }

        function startSetup() {
          hideError();
          
          const shopName = document.getElementById('shopName').value.trim();
          const setupButton = document.getElementById('setupButton');
          
          if (!shopName) {
            showError('Please enter your Shopify store name');
            return;
          }

          // Clean shop name (remove .myshopify.com if present)
          const cleanShopName = shopName.replace('.myshopify.com', '').toLowerCase();
          
          // Validate shop name format
          if (!/^[a-z0-9-]+$/.test(cleanShopName)) {
            showError('Store name can only contain letters, numbers, and hyphens');
            return;
          }

          // Update button state
          setupButton.textContent = '⏳ Starting setup...';
          setupButton.disabled = true;

          // Start the OAuth flow with a special parameter to indicate this is from setup
          const setupUrl = '/auth?shop=' + cleanShopName + '&source=setup';
          
          // Redirect to OAuth flow
          window.location.href = setupUrl;
        }

                 // Add event listeners
         document.getElementById('setupButton').addEventListener('click', startSetup);
         
         // Allow Enter key to submit
         document.getElementById('shopName').addEventListener('keypress', function(e) {
           if (e.key === 'Enter') {
             startSetup();
           }
         });
      </script>
    </body>
    </html>
  `);
});

// Health check endpoint
app.get('/health', (req: express.Request, res: express.Response) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Notion Shopify Sync Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`
  });
});

// Redirect to Notion database
app.get('/redirect/notion/:dbId', (req: express.Request, res: express.Response) => {
  const { dbId } = req.params;
  const notionUrl = `https://www.notion.so/${dbId.replace(/-/g, '')}`;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Opening Notion...</title>
      <meta http-equiv="refresh" content="0; url=${notionUrl}">
    </head>
    <body>
      <p>Opening your Notion database...</p>
      <p>If you're not redirected automatically, <a href="${notionUrl}" target="_blank">click here</a>.</p>
      <script>
        window.location.href = '${notionUrl}';
      </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Notion Shopify Sync Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhooks/orders`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app; 