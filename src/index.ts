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

// Force deployment refresh - auth routes fix
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
app.use('/webhooks/orders', bodyParser.raw({ type: 'application/json' }));

// JSON body parser for n8n webhooks
app.use('/webhooks/n8n-orders', bodyParser.json());
app.use('/webhooks/debug-n8n', bodyParser.json());

// JSON body parser for other routes
app.use(bodyParser.json());

// Serve static files for embedded app
app.use('/static', express.static(path.join(__dirname, '../public')));

// Routes
app.use('/auth', authRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/notion', notionRoutes);
app.use('/config', configRoutes);

// Serve embedded app
app.get('/app', (req: express.Request, res: express.Response) => {
  const { shop } = req.query;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>NotionShopifySync</title>
        <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                margin: 0;
                padding: 40px;
                background: #f8f9fa;
            }
            .container {
                max-width: 600px;
                margin: 0 auto;
                background: white;
                padding: 40px;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                text-align: center;
            }
            .status {
                padding: 20px;
                border-radius: 8px;
                margin: 20px 0;
                font-size: 18px;
                font-weight: 600;
            }
            .status.loading {
                background: #e2e8f0;
                color: #4a5568;
            }
            .status.connected {
                background: #c6f6d5;
                color: #22543d;
            }
            .status.disconnected {
                background: #fed7d7;
                color: #742a2a;
            }
            .setup-btn {
                background: #3182ce;
                color: white;
                padding: 15px 30px;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                text-decoration: none;
                display: inline-block;
                margin: 20px 0;
            }
            .setup-btn:hover {
                background: #2c5aa0;
            }
            .setup-btn:disabled {
                background: #a0aec0;
                cursor: not-allowed;
            }
            .info {
                background: #ebf8ff;
                border: 1px solid #bee3f8;
                border-radius: 8px;
                padding: 20px;
                margin: 20px 0;
                text-align: left;
            }
            .success-icon { font-size: 48px; margin-bottom: 20px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>NotionShopifySync</h1>
            <div id="status" class="status loading">
                🔄 Checking connection status...
            </div>
            <div id="content"></div>
        </div>

        <script>
            const shop = '${shop}';
            
            async function checkStatus() {
                try {
                    const response = await fetch(\`/auth/status?shop=\${shop}\`);
                    const data = await response.json();
                    
                    const statusDiv = document.getElementById('status');
                    const contentDiv = document.getElementById('content');
                    
                    if (data.connected) {
                        statusDiv.className = 'status connected';
                        statusDiv.innerHTML = '✅ Connected to Notion';
                        
                        contentDiv.innerHTML = \`
                            <div class="success-icon">🎉</div>
                            <h2>Setup Complete!</h2>
                            <p>Your Shopify orders will now automatically sync to your personal Notion database.</p>
                            <div class="info">
                                <strong>Database ID:</strong> \${data.data.notionDbId}<br>
                                <strong>User Email:</strong> \${data.data.email}
                            </div>
                            <p><small>Orders will appear in your Notion database within seconds of being created.</small></p>
                        \`;
                    } else {
                        statusDiv.className = 'status disconnected';
                        statusDiv.innerHTML = '❌ Not connected to Notion';
                        
                        if (data.step === 'install_app') {
                            contentDiv.innerHTML = \`
                                <h2>Welcome to NotionShopifySync!</h2>
                                <p>Click the button below to start the setup process.</p>
                                <a href="/auth?shop=\${shop}" class="setup-btn">Start Setup</a>
                            \`;
                        } else {
                            contentDiv.innerHTML = \`
                                <h2>Setup in Progress</h2>
                                <p>The app is installed but Notion connection is incomplete.</p>
                                <a href="/auth?shop=\${shop}" class="setup-btn">Complete Setup</a>
                            \`;
                        }
                    }
                } catch (error) {
                    console.error('Status check failed:', error);
                    document.getElementById('status').innerHTML = '❌ Error checking status';
                }
            }
            
            // Check status on load
            checkStatus();
            
            // Refresh status every 5 seconds during setup
            setInterval(() => {
                const statusDiv = document.getElementById('status');
                if (!statusDiv.classList.contains('connected')) {
                    checkStatus();
                }
            }, 5000);
        </script>
    </body>
    </html>
  `;

  res.send(html);
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

// 404 handler
app.use('*', (req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Notion Shopify Sync Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhooks/orders`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app; 