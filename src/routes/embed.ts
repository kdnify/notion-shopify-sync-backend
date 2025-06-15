import { Router, Request, Response } from 'express';
import { userStoreService } from '../services/userStore';

const router = Router();

/**
 * GET /embed/app
 * Serves the embedded Shopify app interface
 */
router.get('/app', async (req: Request, res: Response) => {
  try {
    const { shop } = req.query;

    if (!shop || typeof shop !== 'string') {
      return res.status(400).json({
        error: 'Missing shop parameter'
      });
    }

    const shopName = shop.replace('.myshopify.com', '');

    // Generate the embedded app HTML
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NotionSync - Dashboard</title>
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
            text-align: center;
            margin-bottom: 32px;
        }
        .status-card {
            border: 1px solid #e1e3e5;
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .success { border-color: #36b37e; background-color: #e3fcef; }
        .info { border-color: #00a3bf; background-color: #e6f7ff; }
        .btn {
            background: #5c6ac4;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 4px;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            margin: 8px 0;
        }
        .btn:hover { background: #4c5bd4; }
        .btn-secondary {
            background: #637381;
            color: white;
        }
        .btn-secondary:hover { background: #546e7a; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔄 NotionSync Dashboard</h1>
            <p>Sync your Shopify orders to Notion automatically</p>
        </div>

        <div id="databaseInfo" style="display: none;">
            <div class="status-card success">
                <h3>✅ Personal Notion Database Connected</h3>
                <p>Your Shopify orders will automatically sync to your personal Notion database.</p>
                <p id="databaseUrl">Database ID: Loading...</p>
                <button class="btn" onclick="openUserDatabase()">Open My Dashboard</button>  
            </div>
        </div>

        <div id="manualSetup" style="display: none;">
            <div class="status-card info">
                <h3>📋 Setup Required</h3>
                <p>Connect your Notion account to get started with automatic order syncing.</p>
                <a href="/auth/notion-connect?shop=${shop}" class="btn">Connect Notion Account</a>
            </div>
        </div>

        <div class="status-card">
            <h3>📊 How It Works</h3>
            <ol>
                <li>Connect your personal Notion account</li>
                <li>A private database is created in your workspace</li>
                <li>New orders automatically appear in your Notion</li>
                <li>You have full control over your data</li>
            </ol>
        </div>
    </div>

    <script>
        const app = createApp({
            apiKey: 'your-api-key',
            shop: '${shop}'
        });

        let currentNotionDbId = null;

        // Initialize the app when page loads
        async function initializeApp() {
          try {
            const response = await fetch('/auth/user-info?shop=${shop}');
            if (response.ok) {
              const userInfo = await response.json();
              console.log('User info loaded:', userInfo);
              
              if (userInfo.success && userInfo.data && userInfo.data.notionDbId) {
                currentNotionDbId = userInfo.data.notionDbId;
                console.log('Personal database found:', currentNotionDbId);
                showDatabaseInfo(userInfo.data.notionDbId);
              } else {
                console.log('No personal database found, showing manual setup');
                showManualSetup();
              }
            } else {
              console.log('Could not load user info, showing manual setup');
              showManualSetup();
            }
          } catch (error) {
            console.log('Error loading user info:', error);
            showManualSetup();
          }
        }

        function showDatabaseInfo(dbId) {
          const databaseInfo = document.getElementById('databaseInfo');
          const manualSetup = document.getElementById('manualSetup');
          const databaseUrl = document.getElementById('databaseUrl');
          
          if (databaseInfo && manualSetup) {
            databaseInfo.style.display = 'block';
            manualSetup.style.display = 'none';
            
            // Set the database URL hint
            if (databaseUrl) {
              databaseUrl.textContent = 'Database ID: ' + dbId.substring(0, 8) + '...';
            }
          }
        }

        function showManualSetup() {
          const databaseInfo = document.getElementById('databaseInfo');
          const manualSetup = document.getElementById('manualSetup');
          
          if (databaseInfo && manualSetup) {
            databaseInfo.style.display = 'none';
            manualSetup.style.display = 'block';
          }
        }

        function openUserDatabase() {
          if (currentNotionDbId) {
            // Use our redirect endpoint to avoid iframe CSP issues
            const redirectUrl = '/redirect/notion/' + currentNotionDbId;
            window.location.href = redirectUrl;
          } else {
            alert('No personal database found. Please set up Notion integration.');
          }
        }

        // Initialize when page loads
        document.addEventListener('DOMContentLoaded', initializeApp);
    </script>
</body>
</html>
    `;

    res.send(html);

  } catch (error) {
    console.error('❌ Error serving embedded app:', error);
    res.status(500).json({
      error: 'Failed to load embedded app',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /embed/user-info
 * Get user information for embedded app
 */
router.get('/user-info', async (req: Request, res: Response) => {
  try {
    const { shop } = req.query;

    if (!shop || typeof shop !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing shop parameter'
      });
    }

    const shopName = shop.replace('.myshopify.com', '');
    
    // Find user by store
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    
    if (usersWithStore.length === 0) {
      return res.json({
        success: false,
        message: 'No user found for this store'
      });
    }

    const { user } = usersWithStore[0]; // Get first user for this store
    
    res.json({
      success: true,
      data: {
        userId: user.id,
        email: user.email,
        notionDbId: user.notionDbId,
        storeCount: usersWithStore.length
      }
    });

  } catch (error) {
    console.error('❌ Error getting user info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user info',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router; 