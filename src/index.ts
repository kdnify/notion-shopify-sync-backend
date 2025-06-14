import express from 'express';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhooks';
import authRoutes from './routes/auth';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());

// Body parser middleware - Raw for webhook verification
app.use('/webhooks', bodyParser.raw({ type: 'application/json' }));

// JSON body parser for other routes
app.use(bodyParser.json());

// Routes
app.use('/auth', authRoutes);
app.use('/webhooks', webhookRoutes);

// Welcome page
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
          <li><a href="/auth/install">📦 Install App</a></li>
        </ul>
        <h3>📋 Integration Status:</h3>
        <p>✅ Server Running<br/>
        ✅ Notion Integration Ready<br/>
        ✅ Webhook Endpoint Active<br/>
        ✅ OAuth Flow Configured</p>
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Notion Shopify Sync Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhooks/orders`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app; 